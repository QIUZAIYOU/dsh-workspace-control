/**
 * Host half of dsh-workspace-control.
 *
 * Moves one stored session to another working directory (that is: another
 * workspace) without losing its history, and rebinds the workspace registry.
 *
 * Why this is not a byte-level rewrite: the JSONL backend stores one checksummed
 * Zstandard frame for the header plus one frame per committed batch. Rewriting
 * the header frame in place would rewrite committed history and is refused by
 * the format ("Committed events are never rewritten"). Instead we read the
 * committed events through the persistence seam and materialize a *successor*
 * artifact through the same seam: `create({ ...header, cwd })` + `append(events)`
 * + `flush()`. The backend then writes a correct header frame, correct framing,
 * and the current format version, with no hand-rolled Zstandard work.
 *
 * The move is a small transaction. The source directory is *parked* (renamed)
 * instead of deleted, then the successor is published, read back and compared
 * against what was read, and only then is the parked copy removed. Any failure
 * discards the successor and renames the parked copy back, so the store never
 * holds two artifacts for one id and never holds none.
 */

import {
  access,
  appendFile,
  constants,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat as fsStat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'dsh-workspace-control';
const NAMESPACE = 'workspaceControl';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
// `WSC_LOG_PATH` lets a test run keep its noise out of the installed plugin's
// log while the default stays next to the sources.
const LOG_PATH = process.env.WSC_LOG_PATH || join(PACKAGE_DIR, '.workspace-control.log');
const PENDING_PATH =
  process.env.WSC_PENDING_PATH || join(PACKAGE_DIR, '.workspace-control-pending.json');

/** Diagnostics are append-only, so the file is capped and rolled over instead of
 * growing for the lifetime of the installation. */
const LOG_LIMIT_BYTES = 512 * 1024;
const LOG_CHECK_EVERY = 200;

/** Suffix of a parked session directory. It is not part of the store layout, so
 * a leftover copy is inert and a failed publish can always be renamed back. */
const PARK_MARK = '.workspace-control-parked-';

/** Delay before the membership self-heal runs: the registry has rebuilt its
 * canonical-cwd index by then, which is what refused the attach last run. */
const RESUME_DELAY_MS = 600;
const RESUME_RETRY_MS = 1500;
const RESUME_RETRIES = 12;

/** How long the host gets to drop a released agent's write handle. */
const RELEASE_SETTLE_MS = 120;

/** How long a restart waits before it takes the process down, so the Remote can
 * answer first and the window gets its reply. */
const RESTART_DELAY_MS = 600;

/** How many blocked sessions a workspace row reports before truncating. */
const MAX_BLOCKERS = 12;

/** Windows compares paths case-insensitively; Linux does not. macOS is usually
 * insensitive but can be formatted otherwise, so it keeps the strict compare. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32';

/** Set when `apply` threw half-way. Every public method then reports `not-ready`
 * instead of pretending to be healthy. */
let degradedReason = null;

/* --------------------------------------------------------------- diagnostics */

const safeJson = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return '"<unserializable>"';
  }
};

let logWrites = 0;

/** Append-only breadcrumb next to this package. Diagnostics are a courtesy and
 * never throw into the caller; the move is the job. */
const debug = (event, data) => {
  const line = `${new Date().toISOString()} ${event} ${safeJson(data)}\n`;
  appendFile(LOG_PATH, line, 'utf8').catch(() => {});
  logWrites += 1;
  if (logWrites % LOG_CHECK_EVERY === 0) {
    // Roll over past the limit; a lost breadcrumb is better than an unbounded file.
    fsStat(LOG_PATH)
      .then((info) => {
        if (info.size <= LOG_LIMIT_BYTES) return undefined;
        return rename(LOG_PATH, `${LOG_PATH}.1`).catch(() => rm(LOG_PATH, { force: true }));
      })
      .catch(() => {});
  }
};

/* ------------------------------------------------------------------ pending */

/** Memberships a previous run could not settle. The canonical-cwd index is
 * rebuilt at startup, so the same attach that was refused last run succeeds
 * then; the file is the reminder of what still has to be done. */
const readPending = async () => {
  try {
    const raw = await readFile(PENDING_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (entry.kind === 'rebuild' || entry.kind === 'merge') {
        return typeof entry.workspaceId === 'string';
      }
      return typeof entry.sessionId === 'string' && typeof entry.target === 'string';
    });
  } catch {
    return [];
  }
};

const writePending = async (entries) => {
  try {
    if (entries.length === 0) {
      await rm(PENDING_PATH, { force: true });
      return;
    }
    await writeFile(PENDING_PATH, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  } catch (error) {
    debug('pending-write-failed', error instanceof Error ? error.message : String(error));
  }
};

/* ------------------------------------------------------------------ contract */

const codec = (name, parse) => ({
  mode: 'strict',
  typeSymbol: `${PACKAGE}#${name}`,
  create: () => ({ parse }),
});

const jsonValue = (name) => codec(name, (value) => value);

const nonEmptyString = (name) =>
  codec(name, (value) => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('Expected a non-empty string');
    }
    return value.trim();
  });

const sessionIdCodec = nonEmptyString('SessionId');
const targetCodec = nonEmptyString('TargetDirectory');
const workspaceIdCodec = nonEmptyString('WorkspaceId');
const titleCodec = nonEmptyString('WorkspaceTitle');
const booleanCodec = codec('Flag', (value) => {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new Error('Expected a boolean');
  return value;
});
const workspaceIdsCodec = codec('WorkspaceIdList', (value) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Expected a non-empty array of workspace ids');
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error('Expected every workspace id to be a non-empty string');
    }
    return entry.trim();
  });
});

function method(name, parameters) {
  return {
    id: `${PACKAGE}#${NAMESPACE}/${name}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method: name,
    invocation: { kind: 'direct' },
    result: jsonValue('WorkspaceControlResult'),
    parameters: parameters.map((parameter) => ({
      name: parameter.wire,
      wire: parameter.wire,
      source: 'json',
      codec: parameter.codec,
    })),
  };
}

/** The one authoritative descriptor list. `client.js` carries a copy because the
 * Module Loader hands the browser a single file; `npm test` compares the two, so
 * a drift fails the build instead of the `$mount` at runtime. */
export const DESCRIPTORS = Object.freeze([
  method('inspect', [{ wire: 'sessionId', codec: sessionIdCodec }]),
  method('move', [
    { wire: 'sessionId', codec: sessionIdCodec },
    { wire: 'target', codec: targetCodec },
  ]),
  method('listWorkspaces', []),
  method('rebuildWorkspace', [
    { wire: 'workspaceId', codec: workspaceIdCodec },
    { wire: 'target', codec: targetCodec },
  ]),
  method('mergeWorkspaces', [
    { wire: 'workspaceId', codec: workspaceIdCodec },
    { wire: 'sourceIds', codec: workspaceIdsCodec },
  ]),
  method('retitleWorkspace', [
    { wire: 'workspaceId', codec: workspaceIdCodec },
    { wire: 'title', codec: titleCodec },
  ]),
  method('removeWorkspace', [
    { wire: 'workspaceId', codec: workspaceIdCodec },
    { wire: 'keepSessions', codec: booleanCodec },
  ]),
  method('probeAgent', [{ wire: 'sessionId', codec: sessionIdCodec }]),
  method('releaseSession', [{ wire: 'sessionId', codec: sessionIdCodec }]),
  method('probeRestart', []),
  method('clientModule', []),
  method('restart', [{ wire: 'force', codec: booleanCodec }]),
]);

/* -------------------------------------------------------------- path helpers */

/**
 * Whether two paths name the same place.
 *
 * Case is folded only where the filesystem does it too: on Linux `/proj/A` and
 * `/proj/a` are two directories, and treating them as one would let "move to
 * the target I am already in" run on a real move.
 */
const pathKey = (path) => {
  const resolved = resolvePath(path);
  return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
};

const samePath = (left, right) => pathKey(left) === pathKey(right);

/** The backend escapes a session id to one safe path segment. Ids are already
 * safe, but keep the mapping in case an id ever carries an unusual character. */
const encodeId = (id) =>
  id.replace(/[^A-Za-z0-9._-]/g, (character) =>
    `~${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  );

/** Default session root for this deployment: `$DSH_HOME/sessions`. */
async function sessionRoots() {
  const candidates = [];
  const home = process.env.DSH_HOME;
  if (home) candidates.push(join(home, 'sessions'));
  try {
    candidates.push(join(homedir(), '.dsh', 'sessions'));
  } catch {
    /* homedir can throw in exotic environments; the env candidate still runs */
  }
  const existing = [];
  for (const candidate of candidates) {
    try {
      if ((await fsStat(candidate)).isDirectory()) existing.push(candidate);
    } catch {
      /* not this candidate */
    }
  }
  return existing;
}

const looksLikeLog = (value) =>
  typeof value === 'string' && /\.jsonl(\.zstd)?$/i.test(value);

/**
 * Locate the stored artifact for `id`.
 *
 * The persistence snapshot carries no path, so the layout is the only source of
 * truth: `<root>/--<cwd>--/<encoded-id>/session*.jsonl(.zstd)`. The directory is
 * matched by the escaped id, which is unique per session, and the caller
 * re-reads the header before acting on the answer.
 */
async function locateArtifact(persistence, id) {
  const encoded = encodeId(id);
  for (const root of await sessionRoots()) {
    let projects;
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const directory = join(root, project.name, encoded);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && looksLikeLog(entry.name)) return join(directory, entry.name);
      }
    }
  }
  return null;
}

/** Drop one directory tree and, when it empties, its project directory too. */
async function removeDirectory(directory) {
  const project = dirname(directory);
  await rm(directory, { recursive: true, force: true });
  try {
    const rest = await readdir(project);
    if (rest.length === 0) await rmdir(project);
  } catch {
    /* leaving an empty project directory behind is harmless */
  }
}

/** The last segment of a path, in either separator style. */
function lastSegment(path) {
  if (typeof path !== 'string') return '';
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * Whether a workspace title is just its directory name.
 *
 * `create(path)` derives the title from the last segment, so a title that still
 * equals the old basename was never chosen by the user. Those follow the
 * directory when it changes; a title the user typed is left alone.
 */
function titleFollowsPath(title, path) {
  const segment = lastSegment(path);
  return segment.length > 0 && String(title ?? '').trim().toLowerCase() === segment.toLowerCase();
}

/**
 * Every refusal carries `status: 'error'` plus a stable `code`, so a caller can
 * tell success from failure without knowing the code table.
 */
const failure = (code, message, effectState = 'none', extra) => ({
  status: 'error',
  code,
  message,
  effectState,
  ...(extra && typeof extra === 'object' ? extra : {}),
});

/**
 * Cordis hands a plugin a proxied Context: reading a key it did not inject
 * throws instead of returning undefined. None of the fields below are services
 * (`scope`, `fiber`, `ctx`, `dispose`), so every read is guarded here and an
 * unreachable field simply reads as absent.
 */
const field = (target, key) => {
  if (target === null || target === undefined) return undefined;
  try {
    return target[key];
  } catch {
    return undefined;
  }
};

const describe = (error) =>
  error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();

/* ------------------------------------------------------------------- service */

class WorkspaceControl {
  /** The gateway reads this binding to reach the service behind the namespace. */
  typertRemote = Object.freeze({
    service: this,
    serviceKey: NAMESPACE,
    namespace: NAMESPACE,
  });

  #ctx;
  #busy = new Set();

  constructor(ctx) {
    this.#ctx = ctx;
  }

  /* ------------------------------------------------------------- diagnostics */

  /** Internals this plugin reaches into, reported instead of assumed.
   *
   * `releaseHeld` tears down an agent's Cordis scope and `forgetIndexedHeader`
   * drops one entry from the registry's private index. Neither is a public API,
   * so a harness upgrade can take them away; reporting what is available lets
   * the UI say "degraded" instead of silently refusing every move. */
  #internals() {
    const ctx = this.#ctx;
    const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry;
    const agents = ctx.get?.('agents') ?? ctx.agents;
    const map = registry?.['headers'];
    return {
      registryIndex: Boolean(map && typeof map.delete === 'function' && typeof map.get === 'function'),
      registryPaths: Boolean(registry?.['sessionPaths'] && typeof registry['sessionPaths'].delete === 'function'),
      agentRelease: Boolean(agents && typeof agents.get === 'function'),
    };
  }

  #guard() {
    if (degradedReason === null) return null;
    return failure(
      'not-ready',
      `The plugin did not finish starting (${degradedReason}), so nothing was changed.`,
    );
  }

  async inspect(sessionId) {
    const guard = this.#guard();
    if (guard) return guard;
    const ctx = this.#ctx;
    let snapshot;
    try {
      snapshot = await ctx.sessionPersistence.stat(sessionId);
    } catch (error) {
      const reason = describe(error);
      debug('inspect-stat-failed', { sessionId, reason });
      return failure('unreadable', `The stored session could not be read: ${reason}`);
    }
    if (!snapshot) {
      debug('inspect-no-snapshot', { sessionId });
      return failure('not-found', 'No stored session with that id was found.');
    }
    const header = snapshot.header ?? {};
    const cwd = typeof header.cwd === 'string' ? header.cwd : null;
    let workspace = null;
    if (cwd) {
      try {
        const found = await ctx.workspaceRegistry.resolveByPath(cwd);
        if (found) workspace = { id: found.id, title: found.title, path: found.path };
      } catch {
        /* a missing workspace is not an error here */
      }
    }
    const summaries = await this.#summaries();
    const result = {
      status: 'ok',
      code: 'ok',
      effectState: 'none',
      sessionId,
      cwd,
      workspace,
      // Both flags come from the row the sidebar renders, so this report and the
      // "空闲" pill can never disagree again.
      running: this.#runningOf(summaries, sessionId),
      open: this.#openOf(summaries, sessionId),
      live: Boolean(ctx.agents?.get?.(sessionId)),
      formatStatus: snapshot?.formatStatus ?? null,
      internals: this.#internals(),
    };
    debug('inspect-result', result);
    return result;
  }

  /**
   * The app's own per-session state, keyed by session id.
   *
   * `SessionSummary` is the row the sidebar renders, and it carries the two
   * flags this plugin must not re-derive: `running` (a turn is in flight) and
   * `agentAvailable` (the app holds the session). Guessing those from
   * `ctx.agents.get()` and from a raw turn boundary disagreed with the UI, so
   * every check now reads them from the same service the sidebar uses.
   */
  async #summaries() {
    const controller = this.#ctx.get?.('sessionController');
    if (!controller || typeof controller.list !== 'function') return null;
    try {
      const value = await controller.list({}, new AbortController().signal);
      const items = Array.isArray(value?.items) ? value.items : [];
      return new Map(items.map((item) => [String(item.sessionId), item]));
    } catch (error) {
      debug('summary-failed', { error: describe(error) });
      return null;
    }
  }

  /**
   * Whether a turn is really in flight, per the app's own summary row.
   *
   * Without that row this returns `false`: a turn cannot be in flight for a
   * session the app does not hold, and a held session is refused later by
   * `#openOf`. Guessing from the log made idle sessions look busy, which is the
   * bug this replaced.
   */
  #runningOf(summaries, sessionId) {
    const row = summaries?.get(String(sessionId));
    return row && typeof row.running === 'boolean' ? row.running : false;
  }

  /**
   * Whether the app holds this session, which is what blocks `create`.
   *
   * A held session keeps its log in memory, so the store owns that id and
   * `create` refuses to publish a successor for it. That is a hard limit of the
   * publication API, not a policy choice, so callers must see it up front.
   */
  #openOf(summaries, sessionId) {
    const row = summaries?.get(String(sessionId));
    if (row && typeof row.agentAvailable === 'boolean') return row.agentAvailable;
    try {
      return Boolean(this.#ctx.agents?.get?.(sessionId));
    } catch {
      return false;
    }
  }

  /**
   * Something DSH does not expose: asking a live agent to go away.
   *
   * The store refuses to re-publish a session whose log the host still holds, and
   * the host only releases that writer when the agent owning it is disposed. The
   * public agent surface (`agents.get`) returns `{ id }` only, so the teardown has
   * to reach the agent's own Cordis scope.
   *
   * Two guard rails: the root scope is never disposed (that would unload the
   * host), and a scope that another live agent shares is never disposed either
   * (that would unload that agent too). Only when the scope belongs to this one
   * agent does the teardown touch it; otherwise the step is skipped and the
   * caller sees `released: false`.
   */
  async #releaseHeld(sessionId) {
    const agents = this.#ctx.agents;
    if (!agents || typeof agents.get !== 'function') return { released: false, via: 'no-agents' };
    const agent = agents.get(sessionId);
    if (agent === undefined) return { released: true, via: 'absent' };

    // Nothing here disposes the agent. The registry entry is owned by the agent
    // factory's composite teardown, and the only handle to that teardown is the
    // `AgentHandle` the factory kept; a third-party plugin sees `{ id }` and, at
    // most, undocumented internals. Disposing an internals fiber was measured to
    // leave the registry entry in place, i.e. a zombie agent whose handle is
    // already gone — strictly worse than refusing. So this method reports the
    // hold and lets the caller explain it.
    debug('release-refused', { sessionId, held: true });
    return { released: false, via: 'held-by-app', stillLive: true };
  }

  /** Whether another live agent shares this scope, in which case disposing it
   * would unload that agent as well. */
  #scopeIsShared(scope, agent) {
    if (!scope) return false;
    const agents = this.#ctx.agents;
    if (!agents || typeof agents.list !== 'function') return false;
    try {
      for (const other of agents.list()) {
        if (!other || other === agent) continue;
        if (field(field(other, 'ctx'), 'scope') === scope) return true;
      }
    } catch {
      // Reading another agent's ctx is as unsupported as disposing it; treat an
      // unreadable peer set as "shared" so the scope is left alone.
      return true;
    }
    return false;
  }

  /** Diagnostic only: release one idle session so its log is no longer held. */
  async releaseSession(sessionId) {
    const guard = this.#guard();
    if (guard) return guard;
    const summaries = await this.#summaries();
    if (this.#runningOf(summaries, sessionId)) {
      return failure('running', 'A turn is in flight for this session; wait for it to finish, then try again.');
    }
    const released = await this.#releaseHeld(sessionId);
    if (released.released) {
      return {
        status: 'released',
        code: 'released',
        effectState: 'applied',
        message: 'The app no longer holds this session.',
        sessionId,
        via: released.via,
      };
    }
    return failure(
      'session-open',
      'The app still holds this session: a session is released only when the harness exits, so a session you have opened cannot be re-published. Open a different session first (or restart DSH and open another one), then move it.',
    );
  }

  /** Diagnostic only: describe the live agent object without touching it. */
  async probeAgent(sessionId) {
    const agents = this.#ctx.agents;
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    if (agent === undefined) return { status: 'none', sessionId, internals: this.#internals() };
    let keys = null;
    try {
      keys = Object.keys(agent);
    } catch (error) {
      keys = describe(error);
    }
    const agentCtx = field(agent, 'ctx');
    const agentScope = field(agentCtx, 'scope');
    const rootScope = field(this.#ctx, 'scope');
    return {
      status: 'live',
      sessionId,
      keys,
      hasCtx: agentCtx !== undefined,
      sameScope: Boolean(agentCtx && agentScope === rootScope),
      sharedScope: this.#scopeIsShared(agentScope, agent),
      fiberDispose: typeof field(field(agentCtx, 'fiber'), 'dispose'),
      scopeDispose: typeof field(agentScope, 'dispose'),
      agentDispose: typeof field(agent, 'dispose'),
      internals: this.#internals(),
    };
  }

  move(sessionId, target) {
    const guard = this.#guard();
    if (guard) return Promise.resolve(guard);
    debug('move-entry', { sessionId, target });
    if (this.#busy.has(sessionId)) {
      return Promise.resolve(failure('busy', 'Another move for this session is still running.'));
    }
    this.#busy.add(sessionId);
    return this.#move(sessionId, target).finally(() => this.#busy.delete(sessionId));
  }

  /* ------------------------------------------------------------- relaunching */

  /**
   * How this process could restart the app, if at all.
   *
   * The desktop build runs this host as an Electron *child* process, so the
   * window belongs to the parent and there is no API across that boundary: a
   * plugin loaded into Electron's main process (a browser build) gets the
   * documented `app.relaunch()` path instead, and everything else is refused
   * rather than guessed at.
   */
  async #relauncher() {
    if (process.versions.electron !== undefined && process.type === 'browser') {
      try {
        const electron = await import('electron');
        const app = electron?.app ?? electron?.default?.app;
        if (app && typeof app.relaunch === 'function' && typeof app.exit === 'function') {
          return { supported: true, kind: 'electron', app };
        }
      } catch (error) {
        debug('relaunch-electron-failed', { error: describe(error) });
      }
    }

    if (process.platform === 'win32' && /^deepseek/i.test(basename(process.execPath))) {
      return { supported: true, kind: 'desktop-script', exe: process.execPath, parent: process.ppid };
    }

    return {
      supported: false,
      reason: process.versions.electron === undefined ? 'not-electron' : 'no-loopback',
    };
  }

  /**
   * The detached script that restarts the desktop app.
   *
   * It has to outlive the tree it is about to terminate, so it kills by image
   * name and by pid, waits for the port to be free, then starts the executable
   * again and deletes itself.
   */
  /**
   * The helper is `cmd`, not PowerShell: it starts in tens of milliseconds where
   * `powershell.exe` needs most of a second, and it runs after the app is gone.
   * `timeout` needs a console the helper does not have, so the waits are `ping`,
   * and `tasklist` is the poll because it is a native binary.
   */
  async #desktopRestartScript(exe, parentPid) {
    const script = join(tmpdir(), `dsh-restart-${process.pid}.cmd`);
    const image = basename(exe);
    const self = process.pid;
    const lines = [
      '@echo off',
      'rem Written by dsh-workspace-control: restart the desktop app.',
      'rem Let the Remote answer reach the browser before this process tree dies.',
      'rem `ping` against TEST-NET is the sleep: `timeout` needs a console here.',
      'ping -n 1 -w 250 192.0.2.1 >nul',
      `taskkill /IM "${image}" /F >nul 2>&1`,
      `taskkill /PID ${parentPid} /T /F >nul 2>&1`,
      'rem Wait for the process that owns the listening socket, not for stragglers.',
      'set rounds=0',
      ':wait',
      `tasklist /FI "PID eq ${self}" 2>nul | find /I "${self}" >nul || goto ready`,
      'set /a rounds+=1',
      'if %rounds% geq 24 goto giveup',
      'ping -n 2 -w 100 192.0.2.1 >nul',
      'goto wait',
      'rem Never start a second instance over one that refused to die.',
      ':giveup',
      'del "%~f0" >nul 2>&1',
      'exit /b 1',
      ':ready',
      `start "" "${exe}"`,
      'del "%~f0" >nul 2>&1',
    ];
    await writeFile(script, `${lines.join('\r\n')}\r\n`, 'utf8');
    return script;
  }

  /**
   * Start a detached helper without a window and without inheriting this job.
   *
   * A plain child would be killed together with the app it is about to restart,
   * so the helper is created through the WMI provider (`Win32_Process.Create`),
   * which owns it instead. The launcher itself runs hidden and exits at once.
   */
  /**
   * Ask WMI to start the helper.
   *
   * A plain child is cheaper but dies with this process tree, so the helper is
   * created by WmiPrvSE instead. `cscript` issues that call in ~100 ms where
   * PowerShell needs ~1.2 s of start-up, and `ShowWindow = 0` keeps the helper
   * invisible; PowerShell remains the fallback when VBScript is unavailable.
   */
  async #launchHidden(script) {
    const launcher = join(tmpdir(), `dsh-restart-${process.pid}.vbs`);
    const inner = `cmd.exe /c ""${script}""`;
    const body = [
      'Option Explicit',
      'Dim wmi, service, startup, result, code',
      'Set wmi = GetObject("winmgmts:\\.\root\cimv2")',
      'Set service = wmi.Get("Win32_Process")',
      'Set startup = wmi.Get("Win32_ProcessStartup").SpawnInstance_',
      'startup.ShowWindow = 0',
      `code = service.Create("${inner.replace(/"/g, '""')}", Null, startup, result)`,
      'WScript.Quit code',
    ].join('\r\n');

    const viaScript = await this.#launchHiddenProcess('cscript.exe', ['//nologo', '//B', launcher], body);
    if (!viaScript.error) return { via: 'cscript', pid: null };
    await rm(launcher, { force: true }).catch(() => {});

    const viaPowerShell = await this.#launchViaPowerShell(script);
    if (!viaPowerShell.error) return { ...viaPowerShell, via: 'powershell' };
    return { error: `${viaScript.error}; the PowerShell fallback also failed: ${viaPowerShell.error}` };
  }

  /** Write `body` to `path` and run `argv` until it exits; exit 0 means WMI ran. */
  #launchHiddenProcess(command, args, body) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const run = async () => {
        const target = args[args.length - 1];
        try {
          await writeFile(target, body, 'utf8');
        } catch (error) {
          return finish({ error: `could not write the launcher: ${describe(error)}` });
        }
        let child;
        try {
          child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        } catch (error) {
          return finish({ error: describe(error) });
        }
        let stderr = '';
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          finish({ error: `${command} timed out` });
        }, 8000);
        child.stderr?.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          finish({ error: describe(error) });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) return finish({ ok: true });
          finish({ error: `${command} exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}` });
        });
      };
      void run();
    });
  }

  /** The WMI call through PowerShell, kept for hosts without usable cscript. */
  async #launchViaPowerShell(script) {
    const inner = ['cmd.exe', '/c', `"${script}"`].join(' ');
    // Single quotes are the only thing that needs escaping inside the WMI call.
    const literal = `'${inner.replace(/'/g, "''")}'`;
    const command = [
      '$ErrorActionPreference = "Stop"',
      `$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${literal} }`,
      'Write-Output ("{0} {1}" -f $created.ReturnValue, $created.ProcessId)',
    ].join('; ');

    return await new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish({ error: 'the WMI launcher timed out' });
      }, 8000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({ error: describe(error) });
      });
      child.on('close', () => {
        clearTimeout(timer);
        const parts = stdout.trim().split(/\s+/);
        const code = Number(parts[0]);
        if (!Number.isFinite(code)) return finish({ error: `unexpected launcher output: ${stdout.trim() || '(none)'}` });
        if (code !== 0) return finish({ error: `Win32_Process.Create returned ${code}` });
        finish({ pid: Number(parts[1]) || null });
      });
    });
  }

  /** Sessions the app reports as mid-turn, which a restart would interrupt. */
  async #runningSessions() {
    const summaries = await this.#summaries();
    if (!summaries) return [];
    return [...summaries.values()]
      .filter((row) => row && row.running === true)
      .map((row) => String(row.sessionId));
  }

  /**
   * Read-only: what the Web boot graph says about this plugin's Client half.
   *
   * `clientModules` composes the entry table the browser receives, so this
   * answers "is the Client bundle part of the boot at all" without a browser
   * console: a missing entry explains an enabled-but-dead plugin exactly.
   */
  async clientModule() {
    const guard = this.#guard();
    if (guard) return guard;
    const modules = field(this.#ctx.get?.('clientModules'), 'graph') !== undefined
      ? this.#ctx.get('clientModules')
      : null;
    const base = {
      status: 'ok',
      code: 'ok',
      effectState: 'none',
      service: modules !== null,
      package: PACKAGE,
    };
    if (modules === null) return { ...base, entries: null, reason: 'clientModules is unavailable' };
    try {
      const graph = typeof modules.graph === 'function' ? modules.graph() : null;
      const entries = Array.isArray(graph?.entries) ? graph.entries : [];
      const mine = entries.find((entry) => entry && entry.id === PACKAGE) ?? null;
      let clientPath = null;
      try {
        clientPath = typeof modules.clientPath === 'function' ? modules.clientPath(PACKAGE) ?? null : null;
      } catch (error) {
        clientPath = `error: ${describe(error)}`;
      }
      let baseline = null;
      try {
        baseline = typeof modules.artifactBaseline === 'function' ? modules.artifactBaseline(PACKAGE) ?? null : null;
      } catch (error) {
        baseline = `error: ${describe(error)}`;
      }
      return {
        ...base,
        rev: typeof graph?.rev === 'string' ? graph.rev : null,
        entries: entries.map((entry) => String(entry && entry.id)),
        mine: mine ? JSON.parse(JSON.stringify(mine)) : null,
        clientPath,
        baseline,
      };
    } catch (error) {
      return { ...base, status: 'error', code: 'unreadable', entries: null, reason: describe(error) };
    }
  }

  /** Read-only: whether this process can restart the app, and what it would do. */
  async probeRestart() {
    const guard = this.#guard();
    if (guard) return guard;
    const launcher = await this.#relauncher();
    const running = await this.#runningSessions();
    const plan = {
      status: 'ok',
      code: 'ok',
      effectState: 'none',
      supported: launcher.supported === true,
      kind: launcher.kind ?? null,
      reason: launcher.supported ? null : launcher.reason ?? null,
      electron: process.versions.electron ?? null,
      processType: process.type ?? null,
      execPath: process.execPath,
      parent: process.ppid,
      running,
      internals: this.#internals(),
    };
    debug('probe-restart', plan);
    return plan;
  }

  /** Restart the app. `force` allows it while a turn is in flight. */
  async restart(force) {
    const guard = this.#guard();
    if (guard) return guard;
    const launcher = await this.#relauncher();
    if (launcher.supported !== true) {
      return failure(
        'restart-unsupported',
        launcher.reason === 'not-electron'
          ? 'This process is a plain Node host, so it cannot restart the app.'
          : 'This build has no supported way to restart the app from a plugin.',
      );
    }

    const running = await this.#runningSessions();
    if (running.length > 0 && force !== true) {
      return {
        ...failure('sessions-running', 'A restart would interrupt a turn in flight.'),
        running,
      };
    }

    if (launcher.kind === 'electron') {
      const timer = setTimeout(() => {
        try {
          launcher.app.relaunch({ args: process.argv.slice(1) });
        } catch (error) {
          debug('restart-relaunch-failed', { error: describe(error) });
        }
        try {
          launcher.app.exit(0);
        } catch {
          process.exit(0);
        }
      }, RESTART_DELAY_MS);
      if (typeof timer.unref === 'function') timer.unref();
      debug('restart-scheduled', { kind: launcher.kind, running: running.length });
      return {
        status: 'restarted',
        code: 'restarted',
        effectState: 'applied',
        message: 'DSH is restarting; the window reopens on its own.',
        forced: force === true,
        interrupted: running,
      };
    }

    let script;
    try {
      script = await this.#desktopRestartScript(launcher.exe, launcher.parent);
    } catch (error) {
      debug('restart-script-failed', { error: describe(error) });
      return failure('restart-failed', `Could not write the restart helper: ${describe(error)}`);
    }
    const launched = await this.#launchHidden(script);
    if (launched.error) {
      debug('restart-spawn-failed', { error: launched.error });
      return failure('restart-failed', `Could not start the restart helper: ${launched.error}`);
    }
    debug('restart-helper-started', { via: launched.via, pid: launched.pid });
    debug('restart-scheduled', { kind: launcher.kind, script, running: running.length });
    return {
      status: 'restarted',
      code: 'restarted',
      effectState: 'applied',
      message: 'DSH is restarting; the window reopens in a few seconds.',
      forced: force === true,
      interrupted: running,
    };
  }

  /* -------------------------------------------------- membership bookkeeping */

  /**
   * Every stored header, grouped by the directory it records.
   *
   * One store scan answers every workspace question: the registry's `sessionIds`
   * is filtered through the startup canonical-cwd index and can under-report,
   * while the headers are the complete membership list.
   */
  async #scan() {
    const snapshots = await this.#ctx.sessionPersistence.list();
    const byPath = new Map();
    for (const snapshot of snapshots) {
      const header = snapshot?.header;
      if (!header || typeof header.id !== 'string') continue;
      if (typeof header.cwd !== 'string') continue;
      const key = pathKey(header.cwd);
      const bucket = byPath.get(key);
      if (bucket) bucket.push(header);
      else byPath.set(key, [header]);
    }
    for (const bucket of byPath.values()) {
      bucket.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
    }
    return byPath;
  }

  #sessionsFor(byPath, path) {
    return byPath.get(pathKey(path)) ?? [];
  }

  /** Sessions whose header records `path` as their directory. */
  async #sessionsUnder(path) {
    return this.#sessionsFor(await this.#scan(), path);
  }

  /** Absolute, existing, writable directory — reported as data, never thrown. */
  async #checkTarget(target) {
    if (typeof target !== 'string' || target.trim() === '' || !isAbsolute(target)) {
      return failure('not-absolute', 'The target must be an absolute path.');
    }
    let info;
    try {
      info = await fsStat(target);
    } catch {
      return failure('missing-target', 'The target directory does not exist.');
    }
    if (!info.isDirectory()) return failure('missing-target', 'The target path is not a directory.');
    try {
      await access(target, constants.W_OK);
    } catch {
      return failure('unwritable', 'The target directory is not writable.');
    }
    return { ok: true, path: resolvePath(target) };
  }

  /** Whether the recorded directory is still there (reported, never thrown). */
  async #dirExists(path) {
    try {
      const info = await fsStat(path);
      return info.isDirectory();
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------- workspace-level operations */

  /**
   * The workspaces a panel can offer, each with the number of stored sessions it
   * really owns and how many of those are not movable right now.
   *
   * One store scan feeds every row, and the directory probes run in parallel:
   * the panel is opened on a click and must not walk the store once per row.
   * Occupancy comes from the sidebar's own `SessionSummary` rows — the same two
   * flags that make a move fail — so a row warns *before* anything is clicked:
   * `running` (a turn is in flight) and `open` (the app holds the log, so the
   * store refuses to publish a successor for it).
   */
  async listWorkspaces() {
    const guard = this.#guard();
    if (guard) return guard;
    let workspaces = [];
    try {
      workspaces = this.#ctx.workspaceRegistry.list();
    } catch (error) {
      return failure('registry-unavailable', `The workspace registry could not be read: ${describe(error)}`);
    }

    let byPath;
    try {
      byPath = await this.#scan();
    } catch (error) {
      return failure('unreadable', `The stored sessions could not be read: ${describe(error)}`);
    }
    const summaries = await this.#summaries();
    const exists = await Promise.all(workspaces.map((workspace) => this.#dirExists(workspace.path)));

    const rows = workspaces.map((workspace, index) => {
      const headers = this.#sessionsFor(byPath, workspace.path);
      const blockers = [];
      for (const header of headers) {
        const id = String(header.id);
        const running = this.#runningOf(summaries, id);
        const open = this.#openOf(summaries, id);
        if (!running && !open) continue;
        const row = summaries?.get(id);
        blockers.push({
          id,
          // `SessionSummary` carries no title, so the UI falls back to the id.
          title: typeof row?.title === 'string' ? row.title : null,
          running,
          open,
        });
      }
      return {
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessions: headers.length,
        exists: exists[index],
        blocked: blockers.length > 0,
        running: blockers.filter((entry) => entry.running).length,
        open: blockers.filter((entry) => entry.open).length,
        blockers: blockers.slice(0, MAX_BLOCKERS),
        blockedTotal: blockers.length,
      };
    });

    return {
      status: 'ok',
      code: 'ok',
      effectState: 'none',
      workspaces: rows,
      internals: this.#internals(),
    };
  }

  /**
   * Point a workspace title back at the name of the directory it lives in.
   *
   * The manager offers this when a stored title no longer matches its folder --
   * the shape a rebuild used to leave behind, when the record was re-created
   * with the title of the directory it had just moved away from. Nothing but
   * the title is touched, so it is safe to call on a live workspace.
   */
  async retitleWorkspace(workspaceId, title) {
    const guard = this.#guard();
    if (guard) return guard;
    const registry = this.#ctx.workspaceRegistry;
    const wanted = typeof title === 'string' ? title.trim() : '';
    if (wanted === '') {
      return failure('invalid-title', 'The new title is empty.');
    }

    let workspace;
    try {
      workspace = await registry.get?.(workspaceId);
    } catch (error) {
      return failure('registry-unavailable', `The workspace registry could not be read: ${describe(error)}`);
    }
    if (!workspace) {
      return failure('not-found', `No workspace with the id "${workspaceId}".`);
    }
    const previous = workspace.title;
    try {
      await workspace.setTitle(wanted);
    } catch (error) {
      return failure('retitle-failed', `The workspace title could not be changed: ${describe(error)}`);
    }

    let current = wanted;
    try {
      const readBack = await registry.get?.(workspaceId);
      current = readBack?.title ?? wanted;
    } catch (error) {
      debug('retitle-readback-failed', describe(error));
    }
    debug('retitle', { workspaceId, previous, wanted, current });
    return {
      status: 'retitled',
      code: 'retitled',
      effectState: 'applied',
      workspaceId,
      previous,
      title: current,
    };
  }

  /**
   * Remove one workspace record.
   *
   * The sidebar entry is the record; the directory and its session files stay on
   * disk, exactly like the shipped "remove workspace" (a workspace can always be
   * added back at the same path). Sessions that are mid-turn or held by the app
   * refuse the whole call first.
   *
   * Archiving and deleting are two separate writes, so the pair is made
   * compensable: if the record cannot be removed, the sessions that were
   * archived on the way are put back instead of disappearing from the sidebar
   * while the workspace stays.
   */
  async removeWorkspace(workspaceId, keepSessions) {
    const guard = this.#guard();
    if (guard) return guard;
    const registry = this.#ctx.workspaceRegistry;
    const keep = keepSessions === true;
    let workspace;
    try {
      workspace = await registry.get?.(workspaceId);
    } catch (error) {
      return failure('registry-unavailable', `The workspace registry could not be read: ${describe(error)}`);
    }
    if (!workspace) return failure('not-found', 'That workspace no longer exists.');

    const summaries = await this.#summaries();
    let headers = [];
    try {
      headers = await this.#sessionsUnder(workspace.path);
    } catch (error) {
      return failure('unreadable', `The stored sessions could not be read: ${describe(error)}`);
    }
    const blocked = headers
      .map((header) => ({
        sessionId: String(header.id),
        running: this.#runningOf(summaries, String(header.id)),
        open: this.#openOf(summaries, String(header.id)),
      }))
      .filter((entry) => entry.running || entry.open);
    if (blocked.length > 0) {
      return failure(
        'sessions-open',
        `${blocked.length} session(s) in this workspace are still held by the app or mid-turn; nothing was removed.`,
      );
    }

    const archived = [];
    const archiveFailed = [];
    if (!keep && typeof registry.archiveSession === 'function') {
      for (const header of headers) {
        const id = String(header.id);
        try {
          await registry.archiveSession(id);
          archived.push(id);
        } catch (error) {
          archiveFailed.push({ sessionId: id, error: describe(error) });
        }
      }
    }

    /** Undo the archiving done above, so a failed removal leaves no trace. */
    const unarchiveAll = async () => {
      if (typeof registry.unarchiveSession !== 'function') return 0;
      let restored = 0;
      for (const id of archived) {
        try {
          await registry.unarchiveSession(id);
          restored += 1;
        } catch {
          /* reported through the count only */
        }
      }
      return restored;
    };

    if (archiveFailed.length > 0) {
      const restored = await unarchiveAll();
      debug('remove-archive-failed', { workspaceId, archiveFailed, restored });
      return {
        ...failure(
          'archive-failed',
          `${archiveFailed.length} session(s) could not be archived, so the workspace was left alone.`,
          restored > 0 ? 'rolled-back' : 'none',
        ),
        archived: archived.length - restored,
        archiveFailed,
      };
    }

    let removed = false;
    try {
      removed = await registry.delete(workspaceId);
    } catch (error) {
      const restored = await unarchiveAll();
      debug('remove-failed', { workspaceId, error: describe(error), restored });
      return {
        ...failure(
          'remove-failed',
          `The workspace record could not be removed: ${describe(error)}`,
          restored > 0 ? 'rolled-back' : 'none',
        ),
        restored,
      };
    }

    debug('remove-result', {
      workspaceId,
      path: workspace.path,
      sessions: headers.length,
      archived: archived.length,
      removed,
    });
    return {
      status: 'removed',
      code: 'removed',
      effectState: 'applied',
      workspaceId,
      title: workspace.title,
      path: workspace.path,
      sessions: headers.length,
      archived: archived.length,
      removed,
    };
  }

  /**
   * Rebuild one workspace at another directory: every session it owns moves
   * there, the workspace record is re-created at the new path with the same
   * title and sidebar position, and the old record is removed.
   *
   * All-or-nothing: every session is checked before the first byte moves, and a
   * failure part-way re-homes the already-moved sessions back.
   */
  async rebuildWorkspace(workspaceId, target) {
    const guard = this.#guard();
    if (guard) return guard;
    const registry = this.#ctx.workspaceRegistry;
    debug('rebuild-entry', { workspaceId, target });
    const workspace = await registry.get(workspaceId);
    if (!workspace) return failure('not-found', 'That workspace no longer exists.');
    const checked = await this.#checkTarget(target);
    if (!checked.ok) return checked;

    if (samePath(workspace.path, checked.path)) {
      // Repeating a rebuild at its own directory is not a no-op: the first run
      // used to re-apply the old title verbatim, so this is where a title that
      // should follow the directory gets fixed.
      const wanted = titleFollowsPath(workspace.title, workspace.path) ? lastSegment(checked.path) : null;
      if (wanted && wanted !== workspace.title && typeof workspace.setTitle === 'function') {
        try {
          await workspace.setTitle(wanted);
          debug('rebuild-retitled', { workspaceId, from: workspace.title, to: wanted });
          return {
            status: 'rebuilt',
            code: 'retitled',
            effectState: 'applied',
            message: 'The workspace title now follows its directory. Refresh to see it.',
            moved: 0,
            sessions: [],
            workspace: { id: workspace.id, title: wanted, path: workspace.path, created: false },
            oldWorkspaceId: workspace.id,
            oldPath: workspace.path,
            newPath: workspace.path,
            retitled: true,
            removed: false,
            positioned: false,
            leftovers: [],
          };
        } catch (error) {
          return failure('retitle-failed', `The title could not be changed: ${describe(error)}`);
        }
      }
      return failure('same-path', "The target already is this workspace's directory.");
    }

    const occupant = await registry.resolveByPath(checked.path);
    if (occupant && occupant.id !== workspace.id) {
      return {
        ...failure(
          'target-is-workspace',
          `"${occupant.title}" already uses that directory. Merge into it instead of rebuilding onto it.`,
        ),
        occupiedBy: { id: occupant.id, title: occupant.title, path: occupant.path },
      };
    }

    // Remember where the workspace sits so the rebuilt one keeps its position
    // instead of jumping to the end of the sidebar.
    const order = (await registry.list()) ?? [];
    const index = order.findIndex((entry) => entry.id === workspace.id);
    const next = index >= 0 && index + 1 < order.length ? order[index + 1] : undefined;

    let headers;
    try {
      headers = await this.#sessionsUnder(workspace.path);
    } catch (error) {
      return failure('unreadable', `The stored sessions could not be listed: ${describe(error)}`);
    }
    const summaries = await this.#summaries();
    const running = headers
      .filter((header) => this.#runningOf(summaries, header.id))
      .map((header) => header.id);
    if (running.length > 0) {
      return {
        ...failure(
          'sessions-running',
          `${running.length} session(s) in this workspace are mid-turn. Wait for them to finish, then rebuild.`,
        ),
        sessions: headers.length,
        running,
      };
    }

    // A held session cannot be re-published, and holding is a property of the
    // app, not of activity: an idle tab blocks the rebuild just like a busy one.
    // Idle holders are released first, so an idle tab no longer blocks anything.
    const open = [];
    for (const header of headers) {
      if (!this.#openOf(summaries, header.id)) continue;
      const release = await this.#releaseHeld(header.id);
      if (release.released) {
        debug('released-before-rebuild', { sessionId: header.id, via: release.via });
        continue;
      }
      open.push(header.id);
    }
    if (open.length > 0) {
      // Nothing public releases a held log, and the hold ends with the process.
      // Queue the whole rebuild so the restart button can finish it.
      const queued = (await readPending()).filter(
        (entry) => !(entry.kind === 'rebuild' && entry.workspaceId === workspace.id),
      );
      queued.push({ kind: 'rebuild', workspaceId: workspace.id, target: checked.path });
      await writePending(queued);
      debug('held-restart-queued', { kind: 'rebuild', workspaceId: workspace.id, target: checked.path });
      return {
        ...failure(
          'held-restart',
          `${open.length} session(s) here are still held by the app, so their logs cannot be re-published now. The rebuild is queued: restart DSH and it finishes during startup.`,
          'none',
          { queued: true, canRestart: true, target: checked.path },
        ),
        sessions: headers.length,
        open,
      };
    }

    // Which workspaces existed before this rebuild started: a rolled-back run
    // must not leave the record it created at the target behind.
    const preExisting = new Set(((await registry.list()) ?? []).map((entry) => entry.id));

    const moved = [];
    let stop = null;
    for (const header of headers) {
      const outcome = await this.#move(header.id, checked.path);
      if (outcome.status === 'moved' || outcome.status === 'attached') {
        moved.push(header.id);
        continue;
      }
      stop = { sessionId: header.id, code: outcome.code ?? outcome.status, message: outcome.message ?? null };
      break;
    }
    if (stop) {
      const rolledBack = [];
      for (const id of [...moved].reverse()) {
        const back = await this.#move(id, workspace.path);
        rolledBack.push({ sessionId: id, code: back.code ?? back.status });
      }
      // The moves that did happen created a workspace at the target; once they
      // are undone it holds nothing, so remove it rather than leaving an empty
      // ghost in the sidebar.
      const cleanedUp = [];
      try {
        for (const entry of registry.list()) {
          if (preExisting.has(entry.id)) continue;
          if (Array.isArray(entry.sessionIds) && entry.sessionIds.length > 0) continue;
          if (await registry.delete(entry.id)) cleanedUp.push({ id: entry.id, title: entry.title });
        }
      } catch (error) {
        debug('rebuild-cleanup-failed', describe(error));
      }
      debug('rebuild-rolled-back', { workspaceId, stop, rolledBack, cleanedUp });
      return {
        ...failure(
          'rebuild-failed',
          `The rebuild stopped at ${stop.sessionId} (${stop.code}); ${rolledBack.length} session(s) were put back.`,
          moved.length === 0 ? 'none' : 'rolled-back',
        ),
        failed: stop,
        rolledBack,
        cleanedUp,
      };
    }

    const created = await registry.resolveByPath(checked.path);
    let retitled = false;
    let removed = false;
    let positioned = false;
    const leftovers = [];
    // A title the user typed is theirs and survives the rebuild; a title that is
    // just the old directory name follows the directory, so "ce" rebuilt into
    // "workspace test" is named "workspace test" instead of keeping "ce".
    const title = titleFollowsPath(workspace.title, workspace.path)
      ? lastSegment(checked.path) || workspace.title
      : workspace.title;
    if (created && title && typeof created.setTitle === 'function') {
      try {
        await created.setTitle(title);
        retitled = true;
      } catch (error) {
        debug('rebuild-retitle-failed', describe(error));
      }
    }
    try {
      const fresh = await registry.get(workspace.id);
      if (fresh && fresh.sessionIds.length === 0) {
        removed = await registry.delete(workspace.id);
      } else if (fresh) {
        leftovers.push(...fresh.sessionIds);
      }
    } catch (error) {
      debug('rebuild-delete-failed', describe(error));
    }
    if (created && next && typeof registry.insertBefore === 'function') {
      try {
        await registry.insertBefore(created.id, next.id);
        positioned = true;
      } catch (error) {
        debug('rebuild-position-failed', describe(error));
      }
    }

    const result = {
      status: 'rebuilt',
      code: 'rebuilt',
      effectState: 'applied',
      moved: moved.length,
      sessions: moved,
      title,
      oldTitle: workspace.title,
      workspace: created ? { id: created.id, title, path: created.path, created: true } : null,
      oldWorkspaceId: workspace.id,
      oldPath: workspace.path,
      newPath: checked.path,
      retitled,
      removed,
      positioned,
      leftovers,
    };
    debug('rebuild-result', {
      workspaceId,
      moved: moved.length,
      title,
      retitled,
      removed,
      positioned,
      leftovers: leftovers.length,
    });
    return result;
  }

  /**
   * Merge other workspaces into this one: every session they own is re-homed
   * into the target directory and re-attached to the target workspace, and the
   * source records are removed once they hold nothing.
   *
   * A merge is additive, so a failure part-way leaves what already moved in a
   * consistent state and reports exactly what stayed behind.
   */
  async mergeWorkspaces(workspaceId, sourceIds) {
    const guard = this.#guard();
    if (guard) return guard;
    const registry = this.#ctx.workspaceRegistry;
    debug('merge-entry', { workspaceId, sourceIds });
    const target = await registry.get(workspaceId);
    if (!target) return failure('not-found', 'That workspace no longer exists.');
    const sources = [];
    for (const id of sourceIds) {
      if (id === workspaceId) continue;
      const workspace = await registry.get(id);
      if (workspace) sources.push(workspace);
    }
    if (sources.length === 0) return failure('no-source', 'No other workspace was selected.');

    let byPath;
    try {
      byPath = await this.#scan();
    } catch (error) {
      return failure('unreadable', `The stored sessions could not be read: ${describe(error)}`);
    }
    const wanted = new Map();
    for (const source of sources) {
      for (const header of this.#sessionsFor(byPath, source.path)) wanted.set(header.id, source.id);
    }

    if (wanted.size === 0) {
      // Nothing to move — but an empty record is exactly what a failed rebuild
      // leaves behind, so merging it away doubles as the cleanup path.
      const { deleted, kept } = await this.#pruneSources(sources);
      if (deleted.length === 0) {
        return {
          ...failure('nothing-to-merge', 'The selected workspaces hold no stored sessions.'),
          deleted,
          kept,
        };
      }
      const cleaned = {
        status: 'merged',
        code: 'merged',
        effectState: 'applied',
        message: 'Those workspaces held no sessions; their empty records were removed.',
        moved: 0,
        sessions: [],
        failed: [],
        deleted,
        kept,
        workspace: { id: target.id, title: target.title, path: target.path },
      };
      debug('merge-cleaned', { workspaceId, deleted: deleted.length, kept: kept.length });
      return cleaned;
    }

    const summaries = await this.#summaries();
    const running = [...wanted.keys()].filter((id) => this.#runningOf(summaries, id));
    if (running.length > 0) {
      return {
        ...failure('sessions-running', `${running.length} session(s) are mid-turn. Wait for them to finish, then merge.`),
        running,
      };
    }

    // Idle holders are released rather than reported: only a session mid-turn
    // genuinely has to wait, and #move would refuse the rest one by one.
    const held = [];
    for (const id of wanted.keys()) {
      if (!this.#openOf(summaries, id)) continue;
      const release = await this.#releaseHeld(id);
      if (release.released) {
        debug('released-before-merge', { sessionId: id, via: release.via });
        continue;
      }
      held.push(id);
    }
    if (held.length > 0) {
      // Same as a rebuild: nothing public releases a held log, and the hold ends
      // with the process, so queue the whole merge for the boot pass.
      const pendingMerge = (await readPending()).filter(
        (entry) => !(entry.kind === 'merge' && entry.workspaceId === workspaceId),
      );
      pendingMerge.push({ kind: 'merge', workspaceId, sourceIds });
      await writePending(pendingMerge);
      debug('held-restart-queued', { kind: 'merge', workspaceId, sourceIds });
      return {
        ...failure(
          'held-restart',
          `${held.length} session(s) here are still held by the app, so their logs cannot be re-published now. The merge is queued: restart DSH and it finishes during startup.`,
          'none',
          { queued: true, canRestart: true },
        ),
        open: held,
      };
    }

    const moved = [];
    const failed = [];
    for (const id of wanted.keys()) {
      const outcome = await this.#move(id, target.path);
      if (outcome.status === 'moved' || outcome.status === 'attached') moved.push(id);
      else failed.push({ sessionId: id, code: outcome.code ?? outcome.status, message: outcome.message ?? null });
    }

    const { deleted, kept } = await this.#pruneSources(sources);

    const code = failed.length === 0 ? 'merged' : moved.length === 0 ? 'merge-failed' : 'merged-partial';
    const result = {
      status: code,
      code,
      effectState: moved.length > 0 ? 'applied' : 'none',
      moved: moved.length,
      sessions: moved,
      failed,
      deleted,
      kept,
      workspace: { id: target.id, title: target.title, path: target.path },
    };
    debug('merge-result', {
      workspaceId,
      sourceIds,
      moved: moved.length,
      failed: failed.length,
      deleted: deleted.length,
      kept: kept.length,
    });
    return result;
  }

  /**
   * Drop the source workspaces that no longer hold a session.
   *
   * A merge only removes a record once nothing is listed in it, so a half-done
   * merge keeps the sessions it could not move. An empty record is deleted even
   * when there was nothing to merge at all, which is how the ghost a failed
   * rebuild leaves behind gets cleaned up.
   */
  async #pruneSources(sources) {
    const registry = this.#ctx.workspaceRegistry;
    const deleted = [];
    const kept = [];
    for (const source of sources) {
      let fresh = null;
      try {
        fresh = await registry.get(source.id);
      } catch {
        fresh = null;
      }
      if (!fresh) continue;
      if (Array.isArray(fresh.sessionIds) && fresh.sessionIds.length === 0) {
        try {
          if (await registry.delete(source.id)) {
            deleted.push({ id: source.id, title: source.title });
            continue;
          }
        } catch (error) {
          debug('merge-delete-failed', describe(error));
        }
      }
      kept.push({ id: source.id, title: source.title, sessions: fresh.sessionIds.length });
    }
    return { deleted, kept };
  }

  /**
   * Make the target directory a workspace and list the session in it.
   *
   * Membership is *verified* rather than assumed: `attachSession` is judged
   * against the canonical-cwd index, which is built at startup, so a session
   * whose header was rewritten during this run may be rejected until the
   * harness restarts. A silent rejection here is what leaves a workspace that
   * exists but lists nothing, so the caller must see `attached: false`.
   */
  async #settleRegistry(sessionId, target) {
    const registry = this.#ctx.workspaceRegistry;
    let workspace = null;
    let created = false;
    let error = null;
    try {
      workspace = await registry.resolveByPath(target);
      if (!workspace) {
        workspace = await registry.create(target);
        created = true;
      }
      const forgotten = this.#forgetIndexedHeader(sessionId);
      debug('registry-index-forgotten', { sessionId, cleared: forgotten });
      await workspace.attachSession(sessionId);
    } catch (cause) {
      error = describe(cause);
    }

    let attached = false;
    try {
      const fresh = workspace ? await registry.get(workspace.id) : null;
      attached = Boolean(fresh && Array.isArray(fresh.sessionIds) && fresh.sessionIds.includes(sessionId));
    } catch {
      attached = false;
    }
    const detached = attached && workspace ? await this.#detachEverywhereElse(sessionId, workspace) : [];
    debug('registry-settled', { sessionId, target, created, attached, detached, error });
    if (attached) await this.#clearPending(sessionId);
    else await this.#recordPending(sessionId, target);
    return { workspace, created, error, attached, detached };
  }

  /**
   * Drop the registry's cached canonical-cwd view of one Session.
   *
   * `WorkspaceRegistry` builds its header index once, inside `[Service.init]`,
   * and `attachSession` validates against it: `readSessionHeader` prefers a
   * live Session, then its cached header, and only re-reads the store when
   * neither exists. After this plugin publishes a successor artifact the index
   * still holds the previous `cwd`, so the attach is refused with
   * "its cwd resolves to '<old directory>'" even though the store is correct.
   *
   * The index fields are plain `Map`s on the service instance, so removing one
   * entry makes the next validation re-read that session's header from the
   * store — the state a restart would produce — without touching a committed
   * byte and without rebuilding the whole index.
   *
   * Those fields are private. `#internals()` reports whether they are still
   * shaped the way this expects; when they are not, the attach is attempted
   * anyway and the caller learns about the refusal through `attached: false`.
   */
  #forgetIndexedHeader(sessionId) {
    const registry = this.#ctx.workspaceRegistry;
    if (!registry) return false;
    const keys = ['headers', 'sessionPaths'];
    let cleared = false;
    for (const key of keys) {
      const map = registry[key];
      if (!map || typeof map.has !== 'function' || typeof map.delete !== 'function') continue;
      if (!map.has(sessionId)) continue;
      try {
        map.delete(sessionId);
        cleared = true;
      } catch (error) {
        debug('registry-index-delete-failed', { key, error: describe(error) });
      }
    }
    const missing = registry.missingSessionPaths;
    if (missing && typeof missing.delete === 'function') {
      try {
        if (missing.delete(sessionId)) cleared = true;
      } catch {
        /* best effort */
      }
    }
    return cleared;
  }

  /** Remove a settled session from every other workspace's durable list. */
  async #detachEverywhereElse(sessionId, target) {
    const registry = this.#ctx.workspaceRegistry;
    const detached = [];
    let workspaces = [];
    try {
      // `list()` is synchronous in the shipped registry, but awaiting keeps this
      // working if that ever changes (and lets a fake return a promise).
      workspaces = (await registry.list()) ?? [];
    } catch {
      return detached;
    }
    for (const workspace of workspaces) {
      if (!workspace || workspace.id === target.id) continue;
      const listed = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId);
      if (!listed) continue;
      try {
        await workspace.detachSession(sessionId);
        detached.push({ id: workspace.id, title: workspace.title });
      } catch (detachError) {
        debug('detach-failed', { sessionId, workspace: workspace.id, reason: describe(detachError) });
      }
    }
    return detached;
  }

  async #recordPending(sessionId, target) {
    const list = await readPending();
    const next = list.filter((entry) => entry.sessionId !== sessionId);
    next.push({ sessionId, target, at: new Date().toISOString() });
    await writePending(next);
    debug('pending-recorded', { sessionId, target });
  }

  /** Drop a finished whole-workspace job from the pending queue. */
  async #dropPendingKind(entry) {
    const list = await readPending();
    const next = list.filter(
      (each) =>
        !(
          each.kind === entry.kind &&
          each.workspaceId === entry.workspaceId
        ),
    );
    if (next.length !== list.length) await writePending(next);
  }

  async #clearPending(sessionId) {
    const list = await readPending();
    if (!list.some((entry) => entry.sessionId === sessionId)) return;
    await writePending(list.filter((entry) => entry.sessionId !== sessionId));
  }

  /** Finish the memberships a previous run could not settle.
   *
   * `attachSession` validates the stored header against the canonical-cwd index
   * that the registry builds at startup, so a session whose header was rewritten
   * during the previous run is refused then and accepted now. Nothing else is
   * touched: the artifacts already live in the target directory. */
  async resumePending() {
    const list = await readPending();
    if (list.length === 0) return [];
    const outcomes = [];
    for (const entry of list) {
      if (entry.kind === 'rebuild' || entry.kind === 'merge') {
        try {
          const done =
            entry.kind === 'rebuild'
              ? await this.rebuildWorkspace(entry.workspaceId, entry.target)
              : await this.mergeWorkspaces(entry.workspaceId, entry.sourceIds ?? []);
          outcomes.push({
            kind: entry.kind,
            workspaceId: entry.workspaceId,
            code: done.code,
            error: done.status === 'ok' ? null : done.message,
          });
          if (done.code !== 'held-restart') await this.#dropPendingKind(entry);
        } catch (error) {
          outcomes.push({
            kind: entry.kind,
            workspaceId: entry.workspaceId,
            code: 'exception',
            error: describe(error),
          });
        }
        continue;
      }
      if (entry.kind === 'move') {
        // A move queued while the app held the session. Run it for real now: at
        // boot the writer is gone, so `create` can publish the successor.
        try {
          const moved = await this.#move(entry.sessionId, entry.target);
          outcomes.push({
            sessionId: entry.sessionId,
            target: entry.target,
            kind: 'move',
            code: moved.code,
            attached: moved.attached === true,
            error: moved.status === 'ok' ? null : moved.message,
          });
        } catch (error) {
          outcomes.push({
            sessionId: entry.sessionId,
            target: entry.target,
            kind: 'move',
            code: 'exception',
            attached: false,
            error: describe(error),
          });
        }
        continue;
      }
      try {
        const settled = await this.#settleRegistry(entry.sessionId, entry.target);
        outcomes.push({
          sessionId: entry.sessionId,
          target: entry.target,
          kind: 'attach',
          attached: settled.attached,
          error: settled.error,
        });
      } catch (error) {
        outcomes.push({
          sessionId: entry.sessionId,
          target: entry.target,
          kind: 'attach',
          attached: false,
          error: describe(error),
        });
      }
    }
    debug('pending-resumed', outcomes);
    return outcomes;
  }

  /* -------------------------------------------------------------- projections */

  /**
   * Rebuild the session's cached projection row against its moved header.
   *
   * The Session list builds its projection column from
   * `sessionProjectionCache.cachedSnapshot(header)`, and that read matches the
   * stored record's lifecycle identity — `formatVersion / createdAt / cwd /
   * isSeeded`. A record written before the move still carries the OLD `cwd`, so
   * after the move it no longer matches, the list receives no title block, and
   * the sidebar renders the row as "未命名" even though the cached title row is
   * still right there. A cold read off the complete log folds the log against
   * the new identity and writes a fresh checkpoint back.
   */
  #reproject(header, inheritedEventCount, events) {
    try {
      const cache = this.#ctx.get?.('sessionProjectionCache');
      if (!cache || typeof cache.coldSnapshot !== 'function') return { skipped: 'unavailable' };
      if (!Array.isArray(events) || events.length === 0) return { skipped: 'empty-log' };
      const block = cache.coldSnapshot(header, inheritedEventCount ?? 0, events);
      return {
        asOfSeq: block?.asOfSeq ?? null,
        keys: block?.values ? Object.keys(block.values) : [],
      };
    } catch (error) {
      // Keep the first frames: this path touches another package's internals, and
      // the message alone ("reading 'get'") does not say which one.
      return {
        error: describe(error),
        stack: String(error instanceof Error ? error.stack : '').split('\n').slice(0, 4).join(' | '),
      };
    }
  }

  /* ------------------------------------------------------------------- moving */

  /** Read every committed event plus the offset the artifact was created with. */
  async #readCommitted(sessionId) {
    // A read handle observes without taking write ownership, so a stopped
    // session can be copied even while the UI keeps it open.
    const reader = await this.#ctx.sessionPersistence.open(sessionId, 'read');
    try {
      const { events } = await reader.read();
      return { events, inheritedEventCount: reader.inheritedEventCount };
    } finally {
      await reader.close();
    }
  }

  /**
   * Compare a freshly published successor against what was read from the source.
   *
   * `stat()` only proves that *a* generation exists, so it cannot tell a complete
   * successor from a truncated one. The move deletes the original right after
   * this, which makes a byte-level comparison worth the extra read.
   */
  async #verifySuccessor(sessionId, target, expectedCount, expectedLastSeq) {
    try {
      const reader = await this.#ctx.sessionPersistence.open(sessionId, 'read');
      try {
        const { events } = await reader.read();
        const header = reader.header ?? {};
        const count = Array.isArray(events) ? events.length : 0;
        const lastSeq = count > 0 ? events[count - 1].seq : null;
        const sameId = String(header.id ?? '') === String(sessionId);
        const sameCwd = typeof header.cwd === 'string' && samePath(header.cwd, target);
        const sameCount = count === expectedCount;
        const sameTail = expectedLastSeq === null || lastSeq === expectedLastSeq;
        return {
          ok: sameId && sameCwd && sameCount && sameTail,
          count,
          lastSeq,
          sameId,
          sameCwd,
          sameCount,
          sameTail,
        };
      } finally {
        await reader.close();
      }
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }

  /** Remove a successor that must not survive (the source is going back). */
  async #discardSuccessor(sessionId) {
    try {
      const artifact = await locateArtifact(this.#ctx.sessionPersistence, sessionId);
      if (artifact) await removeDirectory(dirname(artifact));
    } catch {
      /* a survivor is reported by the caller, not thrown here */
    }
  }

  /**
   * Move one session. Returns a result object; never throws at its callers.
   *
   * The steps are: checks -> read -> park -> publish -> read back -> discard the
   * parked copy; the registry binding and the projection cache follow, and both
   * are reported instead of enforced.
   */
  async #move(sessionId, target) {
    const ctx = this.#ctx;

    // One validation path for every caller (session moves and workspace
    // rebuilds alike), so the rules cannot drift apart.
    const checked = await this.#checkTarget(target);
    if (!checked.ok) return checked;
    const destination = checked.path;

    // Refuse only what the app itself reports: a turn in flight, or a session the
    // app holds (which the store will not let us re-publish).
    const summaries = await this.#summaries();
    if (this.#runningOf(summaries, sessionId)) {
      return failure('running', 'A turn is in flight for this session; wait for it to finish, then move it.');
    }

    let snapshot;
    try {
      snapshot = await ctx.sessionPersistence.stat(sessionId);
    } catch (error) {
      return failure('unreadable', `The stored session could not be read: ${describe(error)}`);
    }
    if (!snapshot) return failure('not-found', 'No stored session with that id was found.');

    const header = { ...(snapshot.header ?? {}) };
    delete header.type;
    const oldCwd = typeof header.cwd === 'string' ? header.cwd : null;
    if (!oldCwd) {
      return failure('no-cwd', 'This session has no recorded working directory.');
    }

    // Already there: the file move happened in an earlier run but the workspace
    // membership did not stick. Finish that half instead of refusing, so a
    // partial move is repairable by repeating the same command.
    if (samePath(oldCwd, destination)) {
      return this.#repairMembership(sessionId, header, oldCwd, destination);
    }

    if (snapshot?.formatStatus === 'migration-required') {
      return failure(
        'needs-migration',
        'This session is still stored in an older format. Open it once so the harness upgrades it, then move it.',
      );
    }

    if (this.#openOf(summaries, sessionId)) {
      // The store owns this id while the app holds the session, so `create` has
      // no way to publish a successor for it, and nothing in the public surface
      // releases that hold. The hold does not outlive the process — so queue the
      // move and let the boot pass finish it once the writer is gone.
      const queuedList = (await readPending()).filter((entry) => entry.sessionId !== sessionId);
      queuedList.push({ sessionId, target: destination, kind: 'move' });
      await writePending(queuedList);
      debug('held-restart-queued', { sessionId, target: destination });
      return failure(
        'held-restart',
        'The app still holds this session, so its log cannot be re-published while it runs. The move is queued: restart DSH (the panel has a button) and it finishes during startup.',
        'none',
        { queued: true, canRestart: true, target: destination },
      );
    }

    let events;
    let inheritedEventCount;
    try {
      ({ events, inheritedEventCount } = await this.#readCommitted(sessionId));
    } catch (error) {
      return failure('unreadable', `The committed events could not be read: ${describe(error)}`);
    }

    // A header-only session has nothing to publish: `create` writes nothing and
    // only the first `append` publishes, so moving it would delete the original
    // and leave no successor behind.
    if (!Array.isArray(events) || events.length === 0) {
      return failure(
        'empty-log',
        'This session has no committed events yet. Open it once so its header is written, then move it.',
      );
    }
    const lastSeq = events[events.length - 1]?.seq ?? null;

    const artifact = await locateArtifact(ctx.sessionPersistence, sessionId);
    if (!artifact) {
      return failure('artifact-missing', 'The stored session file could not be located, so nothing was changed.');
    }

    // Point of no return. The artifact is *parked* beside itself rather than
    // deleted, so the id leaves the store exactly once: `create` refuses an id
    // that still exists, and a failure below restores the parked directory.
    const sessionDirectory = dirname(artifact);
    const parkedDirectory = `${sessionDirectory}${PARK_MARK}${Date.now().toString(36)}`;
    try {
      await rename(sessionDirectory, parkedDirectory);
    } catch (error) {
      return failure('write-failed', `The stored session could not be parked for the move: ${describe(error)}`);
    }

    /** Put the original back and drop whatever the attempt left behind. */
    const restore = async () => {
      await this.#discardSuccessor(sessionId);
      try {
        await rm(sessionDirectory, { recursive: true, force: true });
      } catch {
        /* nothing was published under the original name */
      }
      await rename(parkedDirectory, sessionDirectory);
    };

    // A store that resolves ids through a startup index would still report the
    // session here, and `create` would then refuse the id. Say so instead of
    // failing with a misleading write error.
    let stillListed = false;
    try {
      stillListed = (await ctx.sessionPersistence.stat(sessionId)) !== undefined;
    } catch {
      stillListed = false;
    }
    if (stillListed) {
      try {
        await rename(parkedDirectory, sessionDirectory);
      } catch {
        /* the identifier is still in the layout, so nothing was lost */
      }
      return failure(
        'store-cached',
        'The session store still reports this session after it left the layout, so nothing was changed. Restart DSH and try again.',
      );
    }

    let handle = null;
    try {
      handle = await ctx.sessionPersistence.create(
        { ...header, cwd: destination },
        inheritedEventCount === undefined ? undefined : { inheritedEventCount },
      );
      await handle.append(events);
      await handle.flush();
    } catch (error) {
      const reason = describe(error);
      try {
        await handle?.close?.();
      } catch {
        /* the handle may already be gone */
      }
      try {
        await restore();
        return failure('write-failed', `The move failed and was rolled back: ${reason}`);
      } catch (restoreError) {
        return failure(
          'rollback-failed',
          `The move failed (${reason}) and the rollback failed too (${describe(restoreError)}). The parked copy is at ${parkedDirectory}.`,
          'unknown',
        );
      }
    }

    try {
      await handle.close();
    } catch {
      /* close is best effort; flush already made the successor durable */
    }

    // Nothing may be released until the successor is really in the store, and
    // nothing may be released *as correct* until it holds the same events.
    const verified = await this.#verifySuccessor(sessionId, destination, events.length, lastSeq);
    if (!verified.ok) {
      debug('successor-verify-failed', { sessionId, verified });
      try {
        await restore();
        return failure(
          'verify-failed',
          `The successor did not match the original (${
            verified.error ?? `expected ${events.length} events, read ${verified.count}`
          }), so the original was restored.`,
        );
      } catch (restoreError) {
        return failure(
          'rollback-failed',
          `The successor did not match the original and the rollback failed too (${describe(restoreError)}). The parked copy is at ${parkedDirectory}.`,
          'unknown',
        );
      }
    }

    // The successor is durable and complete: release the parked copy and any
    // project directory it emptied.
    try {
      await removeDirectory(parkedDirectory);
    } catch {
      /* a leftover parked copy is inert: it is not part of the store layout */
    }

    return this.#rebind(sessionId, {
      header,
      oldCwd,
      destination,
      events,
      inheritedEventCount,
      verifiedCwd: destination,
    });
  }

  /** The half-move shape: the file is already in `destination`, so only the
   * membership and the cached title have to be finished. */
  async #repairMembership(sessionId, header, oldCwd, destination) {
    const settled = await this.#settleRegistry(sessionId, destination);
    debug('repair-result', { sessionId, destination, attached: settled.attached });
    if (!settled.attached) {
      return failure(
        'workspace-unattached',
        `The session is stored in this directory but the workspace did not accept it (${
          settled.error ?? 'it did not report the session'
        }). Restart the harness, then repeat the move to finish the membership.`,
      );
    }

    let reprojected = { skipped: 'no-log' };
    try {
      const { events, inheritedEventCount } = await this.#readCommitted(sessionId);
      reprojected = this.#reproject({ ...header, cwd: destination }, inheritedEventCount, events);
    } catch (error) {
      reprojected = { error: describe(error) };
    }
    debug('reprojected', { sessionId, reprojected });

    const code = reprojected && reprojected.error ? 'attached-unreprojected' : 'attached';
    return {
      status: code,
      code,
      effectState: settled.created ? 'applied' : 'none',
      message:
        code === 'attached'
          ? 'The session already lived in this directory; its workspace membership is now in place.'
          : 'The session already lived in this directory and the membership is in place, but its cached title could not be refreshed. Reload the page; if the row still reads “未命名”, repeat the same move.',
      oldCwd,
      newCwd: destination,
      verifiedCwd: oldCwd,
      events: null,
      workspace: settled.workspace
        ? {
            id: settled.workspace.id,
            title: settled.workspace.title,
            path: settled.workspace.path,
            created: settled.created,
          }
        : null,
      detachedFrom: null,
      attached: true,
      projections: reprojected,
      needsRestart: false,
      workspaceError: settled.error,
    };
  }

  /** Bind the moved session to its workspace and refresh its cached title. */
  async #rebind(sessionId, { header, oldCwd, destination, events, inheritedEventCount, verifiedCwd }) {
    const settled = await this.#settleRegistry(sessionId, destination);
    // The file now carries the new header; the cached projection row must learn
    // the new identity or the sidebar keeps rendering this session as "未命名".
    const reprojected = this.#reproject({ ...header, cwd: destination }, inheritedEventCount, events);

    const verifiedOk = Boolean(verifiedCwd && samePath(verifiedCwd, destination));
    const attached = settled.attached;
    const reprojectedOk = !(reprojected && reprojected.error);
    const code = !verifiedOk
      ? 'moved-unverified'
      : !attached
        ? 'moved-unattached'
        : !reprojectedOk
          ? 'moved-unreprojected'
          : 'moved';

    const message = {
      moved: 'The session was moved and is listed under the target workspace.',
      'moved-unverified': 'The session was written to the new directory but the read-back check did not match it.',
      'moved-unattached': `The session file moved, but the workspace registry did not accept it yet (${
        settled.error ?? 'it did not report the session'
      }). It is recorded as pending and settles on the next start.`,
      'moved-unreprojected':
        'The session moved and is listed, but its cached title could not be refreshed, so the row may read “未命名”. Reload the page; if it still does, repeat the same move.',
    }[code];

    const result = {
      status: code,
      code,
      effectState: 'applied',
      message,
      oldCwd,
      newCwd: destination,
      verifiedCwd,
      events: Array.isArray(events) ? events.length : null,
      workspace: settled.workspace
        ? {
            id: settled.workspace.id,
            title: settled.workspace.title,
            path: settled.workspace.path,
            created: settled.created,
          }
        : null,
      detachedFrom: settled.detached.length > 0 ? settled.detached : null,
      attached,
      projections: reprojected,
      // True when the app still holds this session open. The move is safe, but
      // the old agent keeps a handle on the parked copy until the page reloads,
      // so the result tells the UI to refresh right away.
      live: Boolean(this.#ctx.agents?.get?.(sessionId)),
      needsRestart: !attached,
      workspaceError: settled.error,
    };
    debug('move-result', {
      sessionId,
      code,
      verifiedCwd,
      attached,
      reprojected,
      live: result.live,
      createdWorkspace: settled.created,
      workspaceError: settled.error,
    });
    return result;
  }
}

/* --------------------------------------------------------------- plugin entry */

/**
 * Exported for the test suite only: the pure path helpers and the service class
 * are driven directly, without a Cordis context.
 */
export { WorkspaceControl, encodeId, lastSegment, pathKey, samePath, titleFollowsPath };

/** `tools` is deliberately *not* required: the plugin works without it, and a
 * missing required service would keep the whole entry inactive (silently). */
export const inject = ['typert', 'sessionPersistence', 'workspaceRegistry', 'agents'];

/** Reading a Cordis service key that is not injected throws, so probes go
 * through `ctx.get`, which is safe for keys this plugin does not require. */
const peek = (ctx, key) => {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined;
  } catch {
    return undefined;
  }
};

export function apply(ctx) {
  // An exception here fails the whole entry and, on the Web boot path, the
  // application start. A broken plugin must not be able to do that.
  try {
    applyEntry(ctx);
  } catch (error) {
    degradedReason = describe(error);
    debug('apply-failed', degradedReason);
  }
}

/** JSON round-trip so tool output survives the host's lossless check. */
const plain = (value) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { status: 'error', code: 'unserializable', message: 'The result could not be serialized.' };
  }
};

const TOOL = {
  name: 'workspace_control',
  description:
    'Manage stored sessions and workspaces without losing ids, titles, history or tool records. action=inspect reports one session; action=move relocates one session to `target`; action=listWorkspaces reports every workspace with its stored-session count and how many of those are held by the app or mid-turn; action=rebuild re-homes a whole workspace onto `target` and replaces the record there; action=merge folds the workspaces in `sourceIds` into `workspaceId`; action=retitle renames one workspace; action=remove deletes one workspace record (its sessions are archived first unless keepSessions is true); action=probeRestart reports whether this process can restart DSH; action=restart restarts DSH (pass force to interrupt a turn in flight). Held or mid-turn sessions refuse the whole call first, and nothing moves when the pre-flight fails.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'inspect',
          'move',
          'listWorkspaces',
          'rebuild',
          'merge',
          'retitle',
          'remove',
          'probeAgent',
          'release',
          'probeRestart',
          'restart',
          'clientModule',
        ],
        description:
          'inspect reports one session; move relocates one session; listWorkspaces reports every workspace with its stored-session count and blockers; rebuild re-homes a whole workspace onto `target`; merge folds `sourceIds` into `workspaceId`; retitle sets one workspace title; remove deletes one workspace record; probeRestart reports the restart plan; restart restarts DSH; clientModule reports whether the Client bundle is part of the Web boot graph.',
      },
      sessionId: { type: 'string', description: 'Exact session id, such as session-<uuid>. Required for inspect and move.' },
      workspaceId: {
        type: 'string',
        description: 'Exact workspace id. Required for rebuild and merge (the workspace that receives the sessions).',
      },
      target: { type: 'string', description: 'Absolute target directory. Required for move and rebuild.' },
      title: { type: 'string', description: 'New workspace title. Required for retitle.' },
      keepSessions: {
        type: 'boolean',
        description: 'For remove: leave the sessions unarchived. Defaults to false, which archives them first.',
      },
      sourceIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace ids to fold into workspaceId. Required for merge.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

const dispatch = async (service, args) => {
  const action = args && typeof args.action === 'string' ? args.action : 'inspect';
  debug('tool', { action, sessionId: args && args.sessionId, workspaceId: args && args.workspaceId });
  if (action === 'move') return service.move(args.sessionId, args.target);
  if (action === 'listWorkspaces') return service.listWorkspaces();
  if (action === 'rebuild') return service.rebuildWorkspace(args.workspaceId, args.target);
  if (action === 'merge') return service.mergeWorkspaces(args.workspaceId, args.sourceIds);
  if (action === 'retitle') return service.retitleWorkspace(args.workspaceId, args.title);
  if (action === 'remove') return service.removeWorkspace(args.workspaceId, args.keepSessions);
  if (action === 'probeAgent') return service.probeAgent(args.sessionId);
  if (action === 'release') return service.releaseSession(args.sessionId);
  if (action === 'probeRestart') return service.probeRestart();
  if (action === 'clientModule') return service.clientModule();
  if (action === 'restart') return service.restart(args.force);
  return service.inspect(args.sessionId);
};

function applyEntry(ctx) {
  debug('apply', {
    node: process.version,
    sessionPersistence: typeof peek(ctx, 'sessionPersistence'),
    typert: typeof peek(ctx, 'typert'),
    workspaceRegistry: typeof peek(ctx, 'workspaceRegistry'),
    tools: typeof peek(ctx, 'tools'),
    agents: typeof peek(ctx, 'agents'),
  });

  const service = new WorkspaceControl(ctx);
  ctx.provide(NAMESPACE, service);

  // Every registration is disposable: the plugin is reloaded in place with
  // `plugin_manager set_plugin`, and a stale namespace or tool row would then
  // outlive its owning Context.
  ctx.effect(
    () =>
      ctx.typert.register({
        package: PACKAGE,
        face: 'host',
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: DESCRIPTORS,
      }),
    `${PACKAGE}: typert contribution`,
  );

  // The same operation, reachable by an agent. Same methods as the Client entry
  // point, so both callers observe identical refusals and results. Registered
  // through a scoped inject so a composition without `tools` still starts.
  const registerTool = (owner, tools) => {
    if (!tools || typeof tools.register !== 'function') return;
    const dispose = tools.register({
      ...TOOL,
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args) => plain(await dispatch(service, args)),
    });
    debug('tool-registered', true);
    // `effect(callback)` calls the callback and keeps its *return value* as the
    // disposer, so the disposer is handed over inside a thunk.
    if (typeof dispose === 'function') {
      owner.effect?.(() => dispose, `${PACKAGE}: agent tool`);
    }
  };
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (scoped) => registerTool(scoped, scoped.tools));
    } else {
      registerTool(ctx, peek(ctx, 'tools'));
    }
  } catch (error) {
    debug('tool-register-failed', describe(error));
  }

  // Self-heal: settle the memberships a previous run could not. By the time this
  // fires the registry has rebuilt its canonical-cwd index, which is exactly the
  // index that refused the attach during the previous run.
  const timer = setTimeout(() => {
    service.resumePending().catch((error) => {
      debug('pending-resume-failed', describe(error));
    });
  }, RESUME_DELAY_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  ctx.effect(() => () => clearTimeout(timer), `${PACKAGE}: pending repair timer`);
  // A queued move may lose its first race with the web Client reconnecting, and
  // the hold then comes back. Keep retrying for a short window instead of
  // leaving the work to the next restart.
  let retries = 0;
  const retry = setInterval(async () => {
    retries += 1;
    if (retries > RESUME_RETRIES) {
      clearInterval(retry);
      return;
    }
    try {
      const left = await readPending();
      if (left.length === 0) {
        clearInterval(retry);
        return;
      }
      await service.resumePending();
    } catch (error) {
      debug('pending-resume-failed', describe(error));
    }
  }, RESUME_RETRY_MS);
  if (retry && typeof retry.unref === 'function') retry.unref();
  ctx.effect(() => () => clearInterval(retry), `${PACKAGE}: pending repair retries`);
}
