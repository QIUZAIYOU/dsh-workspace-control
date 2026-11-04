/**
 * The refresh decision, shared by the Host half, the Client half and the tests.
 *
 * "Refresh" never restarts the Host process: it re-publishes the Client bundles
 * whose files changed and then either rebuilds the document or hot-swaps the
 * live graph. Which one is allowed is a runtime fact, not a preference, so the
 * rule lives here as a pure function instead of inside a click handler.
 *
 * Why the desktop shell cannot always reload: the shell caches the Web boot
 * manifest (the index injections, including every /plugins batch URL) once when
 * the Host starts and reuses it for every later document load. After the graph
 * was recomposed, those URLs are either the previous generation or gone (404).
 * A blind `location.reload()` therefore ends in a blank window — so a reload is
 * allowed only while the page's boot revision still IS the current composition.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const REV = (value) => typeof value === 'string' && value !== '';

/**
 * Decide how the interface may be rebuilt after the Host republished bundles.
 *
 * @param {object} input
 * @param {boolean} input.isDesktop whether the page runs inside the desktop shell
 * @param {string|null} input.bootRev the graph revision frozen into the document
 * @param {string|null} input.liveRev the graph revision the Host serves now
 * @param {string[]} input.changed Client ids whose bundle revision changed
 * @returns {{ action: 'reload'|'sync', reason: string }}
 */
export function decideRefreshAction(input) {
  // Without a payload there is nothing to prove: never reload on a guess.
  if (!input || typeof input !== 'object') return { action: 'sync', reason: 'unknown' };
  const value = input;
  const changed = Array.isArray(value.changed) ? value.changed : [];

  // A plain dsh web page renders its index per request, so its boot graph is
  // always current: reloading is the honest answer and gets a clean document.
  if (value.isDesktop !== true) return { action: 'reload', reason: 'web' };

  // The desktop shell freezes the boot manifest when the window starts, and a
  // real crash proved that even a "current" revision can still mix two
  // generations inside one manifest (batch rev df84841ea5cb, entry rev
  // a604888590be). A reload then answers with stale /plugins batches, one
  // failure aborts the whole boot round and the window never comes back. So the
  // desktop shell never reloads: it hot-swaps the live graph or says so.
  if (changed.length > 0) return { action: 'sync', reason: 'changed' };
  if (!REV(value.bootRev) || !REV(value.liveRev)) return { action: 'sync', reason: 'unknown' };
  if (value.bootRev !== value.liveRev) return { action: 'sync', reason: 'stale-boot' };
  return { action: 'sync', reason: 'current' };
}

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

const failure = (code, reason) => ({
  status: 'error',
  code,
  rev: null,
  changed: [],
  entries: [],
  graph: null,
  reason,
});

/**
 * Ask the Host's Client-module registry to re-read every bundle on disk.
 *
 * `rebuilt(id)` re-captures the artifact baseline, recomposes the graph only
 * when the bytes actually changed, and returns the entry revision — the same
 * revision when nothing moved. That return value is the whole signal: a sweep
 * that returns every old revision changed nothing, and the caller may reload.
 *
 * Every per-entry failure is swallowed on purpose: one unreadable plugin must
 * not stop the other bundles from being republished (the caller still learns
 * that nothing changed, and nothing is destroyed).
 *
 * @param {object|null} modules the `clientModules` service
 * @returns {{ status: 'ok'|'error', code: string, rev: string|null, changed: string[], entries: {id: string, rev: string|null}[], graph: object|null, reason?: string }}
 */
export function refreshClientModules(modules) {
  try {
    if (!modules || typeof modules.graph !== 'function') {
      return failure('unsupported', 'clientModules is unavailable');
    }

    let before;
    try {
      before = modules.graph();
    } catch (error) {
      return failure('unreadable', describe(error));
    }

    const entries = Array.isArray(before?.entries) ? before.entries : [];
    if (entries.length === 0) return failure('unreadable', 'the Web boot graph has no entries');

    const rebuilt = typeof modules.rebuilt === 'function' ? modules.rebuilt : null;
    const baselineOf = (id) => {
      if (typeof modules.artifactBaseline !== 'function') return undefined;
      try {
        return modules.artifactBaseline(id);
      } catch {
        // A bundle the registry cannot stat is not ours to republish.
        return undefined;
      }
    };

    const changed = [];
    for (const entry of entries) {
      const id = entry && typeof entry.id === 'string' ? entry.id : '';
      if (id === '') continue;
      if (rebuilt === null) break;
      // External entries have no local artifact: republishing them is a no-op
      // the registry answers with a throw, so they are skipped here instead.
      if (baselineOf(id) === undefined) continue;

      let rev;
      try {
        rev = rebuilt(id);
      } catch {
        continue;
      }
      if (typeof rev === 'string' && rev !== entry.rev) changed.push(id);
    }

    let after = null;
    try {
      after = modules.graph();
    } catch {
      after = null;
    }
    const graph = after ?? before;
    const liveEntries = Array.isArray(graph?.entries) ? graph.entries : entries;

    return {
      status: 'ok',
      code: changed.length > 0 ? 'refreshed' : 'unchanged',
      rev: typeof graph?.rev === 'string' ? graph.rev : null,
      changed,
      entries: liveEntries
        .filter((entry) => entry && typeof entry.id === 'string')
        .map((entry) => ({ id: entry.id, rev: typeof entry.rev === 'string' ? entry.rev : null })),
      // Returned verbatim: the Host JSON-clones it for the wire and the Client
      // hands the same shape to `entries.sync`.
      graph: graph ?? null,
    };
  } catch (error) {
    return failure('unreadable', describe(error));
  }
}

const RUNNING = 2;
/** The app's own sentence for "another update already holds the transaction". */
const NESTED_TRANSACTION = /\btransactions? cannot be nested\b/iu;
const EMPTY_PLUGINS = () => ({ applied: [], warnings: [], pending: [], restartReason: null, restartOnly: false });

const pause = (ms) =>
  new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });

/**
 * Every Loader entry id and its fiber state. `null` means the list could not be
 * read at all, which is different from "nothing is running": an update whose
 * health cannot be read is not one that may be called finished.
 *
 * Read defensively: this is diagnostics, and a Loader shape change must not
 * turn a refresh into a crash.
 */
function entryStates(loader) {
  try {
    if (!loader || typeof loader.entries !== 'function') return null;
    const states = new Map();
    for (const entry of loader.entries()) {
      const id = entry?.options?.id;
      if (typeof id === 'string' && id !== '') states.set(id, entry?.fiber?.state ?? null);
    }
    return states;
  } catch {
    return null;
  }
}

function runningIds(states, selfId) {
  if (states === null) return [];
  return [...states]
    .filter(([, state]) => state === RUNNING)
    .map(([id]) => id)
    .filter((id) => id !== selfId);
}

/**
 * The transaction context the HMR service keeps in an AsyncLocalStorage. When a
 * refresh is asked for from inside a plugin context, the service must be entered
 * from outside it, or the call is refused as nested. Resolved by type as well as
 * by name so a renamed field still works.
 */
function transactionOf(service) {
  try {
    if (typeof service?.executing?.exit === 'function') return service.executing;
    for (const value of Object.values(service ?? {})) {
      if (value instanceof AsyncLocalStorage) return value;
    }
  } catch {
    // A service that refuses inspection simply has no context to leave.
  }
  return null;
}

function mergePlugins(client, code, status, plugins, reason) {
  const merged = { ...client, status, code, plugins };
  if (reason !== undefined) merged.reason = reason;
  return merged;
}

/**
 * Reload the Host-side plugin code and then republish the Client bundles.
 *
 * This is the half the Refresh button used to miss: `refreshClientModules` only
 * re-publishes browser bundles, so an edited index.js kept running its old code
 * until the process was restarted. The Host half now asks the official HMR
 * service to reconcile the profile first (the same operation the plugin manager
 * performs when it reloads a package), then the Client sweep below publishes the
 * new bundles the reloaded Host serves.
 *
 * The order matters: reconciling can recompose the Client graph, so the sweep
 * runs after it and sees the new artifacts. Both halves are reported separately
 * because either one can fail without the other.
 *
 * @param {object} input
 * @param {object|null} input.hmr the `hmr` service (runExclusive + reconcileProfile)
 * @param {object|null} input.loader the `loader` service, read for entry health
 * @param {object|null} input.modules the `clientModules` service
 * @param {string|null} input.selfId this plugin's Loader entry id, never required
 * @param {'auto'|'plugins'|'interface'} [input.mode]
 * @param {number} [input.retryMs] wait between attempts when the queue is busy
 */
export async function refreshWithHmr({ hmr = null, loader = null, modules = null, selfId = null, mode = 'auto', retryMs = 250 } = {}) {
  const pluginsOnly = mode === 'plugins';
  const client = pluginsOnly
    ? { status: 'ok', code: 'plugins', rev: null, changed: [], entries: [], graph: null }
    : refreshClientModules(modules);
  const clientOk = client.status === 'ok';

  if (mode === 'interface') return { ...client, plugins: null };

  const usable = hmr !== null && typeof hmr?.runExclusive === 'function' && typeof hmr?.reconcileProfile === 'function';
  if (!usable) {
    return mergePlugins(client, clientOk ? 'no-hmr' : client.code, clientOk ? 'partial' : client.status, EMPTY_PLUGINS(), 'the hmr service is unavailable');
  }

  let required = [];
  // The snapshot is taken inside the queue: an update queued ahead of this one
  // may already have replaced entries, and judging on the earlier list would
  // report somebody else's change as this refresh's failure.
  const inside = () => {
    const states = entryStates(loader);
    if (states === null) throw new Error('the loader could not be read');
    required = runningIds(states, selfId);
    return hmr.reconcileProfile(required);
  };
  const transaction = transactionOf(hmr);
  const run = () => (transaction === null ? hmr.runExclusive(inside) : transaction.exit(() => hmr.runExclusive(inside)));

  let outcome = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      outcome = await run();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!NESTED_TRANSACTION.test(String(error?.message ?? error))) break;
      // Another reload holds the queue; wait that out rather than reporting a
      // failure the user would answer by pressing the same button again.
      await pause(Math.min(Math.max(retryMs, 0) * (attempt + 1), 1500));
    }
  }

  if (lastError !== null) {
    const reason = describe(lastError);
    return mergePlugins(
      client,
      clientOk ? 'reload-failed' : client.code,
      clientOk ? 'partial' : client.status,
      { ...EMPTY_PLUGINS(), error: reason },
      reason,
    );
  }

  const warnings = Array.isArray(outcome?.warnings) ? outcome.warnings.map(String) : [];
  const pending = Array.isArray(outcome?.pending) ? outcome.pending.map(String) : [];
  const rawRestart = typeof outcome?.restartReason === 'string' && outcome.restartReason !== '' ? outcome.restartReason : null;
  const restartReason = rawRestart;
  // A restart named only because a package maps elsewhere does not stop a page
  // built on the new set: the files that run now are the ones the next page
  // loads. Any other reason does.
  const restartOnly = outcome?.restartOnly === true && pending.length === 0 && rawRestart !== null;

  const states = entryStates(loader);
  const stopped = states === null ? [] : required.filter((id) => states.has(id) && states.get(id) !== RUNNING);
  if (stopped.length > 0) warnings.push('entries that did not come back: ' + stopped.join(', '));

  const plugins = {
    applied: required,
    warnings,
    pending,
    restartReason,
    restartOnly,
    healthReadable: states !== null,
  };

  if (!clientOk) return mergePlugins(client, client.code, client.status, plugins, client.reason);

  if (pending.length > 0) return mergePlugins(client, 'plugins-pending', 'partial', plugins);
  if (restartReason !== null && !restartOnly) return mergePlugins(client, 'plugins-restart', 'partial', plugins);
  if (warnings.length > 0) return mergePlugins(client, 'plugins-partial', 'partial', plugins);
  return mergePlugins(client, client.code, 'ok', plugins);
}
