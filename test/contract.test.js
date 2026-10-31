/**
 * The Client and the Host each carry a copy of the remote contract.
 *
 * They are hand-written (a browser bundle cannot import the Host module), so the
 * only thing that keeps them honest is a test that loads both and compares them.
 */

import './env.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { DESCRIPTORS } from '../index.js';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Evaluate the browser bundle and hand back everything `apply` registered. */
export async function loadClient() {
  const source = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');
  const registrations = [];
  const dictionaries = [];
  const mounted = [];
  let entry = null;

  const window = {
    location: { reload() {} },
    __ModuleLoader__: {
      load(loaded) {
        entry = loaded;
      },
    },
  };
  const document = {
    head: { appendChild() {} },
    createElement: () => ({ remove() {}, set textContent(value) {} }),
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    querySelectorAll: () => [],
  };
  const require = (name) => {
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useEffect: () => {},
        useRef: () => ({ current: null }),
        useState: (initial) => [initial, () => {}],
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };

  const sandbox = {
    window,
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
    remote: {
      async $mount(contribution) {
        mounted.push(contribution);
        return {};
      },
    },
    slots: {
      inject: (_name, register) => register(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    locale: {
      register: (namespace, language, dictionary) => {
        dictionaries.push({ namespace, language, dictionary });
        return () => {};
      },
      getLocale: () => ({ active: 'zh' }),
    },
    effect: (callback) => callback(),
    get: () => undefined,
    inject: () => {},
  };

  const modes = entry.factory(require);
  modes.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { entry, registrations, dictionaries, mounted, modes };
}

/** Values built inside the vm carry that realm's prototypes: compare as JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the Client mounts exactly the descriptors the Host registers', async () => {
  const { mounted } = await loadClient();
  assert.equal(mounted.length, 1, 'one $mount per plugin');
  const contribution = mounted[0];
  assert.equal(contribution.package, 'dsh-workspace-control');
  assert.deepEqual(
    plain(contribution.descriptors.map((descriptor) => descriptor.id)),
    plain(DESCRIPTORS.map((descriptor) => descriptor.id)),
  );
  assert.deepEqual(
    plain(contribution.descriptors.map((descriptor) => descriptor.method)),
    plain(DESCRIPTORS.map((descriptor) => descriptor.method)),
  );
});

test('each descriptor agrees on namespace, service and parameter wires', async () => {
  const { mounted } = await loadClient();
  for (const host of DESCRIPTORS) {
    const client = mounted[0].descriptors.find((descriptor) => descriptor.id === host.id);
    assert.ok(client, `${host.id} must be mounted by the Client`);
    assert.equal(client.namespace, host.namespace);
    assert.equal(client.service, host.service);
    assert.deepEqual(
      plain(client.parameters.map((parameter) => parameter.wire)),
      plain(host.parameters.map((parameter) => parameter.wire)),
    );
    assert.equal(client.result.typeSymbol, host.result.typeSymbol);
    assert.deepEqual(plain(client.invocation), plain(host.invocation));
  }
});

test('the bundle declares the services its code reads', async () => {
  const { modes } = await loadClient();
  assert.deepEqual(plain(modes.inject), ['slots', 'locale', 'remote']);
});

test('every localization key exists in both languages', async () => {
  const { dictionaries } = await loadClient();
  const zh = dictionaries.find((entry) => entry.language === 'zh');
  const en = dictionaries.find((entry) => entry.language === 'en');
  assert.ok(zh && en, 'both dictionaries are registered');
  const zhKeys = Object.keys(zh.dictionary).sort();
  const enKeys = Object.keys(en.dictionary).sort();
  assert.deepEqual(plain(zhKeys), plain(enKeys));
  for (const key of zhKeys) {
    assert.ok(String(zh.dictionary[key]).trim() !== '', `${key} has zh text`);
    assert.ok(String(en.dictionary[key]).trim() !== '', `${key} has en text`);
  }
});
