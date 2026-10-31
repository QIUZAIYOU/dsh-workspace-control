import './env.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadClient } from './contract.test.js';

/**
 * The panel must report the same running state as the sidebar.
 *
 * The sidebar decides a session's activity with
 * `useSessionStatus().get(id)?.running ?? useSessions().byId[id]?.running`
 * (verified in the shipped bundle), so these two helpers are the only place
 * where the panel may form an opinion about a session.
 */

const plain = (value) => JSON.parse(JSON.stringify(value));

const reader = (statuses, byId) => {
  const props = {
    useSessionStatus: (selector) => selector(statuses),
    useSessions: (selector) => selector({ byId }),
  };
  return props;
};

/** Read the live status function the bundle exposes for tests. */
async function helpers() {
  const { modes } = await loadClient();
  assert.ok(modes.testables, 'the bundle exposes its status helpers');
  return modes.testables;
}

test('the live status map wins over the cached summary row', async () => {
  const { liveRunReader } = await helpers();
  const read = liveRunReader(reader(new Map([['s1', { running: false }]]), { s1: { running: true } }));
  assert.equal(read('s1'), false);
});

test('a session missing from the map falls back to the summary row', async () => {
  const { liveRunReader } = await helpers();
  const read = liveRunReader(reader(new Map(), { s1: { running: true } }));
  assert.equal(read('s1'), true);
});

test('an unknown session reads as unknown, not as idle', async () => {
  const { liveRunReader } = await helpers();
  const read = liveRunReader(reader(new Map(), {}));
  assert.equal(read('s1'), null);
});

test('hosts without the status hooks still produce a reader', async () => {
  const { liveRunReader } = await helpers();
  const read = liveRunReader(undefined);
  assert.equal(read('s1'), null);
});

test('a session the app only has open stops being a blocker', async () => {
  const { reconcileEntry } = await helpers();
  const entry = {
    id: 'w1',
    running: 1,
    open: 0,
    blocked: true,
    blockedTotal: 1,
    blockers: [{ id: 's1', title: 'ce', running: true, open: false }],
  };
  const row = reconcileEntry(entry, (id) => (id === 's1' ? false : null));
  assert.equal(row.blocked, false, 'an idle session must not grey out the buttons');
  assert.equal(row.running, 0);
  assert.equal(row.open, 1);
  assert.deepEqual(plain(row.blockers), [{ id: 's1', title: 'ce', running: false, open: true }]);
});

test('a session the client calls running becomes a blocker', async () => {
  const { reconcileEntry } = await helpers();
  const entry = {
    id: 'w1',
    running: 0,
    open: 1,
    blocked: true,
    blockedTotal: 1,
    blockers: [{ id: 's1', title: 'ce', running: false, open: true }],
  };
  const row = reconcileEntry(entry, () => true);
  assert.equal(row.blocked, true);
  assert.equal(row.running, 1);
  assert.equal(row.open, 0);
});

test('when the client says nothing, the host verdict stands', async () => {
  const { reconcileEntry } = await helpers();
  const entry = {
    id: 'w1',
    running: 1,
    open: 0,
    blocked: true,
    blockedTotal: 1,
    blockers: [{ id: 's1', title: 'ce', running: true, open: false }],
  };
  const row = reconcileEntry(entry, () => null);
  assert.equal(row.blocked, true);
  assert.equal(row.running, 1);
});

test('sessions past the host cap keep the host counts as a floor', async () => {
  const { reconcileEntry } = await helpers();
  const entry = {
    id: 'w1',
    running: 3,
    open: 5,
    blocked: true,
    blockedTotal: 8,
    blockers: [{ id: 's1', title: 'ce', running: true, open: false }],
  };
  const row = reconcileEntry(entry, () => false);
  assert.equal(row.running, 3, 'the seven unlisted sessions still count');
  assert.equal(row.open, 5);
  assert.equal(row.blocked, true);
});
