/**
 * The panel is a pure function of the store plus the two live status hooks, so
 * it can be rendered in a VM without a DOM: every element is a plain object.
 *
 * These tests pin the parts a redesign can silently break — the skeleton while
 * the first read is in flight, the card grid once it lands, and the rule that a
 * workspace with a *running* session disables its actions while a workspace that
 * is merely *open* stays clickable.
 */

import './env.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROWS = [
  {
    id: 'w1',
    title: 'alpha',
    path: 'D:\\alpha',
    sessions: 2,
    exists: true,
    running: 1,
    open: 0,
    blocked: true,
    blockers: [{ id: 'session-a', running: true, title: null }],
    blockedTotal: 1,
  },
  {
    id: 'w2',
    title: 'beta',
    path: 'D:\\beta',
    sessions: 1,
    exists: true,
    running: 0,
    open: 1,
    blocked: false,
    blockers: [{ id: 'session-b', running: false, title: null }],
    blockedTotal: 1,
  },
];

/** Every element carries `props` and `children`, so the tree is walkable. */
const nodes = (tree) => {
  const found = [];
  const visit = (node) => {
    if (node === null || node === undefined || node === false || typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    found.push(node);
    node.children.forEach(visit);
  };
  visit(tree);
  return found;
};

const byClass = (tree, className) =>
  nodes(tree).filter((node) => String(node.props.className || '').split(/\s+/).includes(className));

const textOf = (node) => {
  const parts = [];
  const visit = (child) => {
    if (typeof child === 'string') parts.push(child);
    else if (Array.isArray(child)) child.forEach(visit);
    else if (child && Array.isArray(child.children)) child.children.forEach(visit);
  };
  (node.children || []).forEach(visit);
  return parts.join('').trim();
};

async function mountPanel(workspaces) {
  const source = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');
  const registrations = [];
  const styles = [];
  const pending = [];
  let entry = null;

  const createElement = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(),
  });
  const require = (name) => {
    if (name !== 'react') throw new Error(`unexpected require: ${name}`);
    return {
      createElement,
      useEffect: (callback) => pending.push(callback),
      useRef: () => ({ current: null }),
      useState: (initial) => [initial, () => {}],
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    };
  };

  const namespace = {
    listWorkspaces: async () => ({ ok: true, value: { status: 'ok', workspaces } }),
  };
  const document = {
    head: { appendChild: (node) => styles.push(node.textContent || '') },
    createElement: () => ({ textContent: '' }),
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    querySelectorAll: () => [],
  };
  const sandbox = {
    window: { location: { reload() {} }, __ModuleLoader__: { load: (loaded) => (entry = loaded) } },
    document,
    navigator: { language: 'zh-CN' },
    console,
    setTimeout,
    clearTimeout,
    require,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(entry, 'the bundle must call __ModuleLoader__.load');

  const ctx = {
    remote: { async $mount() { return {}; } },
    slots: {
      inject: (_name, register) => register(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    locale: { register: () => () => {}, getLocale: () => ({ active: 'zh' }) },
    effect: (callback) => callback(),
    get: (key) => (key === 'remote.workspaceControl' ? namespace : undefined),
    inject: () => {},
  };

  const modes = entry.factory(require);
  modes.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const panel = registrations.find((each) => each.options.name === 'main');
  assert.ok(panel, 'the panel mounts into the main slot');

  /** Run the effects the last render queued, then let the read settle. */
  const flush = async () => {
    const run = pending.splice(0, pending.length);
    run.forEach((callback) => callback());
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { component: panel.component, registrations, flush, styles };
}

const props = { t: (key) => key };

test('the first render is a skeleton grid, not an empty state', async () => {
  const { component } = await mountPanel(ROWS);
  const tree = component(props);
  assert.equal(byClass(tree, 'wsm-skeleton').length, 3);
  assert.equal(byClass(tree, 'wsm-card').length, 0);
  assert.equal(byClass(tree, 'wsm-empty').length, 0);
});

test('the panel renders one card per workspace once the read lands', async () => {
  const { component, flush } = await mountPanel(ROWS);
  component(props);
  await flush();
  const tree = component(props);

  const cards = byClass(tree, 'wsm-card');
  assert.equal(cards.length, 2);
  assert.deepEqual(
    cards.map((card) => card.props['data-blocked']),
    ['true', 'false'],
  );
  assert.deepEqual(
    cards.map((card) => byClass(card, 'wsm-name')[0].props.title),
    ['alpha', 'beta'],
  );
  assert.equal(byClass(tree, 'wsm-skeleton').length, 0);
});

test('a workspace with a running session disables every action', async () => {
  const { component, flush } = await mountPanel(ROWS);
  component(props);
  await flush();
  const [running, idleOpen] = byClass(component(props), 'wsm-card');

  const blocked = byClass(running, 'wsm-action');
  assert.equal(blocked.length, 4);
  assert.ok(blocked.every((button) => button.props.disabled === true));

  const usable = byClass(idleOpen, 'wsm-action');
  assert.equal(usable.length, 4);
  assert.ok(usable.every((button) => button.props.disabled === false));
});

test('an open but idle workspace says so instead of claiming a run', async () => {
  const { component, flush } = await mountPanel(ROWS);
  component(props);
  await flush();
  const [running, idleOpen] = byClass(component(props), 'wsm-card');

  // State is a word on the card's meta line, not a coloured pill.
  const warn = byClass(running, 'wsm-state-warn');
  assert.equal(warn.length, 1);
  assert.match(textOf(warn[0]), /^(1 运行中|1 running)$/);
  assert.equal(byClass(running, 'wsm-badge-warn').length, 0);

  const info = byClass(idleOpen, 'wsm-state-info');
  assert.equal(info.length, 1);
  assert.match(textOf(info[0]), /^(1 已打开 · 空闲|1 open · idle)$/);
  // One meta line carries the count and the state; the card keeps no hint copy.
  const meta = byClass(idleOpen, 'wsm-meta');
  assert.equal(meta.length, 1);
  assert.equal(textOf(meta[0]).includes('·'), true);
  assert.equal(byClass(idleOpen, 'wsm-note').length, 0);
});

test('the card styles ride on the host theme tokens', async () => {
  const { styles } = await mountPanel(ROWS);
  const css = styles.join('\n');
  assert.match(css, /\.wsm-card\s*\{/);
  assert.match(css, /--dsw-alias-settings-card-fill/);
  assert.match(css, /--dsw-alias-settings-card-stroke/);
  assert.match(css, /--dsw-radius-xl/);
});

test('a task opens as a dialog over the list instead of replacing it', async () => {
  const { component, flush } = await mountPanel(ROWS);
  component(props);
  await flush();

  const before = component(props);
  const free = byClass(before, 'wsm-card')[1];
  const rebuild = byClass(free, 'wsm-action').find((button) => button.props.onClick && !button.props.disabled);
  assert.ok(rebuild, 'the open-but-idle workspace keeps its actions clickable');
  rebuild.props.onClick();

  const opened = component(props);
  assert.equal(byClass(opened, 'wsm-modal').length, 1, 'the task is a dialog');
  assert.equal(byClass(opened, 'wsm-card').length, 2, 'the list is still there behind it');
  assert.equal(byClass(opened, 'wsm-detail').length, 1, 'the dialog carries the task form');

  // The scrim cancels: same list, no dialog.
  byClass(opened, 'wsm-modal')[0].props.onClick();
  const closed = component(props);
  assert.equal(byClass(closed, 'wsm-modal').length, 0);
  assert.equal(byClass(closed, 'wsm-card').length, 2);
});

test('the settings section renders the manager itself, not a launcher', async () => {
  const { component, registrations, flush, styles } = await mountPanel(ROWS);
  const section = registrations.find((each) => each.options.name === 'settings.section');
  assert.ok(section, 'the settings section is registered');

  const tree = section.component({ close() {} });
  assert.equal(tree.type, component, 'the section mounts the same manager');
  assert.equal(tree.props.variant, 'section', 'it mounts it in section layout');

  tree.type(tree.props);
  await flush();
  const rendered = tree.type(tree.props);
  assert.equal(byClass(rendered, 'wsm-root--section').length, 1);
  assert.equal(byClass(rendered, 'wsm-page--section').length, 1);
  assert.equal(byClass(rendered, 'wsm-card').length, ROWS.length, 'the list is right there');

  // One click on the section shows the page: no launcher button, no second step.
  const buttons = nodes(rendered).filter((node) => node.type === 'button');
  assert.ok(buttons.length > 0, 'the manager keeps its own actions');
  assert.ok(
    buttons.every((button) => textOf(button) !== '打开工作区管理'),
    'the launcher that asked for a second click is gone',
  );

  const css = styles.join('\n');
  assert.match(css, /\.wsm-root--section\{padding:0/);
  assert.match(css, /\.wsm-root--section \.wsm-title\{display:none\}/);
  assert.match(css, /\.wsm-page--section\{padding-left:0/);
});
