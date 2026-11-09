/**
 * The desktop shell replays ONE frozen boot manifest into every later document
 * load, while the Client module registry keeps only the current and the previous
 * bundle table. retain.js snapshots the boot generation and puts it back after a
 * rebuild, which is what keeps F5 from aborting the next boot. These tests drive
 * the retention against a fake registry that rotates its table exactly the way
 * the real one does.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootBundleStatus,
  normalizeBundleUrl,
  pinBootBundles,
  pinnedBootStatus,
  retainBootBundles,
  restoreBootBundles,
} from '../retain.js';

const KEY = Symbol.for('dsh-workspace-control.boot-bundles');
const forget = () => { delete globalThis[KEY]; };

/** A registry-shaped fake: `responses` is what it serves, and it rotates. */
function fakeModules(served, previous = {}) {
  const modules = {
    responses: new Map(Object.entries(served)),
    previousBatchResponses: new Map(Object.entries(previous)),
    listeners: new Set(),
    onGraphChanged(listener) {
      modules.listeners.add(listener);
      return () => modules.listeners.delete(listener);
    },
    rotate(next) {
      modules.previousBatchResponses = modules.responses;
      modules.responses = new Map(Object.entries(next));
      for (const listener of modules.listeners) listener();
    },
  };
  return modules;
}

test('boot bundles stay served after the registry rotates its table', () => {
  forget();
  const modules = fakeModules({ '/boot/a.js': 'a-v1' });
  assert.deepEqual(retainBootBundles(modules), { supported: true, retained: 1 });

  modules.rotate({ '/boot/b.js': 'b-v1' });
  // The previous table is still served by the registry itself, so nothing needs
  // restoring yet; the boot URL of two rotations ago is what matters.
  modules.rotate({ '/boot/c.js': 'c-v1' });
  assert.equal(modules.responses.has('/boot/a.js'), true);
  assert.equal(modules.responses.get('/boot/a.js'), 'a-v1');
  assert.deepEqual(bootBundleStatus(modules), { safe: true, retained: 1, missing: 0 });
});

test('a rebuild that reuses a URL and its new bytes always wins', () => {
  forget();
  const modules = fakeModules({ '/boot/a.js': 'a-v1' });
  retainBootBundles(modules);
  modules.rotate({ '/boot/a.js': 'a-v2' });
  assert.equal(modules.responses.get('/boot/a.js'), 'a-v2');
  assert.deepEqual(bootBundleStatus(modules), { safe: true, retained: 1, missing: 0 });
  assert.equal(restoreBootBundles(modules), 0);
});

test('a build without a served-response map degrades instead of throwing', () => {
  forget();
  assert.deepEqual(retainBootBundles({}), { supported: false, retained: 0 });
  assert.deepEqual(retainBootBundles(null), { supported: false, retained: 0 });
  assert.deepEqual(retainBootBundles({ responses: [] }), { supported: false, retained: 0 });
  assert.deepEqual(bootBundleStatus({}), { safe: false, retained: 0, missing: 0 });
  assert.equal(restoreBootBundles({}), 0);
});

test('the snapshot is taken from the previous table too', () => {
  forget();
  const modules = fakeModules({ '/boot/new.js': 'n' }, { '/boot/old.js': 'o' });
  assert.equal(retainBootBundles(modules).retained, 2);
  modules.rotate({ '/boot/newer.js': 'x' });
  modules.rotate({ '/boot/newest.js': 'y' });
  assert.equal(modules.responses.has('/boot/old.js'), true);
});

test('re-installing on a reloaded Host keeps exactly one listener', () => {
  forget();
  const modules = fakeModules({ '/boot/a.js': 'a' });
  retainBootBundles(modules);
  retainBootBundles(modules);
  assert.equal(modules.listeners.size, 1);
  modules.rotate({ '/boot/b.js': 'b' });
  modules.rotate({ '/boot/c.js': 'c' });
  assert.equal(modules.responses.has('/boot/a.js'), true);
});

test('pinning keeps exactly the URLs the page booted from', () => {
  forget();
  const modules = fakeModules({ '/boot/a.js': 'a-v1', '/boot/b.js': 'b-v1' });
  retainBootBundles(modules);
  assert.deepEqual(pinBootBundles(modules, ['/boot/a.js', 'boot/b.js']), {
    supported: true,
    pinned: 2,
    missing: 0,
  });
  assert.deepEqual(pinnedBootStatus(modules), { supported: true, safe: true, pinned: 2, missing: 0 });
  // Two rotations: only the pinned pair may be brought back, not the whole table.
  modules.rotate({ '/boot/c.js': 'c-v1' });
  modules.rotate({ '/boot/d.js': 'd-v1' });
  assert.equal(modules.responses.has('/boot/a.js'), true);
  assert.equal(modules.responses.has('/boot/b.js'), true);
  assert.equal(modules.responses.has('/boot/c.js'), false);
});

test('an unknown boot URL is counted, never silently pinned', () => {
  forget();
  const modules = fakeModules({ '/boot/a.js': 'a-v1' });
  retainBootBundles(modules);
  assert.deepEqual(pinBootBundles(modules, ['/boot/a.js', '/boot/gone.js']), {
    supported: true,
    pinned: 2,
    missing: 1,
  });
  assert.deepEqual(pinnedBootStatus(modules), { supported: true, safe: false, pinned: 2, missing: 1 });
});

test('a pinned URL is restored after a rebuild that dropped it', () => {
  forget();
  const modules = fakeModules({ '/boot/a.js': 'a-v1' });
  pinBootBundles(modules, ['/boot/a.js']);
  modules.rotate({ '/boot/b.js': 'b-v1' });
  modules.rotate({ '/boot/c.js': 'c-v1' });
  assert.equal(modules.responses.get('/boot/a.js'), 'a-v1');
  assert.deepEqual(pinnedBootStatus(modules), { supported: true, safe: true, pinned: 1, missing: 0 });
});

test('a newer generation that reuses a pinned URL still wins', () => {
  forget();
  const modules = fakeModules({ '/boot/a.js': 'a-v1' });
  pinBootBundles(modules, ['/boot/a.js']);
  modules.rotate({ '/boot/a.js': 'a-v2' });
  assert.equal(modules.responses.get('/boot/a.js'), 'a-v2');
  assert.equal(restoreBootBundles(modules), 0);
});

test('boot URLs are normalized to the Host key shape', () => {
  assert.equal(normalizeBundleUrl('boot/a.js'), '/boot/a.js');
  assert.equal(normalizeBundleUrl('  /boot/a.js  '), '/boot/a.js');
  assert.equal(normalizeBundleUrl('dsh-app://app/plugins/a.js?rev=1'), '/plugins/a.js?rev=1');
  assert.equal(normalizeBundleUrl(''), '');
});

test('a build that cannot pin reports unsupported instead of guessing', () => {
  forget();
  assert.deepEqual(pinBootBundles({}, ['/boot/a.js']), { supported: false, pinned: 0, missing: 0 });
  assert.deepEqual(pinnedBootStatus({}), { supported: false, safe: false, pinned: 0, missing: 0 });
});

test('status reports a missing boot URL instead of assuming the listener ran', () => {
  forget();
  const modules = fakeModules({ '/boot/a.js': 'a' });
  retainBootBundles(modules);
  // A table swap without a notification is exactly the case the listener exists
  // for; the status must still be honest if that never happened.
  modules.responses = new Map();
  assert.deepEqual(bootBundleStatus(modules), { safe: false, retained: 1, missing: 1 });
});
