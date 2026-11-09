/**
 * Keep the Client bundles of the *boot* generation resolvable on the Host.
 *
 * Why this exists. The desktop shell asks the Host for "boot injections" once,
 * when the window is created, and then replays that frozen answer into every
 * later document load (F5, the menu item, or another plugin's reload button).
 * The Client module registry, however, keeps only the current and the previous
 * bundle table: its lookup falls through to a 404 once two rebuilds have
 * happened since that snapshot was taken. A page reload then cannot import the
 * boot bundles, the boot round aborts with "entries did not activate", and the
 * desktop shell treats that as fatal — the app looks crashed.
 *
 * The registry exposes the map it serves from (`responses`), so the fix is
 * additive and local: snapshot the entries of every table we have seen and put
 * any of them back after a rebuild has replaced the map. A retained response is
 * only ever added when the registry does not already have that URL, so a newer
 * generation always wins and no old bytes can shadow new ones.
 *
 * The snapshot lives on `globalThis` on purpose: this plugin's Host half is
 * reloaded in place whenever its files change, and the boot table it protects
 * belongs to the process, not to one module instance.
 */

const KEY = Symbol.for('dsh-workspace-control.boot-bundles');

/** @typedef {{ urls: Map<string, unknown>, pinned: Map<string, unknown>, dispose: null | (() => void), modules: unknown }} Retention */

const isMap = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.get === 'function' &&
  typeof value.has === 'function' &&
  typeof value.set === 'function' &&
  typeof value[Symbol.iterator] === 'function';

/** The process-wide snapshot, created on first use. */
function state() {
  const existing = globalThis[KEY];
  if (existing && isMap(existing.urls)) {
    if (!isMap(existing.pinned)) existing.pinned = new Map();
    return existing;
  }
  const fresh = { urls: new Map(), pinned: new Map(), dispose: null, modules: null };
  globalThis[KEY] = fresh;
  return fresh;
}

/** The registry's served-response map, or `null` when this build has none. */
function responsesOf(modules) {
  const responses = modules && typeof modules === 'object' ? modules.responses : null;
  return isMap(responses) ? responses : null;
}

/**
 * Snapshot the bundles the Host is serving now, and keep doing it.
 *
 * Called once when the plugin starts and again in front of every refresh, so a
 * Host that lost the snapshot (a fresh process) re-learns it before the sweep
 * rebuilds anything.
 *
 * @returns {{ supported: boolean, retained: number }}
 */
export function retainBootBundles(modules) {
  const responses = responsesOf(modules);
  if (responses === null) return { supported: false, retained: 0 };

  const snapshot = state();
  snapshot.modules = modules;
  const remember = (source) => {
    if (!isMap(source)) return;
    for (const [url, response] of source) {
      if (!snapshot.urls.has(url)) snapshot.urls.set(url, response);
    }
  };
  remember(responses);
  remember(modules.previousBatchResponses);

  subscribe(modules, snapshot);

  return { supported: true, retained: snapshot.urls.size };
}

/**
 * One graph listener at a time: a reloaded Host half subscribes again, and the
 * previous subscription belongs to a module instance that no longer exists.
 */
function subscribe(modules, snapshot) {
  if (typeof snapshot.dispose === 'function') {
    try { snapshot.dispose(); } catch { /* the old owner is gone */ }
    snapshot.dispose = null;
  }
  if (typeof modules.onGraphChanged === 'function') {
    try {
      const off = modules.onGraphChanged(() => { restoreBootBundles(modules); });
      snapshot.dispose = typeof off === 'function' ? off : null;
    } catch {
      snapshot.dispose = null;
    }
  }
}

/**
 * Turn a boot-manifest URL into the key the registry serves from.
 *
 * Boot rows are document-relative ("plugins/x.js"), while the registry keys its
 * maps by pathname + search with a leading slash; an absolute URL is reduced to
 * the same key.
 */
export function normalizeBundleUrl(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text === '') return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      return (parsed.pathname + parsed.search) || '';
    } catch {
      return '';
    }
  }
  return text.startsWith('/') ? text : '/' + text;
}

/**
 * Pin exactly the bundles the current page booted from.
 *
 * The shell freezes its boot injections for the lifetime of the window, so a
 * document reload replays that one manifest. Pinning its URLs keeps those very
 * responses resolvable no matter how many rebuilds replaced the tables
 * afterwards. URLs the registry still serves are picked up as-is.
 *
 * @returns {{ supported: boolean, pinned: number, missing: number }}
 */
export function pinBootBundles(modules, urls) {
  const responses = responsesOf(modules);
  if (responses === null) return { supported: false, pinned: 0, missing: 0 };

  const snapshot = state();
  snapshot.modules = modules;
  const sources = [responses, snapshot.urls, modules.previousBatchResponses];
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = normalizeBundleUrl(raw);
    if (url === '') continue;
    // A URL the registry does not serve yet is remembered as unresolved: it keeps
    // the reload unsafe (the page would ask for it again) and a later table that
    // does carry it can still fill it in.
    if (snapshot.pinned.get(url)) continue;
    let response = null;
    for (const map of sources) {
      if (!isMap(map) || !map.has(url)) continue;
      const candidate = map.get(url);
      if (candidate !== null && candidate !== undefined) {
        response = candidate;
        break;
      }
    }
    snapshot.pinned.set(url, response);
  }

  let missing = 0;
  for (const response of snapshot.pinned.values()) if (!response) missing += 1;

  subscribe(modules, snapshot);
  return { supported: true, pinned: snapshot.pinned.size, missing };
}

/**
 * Put snapshot bundles back into the registry's served map.
 *
 * Runs right after every graph change, which is when the registry swapped in a
 * new table and dropped the previous one. Existing URLs are left untouched.
 *
 * @returns {number} how many responses were restored
 */
export function restoreBootBundles(modules = null) {
  const existing = globalThis[KEY];
  if (!existing || !isMap(existing.urls)) return 0;
  const responses = responsesOf(modules ?? existing.modules);
  if (responses === null) return 0;
  let restored = 0;
  const tables = [existing.pinned, existing.urls];
  for (const table of tables) {
    if (!isMap(table)) continue;
    for (const [url, response] of table) {
      if (!response || responses.has(url)) continue;
      responses.set(url, response);
      restored += 1;
    }
  }
  return restored;
}

/**
 * Whether a document load can still resolve the *pinned* boot manifest.
 *
 * This is the precise answer once the Client half has reported its boot URLs:
 * exactly those URLs decide whether a reload is safe. Without any pinned URL
 * (an older Client half) the caller falls back to `bootBundleStatus`.
 *
 * @returns {{ supported: boolean, safe: boolean, pinned: number, missing: number }}
 */
export function pinnedBootStatus(modules) {
  const existing = globalThis[KEY];
  const pinned = existing && isMap(existing.pinned) ? existing.pinned : null;
  const count = pinned === null ? 0 : pinned.size;
  const responses = responsesOf(modules ?? (existing ? existing.modules : null));
  if (pinned === null || count === 0 || responses === null) {
    return { supported: false, safe: false, pinned: count, missing: count };
  }
  let missing = 0;
  for (const [url, response] of pinned) {
    if (!response || !responses.has(url)) missing += 1;
  }
  return { supported: true, safe: missing === 0, pinned: count, missing };
}

/**
 * Whether a document load can still resolve the boot manifest.
 *
 * `safe` is what the Refresh button reports: with a retained set that is still
 * fully served, a page reload is harmless; without one, reloading can abort the
 * boot and must be avoided.
 *
 * @returns {{ safe: boolean, retained: number, missing: number }}
 */
export function bootBundleStatus(modules) {
  const existing = globalThis[KEY];
  const urls = existing && isMap(existing.urls) ? existing.urls : null;
  const retained = urls ? urls.size : 0;
  const responses = responsesOf(modules ?? (existing ? existing.modules : null));
  if (urls === null || retained === 0 || responses === null) {
    return { safe: false, retained, missing: retained };
  }
  let missing = 0;
  for (const url of urls.keys()) if (!responses.has(url)) missing += 1;
  return { safe: missing === 0, retained, missing };
}
