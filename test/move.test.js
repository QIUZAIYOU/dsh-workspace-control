/**
 * The move transaction, driven through the public service method.
 *
 * Each test asserts both the reported code *and* the state of the session layout
 * afterwards: a refusal must never lose the original, and a failure must never
 * leave a second artifact behind.
 */

import './env.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, rm, stat as fsStat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { WorkspaceControl } from '../index.js';
import {
  makeAgent,
  makeContext,
  makeHarnessHome,
  makePersistence,
  makeRegistry,
  summary,
} from './fakes.js';

const SESSION = 'session-1111';

const events = [
  { type: 'session/start', seq: 0, data: {} },
  { type: 'turn/start', seq: 1, data: {} },
  { type: 'turn/end', seq: 2, data: {} },
];

let harness;

beforeEach(async () => {
  harness = await makeHarnessHome();
  await rm(process.env.WSC_PENDING_PATH, { force: true });
});

afterEach(async () => {
  await harness.cleanup();
});

async function setup({ faults = {}, summaries = [], agents = [] } = {}) {
  const persistence = makePersistence({ home: harness.home, faults });
  const registry = makeRegistry();
  const origin = join(harness.home, 'origin');
  const target = join(harness.home, 'target');
  await mkdir(origin, { recursive: true });
  await mkdir(target, { recursive: true });
  await persistence.seed(SESSION, origin, events);
  await persistence.stat(SESSION);
  const workspace = await registry.create(origin);
  await workspace.attachSession(SESSION);
  const ctx = makeContext({ persistence, registry, summaries, agents });
  const service = new WorkspaceControl(ctx);
  return { persistence, registry, service, origin, target, workspace };
}

/** Every `session.v9.jsonl` in the layout, so a test can assert "exactly once". */
async function artifacts() {
  const roots = [join(harness.home, 'sessions')];
  const found = [];
  for (const root of roots) {
    let projects = [];
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const project of projects) {
      const sessions = await readdir(join(root, project.name));
      for (const session of sessions) {
        found.push(join(root, project.name, session));
      }
    }
  }
  return found;
}

/** Directory entries under every project bucket of the temporary session root. */
async function storeNames() {
  const root = join(harness.home, 'sessions');
  const names = [];
  for (const bucket of await readdir(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    for (const entry of await readdir(join(root, bucket.name))) names.push(entry);
  }
  return names;
}

/** Whether a path exists, without caring why it might not. */
async function exists(path) {
  try {
    await fsStat(path);
    return true;
  } catch {
    return false;
  }
}

test('a clean move republishes the events under the target directory', async () => {
  const { persistence, service, target } = await setup();
  const result = await service.move(SESSION, target);

  assert.equal(result.status, 'moved');
  assert.equal(result.code, 'moved');
  assert.equal(result.newCwd, target);
  assert.equal(result.events, events.length);
  assert.deepEqual(persistence.store.get(SESSION).header.cwd, target);
  assert.deepEqual(
    persistence.store.get(SESSION).events.map((event) => event.seq),
    [0, 1, 2],
  );
  assert.equal((await artifacts()).length, 1, 'exactly one artifact on disk');
});

test('a held session is queued for the next boot instead of refused', async () => {
  const { persistence, service, origin, target } = await setup({
    summaries: [summary(SESSION, { agentAvailable: true })],
    agents: [makeAgent(SESSION)],
  });
  const result = await service.move(SESSION, target);

  assert.equal(result.code, 'held-restart');
  assert.equal(result.status, 'error');
  assert.equal(result.queued, true, 'the intent survives the refusal');
  assert.equal(result.canRestart, true, 'the caller may finish it by restarting');
  assert.equal(result.effectState, 'none');
  assert.equal(persistence.store.get(SESSION).header.cwd, origin, 'nothing was touched');
});

test('a queued move finishes at boot once the holder is gone', async () => {
  const holder = await setup({
    summaries: [summary(SESSION, { agentAvailable: true })],
    agents: [makeAgent(SESSION)],
  });
  const queued = await holder.service.move(SESSION, holder.target);
  assert.equal(queued.code, 'held-restart');

  // Next process: same layout, no holder. The boot pass replays the move.
  const boot = await setup();
  const outcomes = await boot.service.resumePending();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].kind, 'move');
  assert.equal(outcomes[0].code, 'moved');
  assert.equal(boot.persistence.store.get(SESSION).header.cwd, boot.target);
});

test('a turn in flight is refused without touching the file', async () => {
  const { persistence, service, target } = await setup({ summaries: [summary(SESSION, { running: true })] });
  const before = persistence.store.get(SESSION).header.cwd;
  const result = await service.move(SESSION, target);

  assert.equal(result.code, 'running');
  assert.equal(result.status, 'error');
  assert.equal(result.effectState, 'none');
  assert.equal(persistence.store.get(SESSION).header.cwd, before);
});

test('a header-only session is refused instead of deleted', async () => {
  const { persistence, registry, service, origin, target } = await setup();
  await persistence.seed(SESSION, origin, []);
  const ctx = makeContext({ persistence, registry });
  const empty = new WorkspaceControl(ctx);
  const result = await empty.move(SESSION, target);
  assert.equal(result.code, 'empty-log');
  assert.equal(persistence.store.get(SESSION).events.length, 0);
  assert.equal((await artifacts()).length, 1);
});

test('a failing publish rolls the original back', async () => {
  const { persistence, service, target } = await setup({ faults: { createThrows: true } });
  const result = await service.move(SESSION, target);

  assert.equal(result.code, 'write-failed');
  assert.match(result.message, /rolled back/);
  assert.deepEqual(persistence.store.get(SESSION).header.cwd, join(harness.home, 'origin'));
  assert.equal((await artifacts()).length, 1, 'the original is back and nothing else remains');
});

test('a successor that reads back short is discarded, not trusted', async () => {
  const { persistence, service, target } = await setup({ faults: { truncate: true } });
  const result = await service.move(SESSION, target);

  assert.equal(result.code, 'verify-failed');
  assert.match(result.message, /did not match/);
  assert.equal((await artifacts()).length, 1, 'the original was restored and the short copy discarded');
});

test('a store that still lists the parked id is reported instead of guessed', async () => {
  const { service, target } = await setup({ faults: { keepStat: true } });
  const result = await service.move(SESSION, target);
  assert.equal(result.code, 'store-cached');
  assert.equal((await artifacts()).length, 1);
});

test('the same move twice only repairs membership', async () => {
  const { persistence, service, target } = await setup();
  const baseline = persistence.published;
  const first = await service.move(SESSION, target);
  assert.equal(first.code, 'moved');
  const second = await service.move(SESSION, target);
  assert.equal(second.code, 'attached', 'the repair path, not a second publish');
  assert.equal(persistence.published - baseline, 1, 'exactly one publish for the move itself');
});

test('a relative target and a missing target are refused', async () => {
  const { service, target } = await setup();
  assert.equal((await service.move(SESSION, 'relative/path')).code, 'not-absolute');
  assert.equal((await service.move(SESSION, join(target, 'nope'))).code, 'missing-target');
});

test('a second concurrent move of the same session is refused', async () => {
  const { service, target } = await setup();
  const [first, second] = await Promise.all([service.move(SESSION, target), service.move(SESSION, target)]);
  const codes = [first.code, second.code].sort();
  assert.deepEqual(codes, ['busy', 'moved']);
});

/* The parking and membership regressions: DSH 0.2.2 derives a session's
   identity from its stored path and filters workspace membership through a
   path index. A copy parked inside the store fails the whole listing, and an
   id the index does not account for is pruned on every write. */

test('a move never parks a copy inside the session store', async () => {
  const { service, target } = await setup();
  assert.equal((await service.move(SESSION, target)).code, 'moved');
  const parked = (await storeNames()).filter((name) => name.includes('.workspace-control-parked-'));
  assert.deepEqual(parked, [], 'the copy must live outside the store');
});

test('a rolled-back move leaves no parked copy inside the session store', async () => {
  const { service, target } = await setup({ faults: { createThrows: true } });
  assert.equal((await service.move(SESSION, target)).code, 'write-failed');
  const parked = (await storeNames()).filter((name) => name.includes('.workspace-control-parked-'));
  assert.deepEqual(parked, []);
});

test('a legacy parked copy is moved out of the store, not read as a session', async () => {
  const { persistence, service } = await setup({ faults: { poisonedByParked: true } });
  const root = join(harness.home, 'sessions');
  const bucket = (await readdir(root))[0];
  const canonical = join(root, bucket, SESSION);
  const leftover = canonical + '.workspace-control-parked-test';
  await mkdir(leftover, { recursive: true });
  await writeFile(join(leftover, 'session.v9.jsonl'), '{"type":"session"}', 'utf8');

  await assert.rejects(() => persistence.list(), /corrupt session log/);

  const recovered = await service.sweepParked();
  assert.deepEqual(recovered.map((entry) => entry.action), ['discarded']);
  assert.equal(await exists(leftover), false, 'the stray copy no longer sits in the store');
  assert.equal((await persistence.list()).length, 1, 'the store lists normally again');
});

test('a legacy parked copy is restored when it is the only copy', async () => {
  const { persistence, service } = await setup({ faults: { poisonedByParked: true } });
  const root = join(harness.home, 'sessions');
  const bucket = (await readdir(root))[0];
  const canonical = join(root, bucket, SESSION);
  const leftover = canonical + '.workspace-control-parked-test';
  await rename(canonical, leftover);
  assert.equal(await persistence.present(SESSION), false);

  const recovered = await service.sweepParked();
  assert.deepEqual(recovered.map((entry) => entry.action), ['restored']);
  assert.equal(await persistence.present(SESSION), true);
});

test('a rollback keeps the session listed in the workspace it returns to', async () => {
  const { registry, service, origin, target } = await setup();
  assert.equal((await service.move(SESSION, target)).code, 'moved');
  const back = await service.move(SESSION, origin);
  assert.equal(back.code, 'moved');
  const workspace = await registry.resolveByPath(origin);
  assert.ok(workspace.sessionIds.includes(SESSION), 'membership survives the rollback');
});

test('a pending attach settles a membership the path index had pruned', async () => {
  const { registry, service, origin } = await setup();
  registry.sessionPaths.set(SESSION, 'D:\\elsewhere');
  const pendingPath = process.env.WSC_PENDING_PATH;
  await writeFile(
    pendingPath,
    JSON.stringify([{ sessionId: SESSION, target: origin, at: new Date().toISOString() }]),
    'utf8',
  );

  const outcomes = await service.resumePending();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].attached, true);
  assert.ok((await registry.resolveByPath(origin)).sessionIds.includes(SESSION));
  assert.equal(await exists(pendingPath), false, 'the settled membership leaves the queue');
});
