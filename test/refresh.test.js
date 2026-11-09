/**
 * The refresh decision and the republish sweep are the parts that must be right
 * before anything is clicked: a wrong decision reloads the desktop document
 * against a stale boot manifest, which is exactly the failure this feature
 * exists to avoid. No browser needed — both are pure.
 */

import './env.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { AsyncLocalStorage } from 'node:async_hooks';

import { decideRefreshAction, refreshClientModules, refreshWithHmr } from '../refresh.js';

/* ------------------------------------------------------------------ decisions */

test('a plain web page always reloads: its index is rendered per request', () => {
  assert.deepEqual(
    decideRefreshAction({ isDesktop: false, bootRev: 'a', liveRev: 'b', changed: ['x'] }),
    { action: 'reload', reason: 'web' },
  );
});

test('a republished bundle is hot-synced on the desktop: only the page knows its boot pin', () => {
  assert.deepEqual(
    decideRefreshAction({ isDesktop: true, bootRev: 'a', liveRev: 'a', changed: ['dsh-workspace-control'] }),
    { action: 'sync', reason: 'changed' },
  );
});

test('a boot snapshot behind the live graph forbids a reload', () => {
  assert.deepEqual(decideRefreshAction({ isDesktop: true, bootRev: 'a', liveRev: 'b', changed: [] }), {
    action: 'sync',
    reason: 'stale-boot',
  });
});

test('a current graph is synced too, because the Host alone can never reload', () => {
  assert.deepEqual(decideRefreshAction({ isDesktop: true, bootRev: 'same', liveRev: 'same', changed: [] }), {
    action: 'sync',
    reason: 'current',
  });
});

test('no desktop graph state alone produces a document reload', () => {
  const states = [
    { bootRev: 'same', liveRev: 'same', changed: [] },
    { bootRev: 'a', liveRev: 'b', changed: [] },
    { bootRev: 'a', liveRev: 'b', changed: ['x', 'y'] },
    { bootRev: null, liveRev: null, changed: [] },
    { bootRev: '', liveRev: 'a', changed: [] },
    { bootRev: 'a', liveRev: undefined, changed: 'nope' },
  ];
  for (const state of states) {
    assert.notEqual(decideRefreshAction({ isDesktop: true, ...state }).action, 'reload');
  }
});

test('a missing revision is never proof enough to reload', () => {
  for (const input of [
    { isDesktop: true, bootRev: null, liveRev: null, changed: [] },
    { isDesktop: true, bootRev: 'a', liveRev: null, changed: [] },
    { isDesktop: true, bootRev: undefined, liveRev: 'a', changed: [] },
    { isDesktop: true, bootRev: '', liveRev: 'a', changed: [] },
  ]) {
    assert.deepEqual(decideRefreshAction(input), { action: 'sync', reason: 'unknown' });
  }
});

test('a malformed payload cannot turn into a reload', () => {
  assert.deepEqual(decideRefreshAction(undefined), { action: 'sync', reason: 'unknown' });
  assert.deepEqual(decideRefreshAction({ isDesktop: true, changed: 'nope' }), { action: 'sync', reason: 'unknown' });
});

/* -------------------------------------------------------------------- sweeps */

/**
 * A stand-in for the Host's ClientModuleRegistry.
 *
 * `rebuilt` returns the revision it computed — the real one recomposes only
 * when the bytes changed and returns the old revision otherwise — so a sweep
 * is observable entirely through its return value.
 */
function registry({ entries, revisions = {}, external = [], throws = [] }) {
  const calls = [];
  return {
    calls,
    graph: () => ({ rev: 'graph-1', entries }),
    artifactBaseline: (id) => (external.includes(id) ? undefined : { path: '/tmp/' + id + '.js' }),
    rebuilt(id) {
      calls.push(id);
      if (throws.includes(id)) throw new Error('unreadable ' + id);
      return revisions[id] ?? (entries.find((entry) => entry.id === id)?.rev ?? null);
    },
  };
}

test('unchanged bundles report unchanged and change nothing', () => {
  const modules = registry({
    entries: [
      { id: 'alpha', rev: 'r1' },
      { id: 'beta', rev: 'r1' },
    ],
  });
  const result = refreshClientModules(modules);
  assert.equal(result.status, 'ok');
  assert.equal(result.code, 'unchanged');
  assert.deepEqual(result.changed, []);
  assert.equal(result.rev, 'graph-1');
  assert.deepEqual(modules.calls, ['alpha', 'beta']);
});

test('a new revision is reported by id and the graph is passed through', () => {
  const modules = registry({
    entries: [
      { id: 'alpha', rev: 'r1' },
      { id: 'beta', rev: 'r1' },
    ],
    revisions: { beta: 'r2' },
  });
  const result = refreshClientModules(modules);
  assert.equal(result.code, 'refreshed');
  assert.deepEqual(result.changed, ['beta']);
  assert.equal(result.graph.rev, 'graph-1');
  assert.deepEqual(result.entries, [
    { id: 'alpha', rev: 'r1' },
    { id: 'beta', rev: 'r1' },
  ]);
});

test('an unavailable registry is reported, not guessed at', () => {
  for (const value of [null, undefined, {}, { graph: 'nope' }]) {
    const result = refreshClientModules(value);
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'unsupported');
    assert.deepEqual(result.changed, []);
  }
});

test('a registry that cannot be read never throws at the caller', () => {
  const result = refreshClientModules({ graph: () => { throw new Error('boom'); } });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'unreadable');
  assert.match(result.reason, /boom/);
});

test('one unreadable bundle does not abort the sweep', () => {
  const modules = registry({
    entries: [
      { id: 'alpha', rev: 'r1' },
      { id: 'beta', rev: 'r1' },
    ],
    revisions: { beta: 'r2' },
    throws: ['alpha'],
  });
  const result = refreshClientModules(modules);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.changed, ['beta']);
});

test('entries without a local artifact are skipped', () => {
  const modules = registry({
    entries: [
      { id: 'alpha', rev: 'r1' },
      { id: 'external', rev: 'r1' },
    ],
    external: ['external'],
  });
  const result = refreshClientModules(modules);
  assert.deepEqual(modules.calls, ['alpha']);
  assert.equal(result.code, 'unchanged');
});

/* ------------------------------------------------------- host plugin reload */

const loaderWith = (states) => ({
  entries: () => Object.entries(states).map(([id, state]) => ({ options: { id }, fiber: { state } })),
});

function fakeHmr({ result = { warnings: [], pending: [] }, fail = null, nested = 0 } = {}) {
  const calls = { exclusive: 0, reconcile: [], nested: 0 };
  return {
    calls,
    async runExclusive(run) {
      calls.exclusive += 1;
      if (calls.nested < nested) {
        calls.nested += 1;
        throw new Error('transactions cannot be nested');
      }
      return run();
    },
    async reconcileProfile(ids) {
      calls.reconcile.push(ids);
      if (fail) throw fail;
      return result;
    },
  };
}

test('plugin code is reconciled with every running entry except this plugin', async () => {
  const hmr = fakeHmr();
  const result = await refreshWithHmr({
    hmr,
    loader: loaderWith({ alpha: 2, beta: 2, sleepy: 0, 'dsh-workspace-control': 2 }),
    modules: registry({ entries: [{ id: 'alpha', rev: 'r1' }] }),
    selfId: 'dsh-workspace-control',
  });
  assert.deepEqual(hmr.calls.reconcile, [['alpha', 'beta']]);
  assert.deepEqual(result.plugins.applied, ['alpha', 'beta']);
  assert.equal(result.status, 'ok');
  assert.equal(result.code, 'unchanged');
  assert.equal(result.plugins.healthReadable, true);
});

test('a build without the hmr service says so and still republishes', async () => {
  const result = await refreshWithHmr({
    hmr: null,
    loader: loaderWith({ alpha: 2 }),
    modules: registry({ entries: [{ id: 'alpha', rev: 'r1' }], revisions: { alpha: 'r2' } }),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.code, 'no-hmr');
  assert.equal(result.reason, 'the hmr service is unavailable');
  assert.deepEqual(result.changed, ['alpha']);
  assert.deepEqual(result.plugins.applied, []);
});

test('a busy queue is waited out instead of reported as a failure', async () => {
  const hmr = fakeHmr({ nested: 2 });
  const result = await refreshWithHmr({
    hmr,
    loader: loaderWith({ alpha: 2 }),
    modules: registry({ entries: [{ id: 'alpha', rev: 'r1' }] }),
    retryMs: 0,
  });
  assert.equal(hmr.calls.nested, 2);
  assert.equal(hmr.calls.exclusive, 3);
  assert.equal(result.status, 'ok');
});

test('the transaction is left when the service keeps one', async () => {
  const hmr = fakeHmr();
  let exited = 0;
  hmr.executing = { exit: async (run) => { exited += 1; return run(); } };
  const result = await refreshWithHmr({
    hmr,
    loader: loaderWith({ alpha: 2 }),
    modules: registry({ entries: [{ id: 'alpha', rev: 'r1' }] }),
  });
  assert.equal(exited, 1);
  assert.equal(result.status, 'ok');
});

test('a failed reconcile is reported while the interface result survives', async () => {
  const result = await refreshWithHmr({
    hmr: fakeHmr({ fail: new Error('cannot reconcile: locked') }),
    loader: loaderWith({ alpha: 2 }),
    modules: registry({ entries: [{ id: 'alpha', rev: 'r1' }], revisions: { alpha: 'r2' } }),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.code, 'reload-failed');
  assert.match(result.reason, /locked/);
  assert.deepEqual(result.changed, ['alpha']);
  assert.deepEqual(result.plugins.applied, []);
});

test('an unreadable loader is a failure, not a silent success', async () => {
  const result = await refreshWithHmr({
    hmr: fakeHmr(),
    loader: null,
    modules: registry({ entries: [{ id: 'alpha', rev: 'r1' }] }),
  });
  assert.equal(result.code, 'reload-failed');
  assert.match(result.reason, /loader could not be read/);
});

test('a restart-only remap does not stop the page from syncing', async () => {
  const result = await refreshWithHmr({
    hmr: fakeHmr({ result: { warnings: [], pending: [], restartReason: 'dsh-ops maps elsewhere', restartOnly: true } }),
    loader: loaderWith({ alpha: 2 }),
    modules: registry({ entries: [{ id: 'alpha', rev: 'r1' }] }),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.plugins.restartReason, 'dsh-ops maps elsewhere');
  assert.equal(result.plugins.restartOnly, true);
});

test('a restart reason that is not only a remap is warned about', async () => {
  const result = await refreshWithHmr({
    hmr: fakeHmr({ result: { warnings: [], pending: [], restartReason: 'a package changed its peer set' } }),
    loader: loaderWith({ alpha: 2 }),
    modules: registry({ entries: [{ id: 'alpha', rev: 'r1' }] }),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.code, 'plugins-restart');
  assert.equal(result.plugins.restartOnly, false);
});

test('pending entries are reported as partial', async () => {
  const result = await refreshWithHmr({
    hmr: fakeHmr({ result: { warnings: [], pending: ['beta'] } }),
    loader: loaderWith({ alpha: 2, beta: 2 }),
    modules: registry({ entries: [{ id: 'alpha', rev: 'r1' }] }),
  });
  assert.equal(result.code, 'plugins-pending');
  assert.deepEqual(result.plugins.pending, ['beta']);
});

test('an entry that stopped is added to the warnings', async () => {
  let call = 0;
  const result = await refreshWithHmr({
    hmr: fakeHmr(),
    loader: {
      entries: () => {
        call += 1;
        // Running before the reconcile, stopped after it.
        const state = call === 1 ? 2 : 0;
        return [
          { options: { id: 'alpha' }, fiber: { state } },
          { options: { id: 'beta' }, fiber: { state: 2 } },
        ];
      },
    },
    modules: registry({ entries: [{ id: 'alpha', rev: 'r1' }] }),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.code, 'plugins-partial');
  assert.deepEqual(result.plugins.warnings, ['entries that did not come back: alpha']);
});

test('interface-only mode never touches the hmr service', async () => {
  const hmr = fakeHmr();
  const result = await refreshWithHmr({ hmr, loader: loaderWith({ alpha: 2 }), mode: 'interface' });
  assert.equal(hmr.calls.exclusive, 0);
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'unsupported');
  assert.equal(result.plugins, null);
});

test('plugins-only mode reports the reload without the client table', async () => {
  const result = await refreshWithHmr({ hmr: fakeHmr(), loader: loaderWith({ alpha: 2 }), mode: 'plugins' });
  assert.equal(result.code, 'plugins');
  assert.deepEqual(result.plugins.applied, ['alpha']);
  assert.deepEqual(result.changed, []);
});
