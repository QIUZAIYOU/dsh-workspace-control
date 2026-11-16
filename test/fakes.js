/**
 * Test doubles for the host half.
 *
 * The real seams (`sessionPersistence`, `workspaceRegistry`, `sessionController`)
 * are replaced by in-memory fakes that still read and write the *real* session
 * layout under a temporary `DSH_HOME`, so `locateArtifact`, parking, publishing
 * and rollback all run against a real filesystem.
 */

import { mkdir, mkdtemp, readdir, rm, stat as fsStat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Make `sessionRoots()` resolve to a throwaway harness home. */
export async function makeHarnessHome() {
  // Keep the plugin's own log out of the installed tree while tests run.
  process.env.WSC_LOG_PATH = join(tmpdir(), `wsc-test-${process.pid}.log`);
  const home = await mkdtemp(join(tmpdir(), 'wsc-test-'));
  process.env.DSH_HOME = home;
  await mkdir(join(home, 'sessions'), { recursive: true });
  return {
    home,
    async cleanup() {
      await rm(home, { recursive: true, force: true });
      delete process.env.DSH_HOME;
    },
  };
}

/**
 * A stored-session store with the behaviour the move transaction relies on.
 *
 * `faults` switches the failure modes on:
 * - `createThrows`  `create()` refuses (a live owner, in practice)
 * - `truncate`      the published successor reads back short (verify trips)
 * - `keepStat`      `stat()` keeps reporting a parked id (startup-index store)
 */
export function makePersistence({ home, faults = {} }) {
  /** @type {Map<string, {header: object, events: object[]}>} */
  const store = new Map();
  const handles = [];
  let published = 0;
  // `truncate` only bites after the successor was published: a truncated *source*
  // read would make the expectation match the truncated copy and hide the fault.
  let createdOnce = false;

  const layoutPath = (id, cwd) => {
    const bucket = `--${String(cwd).replace(/[^A-Za-z0-9._-]/g, '-')}--`;
    return join(home, 'sessions', bucket, id.replace(/[^A-Za-z0-9._-]/g, '~'), 'session.v9.jsonl');
  };

  const publish = async (id) => {
    const entry = store.get(id);
    const target = layoutPath(id, entry.header.cwd);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, entry.events.map((event) => JSON.stringify(event)).join('\n'), 'utf8');
    published += 1;
  };

  /** A parked copy inside the store is a corrupt artifact for the 0.2.2 backend:
   * it derives each session's identity from the path, so listing refuses the
   * whole store instead of skipping the stray directory. */
  const parkedInsideStore = async () => {
    const root = join(home, 'sessions');
    let buckets = [];
    try {
      buckets = await readdir(root, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      let entries = [];
      try {
        entries = await readdir(join(root, bucket.name));
      } catch {
        continue;
      }
      if (entries.some((name) => name.includes('.workspace-control-parked-'))) return true;
    }
    return false;
  };

  return {
    faults,
    store,
    get published() {
      return published;
    },
    handles,
    async seed(id, cwd, events) {
      store.set(id, { header: { version: 9, id, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 }, events });
      await publish(id);
      return layoutPath(id, cwd);
    },
    /** The real store resolves an id through the layout, so a parked id is gone. */
    async present(id) {
      if (faults.keepStat) return store.has(id);
      const entry = store.get(id);
      if (!entry) return false;
      try {
        await fsStat(layoutPath(id, entry.header.cwd));
        return true;
      } catch {
        return false;
      }
    },
    async stat(id) {
      if (!(await this.present(id))) return undefined;
      const entry = store.get(id);
      return { header: { ...entry.header }, formatStatus: 'current', eventCount: entry.events.length };
    },
    async list() {
      if (faults.poisonedByParked && (await parkedInsideStore())) {
        throw new Error('session persistence listing failed: corrupt session log');
      }
      const rows = [];
      for (const [id, entry] of store.entries()) {
        if (!(await this.present(id))) continue;
        rows.push({ header: { ...entry.header }, formatStatus: 'current', eventCount: entry.events.length });
      }
      return rows;
    },
    async open(id) {
      const entry = store.get(id);
      if (!entry) throw new Error(`no such session: ${id}`);
      const reader = {
        id,
        header: { ...entry.header },
        inheritedEventCount: 0,
        async read() {
          const short = faults.truncate && createdOnce;
          const events = short ? entry.events.slice(0, 1) : entry.events;
          return { eventState: 'committed', events };
        },
        async close() {},
      };
      handles.push(reader);
      return reader;
    },
    async create(header, options) {
      if (faults.createThrows) throw new Error(`session "${header.id}" already exists`);
      createdOnce = true;
      if (await this.present(header.id)) throw new Error(`session "${header.id}" already exists`);
      const events = [];
      store.set(header.id, { header: { ...header }, events });
      const handle = {
        id: header.id,
        header: { ...header },
        inheritedEventCount: options?.inheritedEventCount ?? 0,
        async append(batch) {
          events.push(...batch);
        },
        async flush() {
          await publish(header.id);
        },
        async close() {},
      };
      handles.push(handle);
      return handle;
    },
  };
}

/**
 * Registry fake that follows DSH 0.2.2.
 *
 * Membership is filtered through a path index and every write prunes the ids
 * that index does not account for. That prune is the behaviour a stale index
 * turns into a lost membership, so it has to be modelled rather than papered
 * over.
 */
export function makeRegistry() {
  const records = new Map();
  const headers = new Map();
  const sessionPaths = new Map();
  const missingSessionPaths = new Set();
  const order = [];

  const accounts = (sessionId, path) =>
    sessionPaths.get(sessionId) === path || missingSessionPaths.has(sessionId);

  const workspace = (id) => {
    const record = records.get(id);
    /** The shipped mutate: apply the change, then prune unaccounted ids. */
    const prune = (next) => {
      next.sessionIds = next.sessionIds.filter((sessionId) => accounts(sessionId, next.path));
      return next;
    };
    return Object.freeze({
      id,
      title: record.title,
      path: record.path,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      get sessionIds() {
        return record.sessionIds.filter((sessionId) => accounts(sessionId, record.path));
      },
      async setTitle(title) {
        record.title = title;
        prune(record);
      },
      async attachSession(sessionId) {
        // A record that already lists the id skips validation and does not
        // refresh the path, exactly like the shipped registry.
        if (!record.sessionIds.includes(sessionId)) sessionPaths.set(sessionId, record.path);
        if (!record.sessionIds.includes(sessionId)) record.sessionIds.unshift(sessionId);
        prune(record);
      },
      async detachSession(sessionId) {
        record.sessionIds = record.sessionIds.filter((entry) => entry !== sessionId);
        prune(record);
      },
      async status() {
        return 'ok';
      },
    });
  };

  return {
    headers,
    sessionPaths,
    missingSessionPaths,
    async list() {
      return order.map((id) => workspace(id));
    },
    get(id) {
      return records.has(id) ? workspace(id) : undefined;
    },
    async resolveByPath(path) {
      const id = order.find((candidate) => records.get(candidate).path === path);
      return id === undefined ? undefined : workspace(id);
    },
    async create(path) {
      const id = `ws-${records.size + 1}`;
      records.set(id, { title: path.split(/[\\/]/).pop(), path, sessionIds: [] });
      order.push(id);
      return workspace(id);
    },
    async delete(id) {
      records.delete(id);
      const at = order.indexOf(id);
      if (at !== -1) order.splice(at, 1);
      return true;
    },
    async insertBefore(id, beforeId) {
      const at = order.indexOf(id);
      if (at !== -1) order.splice(at, 1);
      const target = beforeId ? order.indexOf(beforeId) : -1;
      order.splice(target === -1 ? order.length : target, 0, id);
    },
    async archiveSession(sessionId) {
      this.archived = (this.archived ?? []).concat(sessionId);
    },
    async unarchiveSession(sessionId) {
      this.archived = (this.archived ?? []).filter((entry) => entry !== sessionId);
    },
  };
}

/** Cordis-shaped context: `ctx.get` decides which service a lookup finds. */
export function makeContext({ persistence, registry, summaries = [], agents = [] }) {
  const services = {
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    agents: { get: (id) => agents.find((agent) => agent.id === id), list: () => agents },
    sessionController: { list: async () => ({ items: summaries }) },
  };
  // The service reads some keys as properties (as an injected Cordis context
  // would allow) and some through `ctx.get`, so the fake offers both.
  return {
    ...services,
    services,
    get: (key) => services[key],
    effect: () => () => {},
    provide: () => () => {},
  };
}

/**
 * A live agent the app holds, with none of the disposal handles available: the
 * release path has to report that it could not let go.
 */
export function makeAgent(id) {
  return { id, ctx: {} };
}

/** `SessionSummary` rows the sidebar would show. */
export function summary(id, { running = false, agentAvailable = false } = {}) {
  return { sessionId: id, running, agentAvailable, blank: false, updatedAt: 1 };
}
