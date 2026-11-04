/**
 * The Client half is served as a classic script and the page can evaluate it
 * twice in one document. At top level a second evaluation redeclared every
 * constant, which is a parse-time SyntaxError that aborted the entire boot round
 * ("web boot: N entries did not activate"). These tests pin the two properties
 * that keep that from coming back: the whole file is one closure with a single
 * guarded registration, and a duplicate registration is a warning, not a throw.
 */

import './env.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const lines = source.split(/\r?\n/);
const lastCode = [...lines].reverse().find((line) => line.trim() !== '');

/** A page-shaped sandbox: only what evaluating the script touches. */
function harness(loadImpl) {
  const loads = [];
  const warnings = [];
  const errors = [];
  const document = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    createElement() {
      return { style: {}, textContent: '', setAttribute() {}, appendChild() {} };
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    __ModuleLoader__: {
      load:
        loadImpl ||
        function load(spec) {
          if (loads.some((entry) => entry.id === spec.id)) {
            throw new Error('duplicate factory registration for "' + spec.id + '"');
          }
          loads.push(spec);
        },
    },
  };
  const context = vm.createContext({
    window,
    document,
    console: {
      warn: (...args) => warnings.push(args.join(' ')),
      error: (...args) => errors.push(args.join(' ')),
      log() {},
      info() {},
    },
  });
  return { context, window, loads, warnings, errors };
}

test('the whole bundle is one closure with a single guarded registration', () => {
  assert.equal(lines.filter((line) => line.trimStart().startsWith('(function () {')).length, 1);
  assert.ok(lines.findIndex((line) => line === '(function () {') > 0);
  assert.equal(lastCode, '})();');
  // Exactly one raw loader call, and it is the one inside the guard.
  assert.equal(source.match(/window\.__ModuleLoader__\.load\(/g)?.length, 1);
});

test('a double evaluation registers once and never throws', () => {
  const { context, loads, warnings, errors } = harness();
  assert.doesNotThrow(() => vm.runInContext(source, context, { filename: 'client.js' }));
  assert.equal(loads.length, 1);
  assert.equal(loads[0].id, 'dsh-workspace-control');
  assert.equal(typeof loads[0].factory, 'function');

  assert.doesNotThrow(() => vm.runInContext(source, context, { filename: 'client.js' }));
  assert.equal(loads.length, 1);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((line) => /already on this page/.test(line)));
});

test('a failing registration is reported instead of escaping the script', () => {
  const { context, errors } = harness(() => {
    throw new Error('loader offline');
  });
  const { document } = context;
  let banners = 0;
  const original = document.body.appendChild;
  document.body.appendChild = () => {
    banners += 1;
  };
  document.createElement = () => ({ style: {}, textContent: '', setAttribute() {}, appendChild() {} });

  assert.doesNotThrow(() => vm.runInContext(source, context, { filename: 'client.js' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not be registered/);
  assert.equal(banners, 1);
  document.body.appendChild = original;
});

test('a refresh paints its own veil and never reloads the page on desktop', () => {
  // A hot swap replaces fibers in place, so DSH's boot splash cannot appear; the
  // refresh says what it is doing with its own timed veil (it must not flash for
  // a fast swap, hence the delayed animation) and it must never navigate.
  assert.match(source, /className: 'wsm-loading'/);
  assert.match(source, /refreshPhase !== 'running'\) return null/);
  assert.match(source, /\.wsm-loading\{animation:none;background:rgba\(0,0,0,\.24\)\}/);
  assert.match(source, /refreshSplash/);
  // Reloading the document is the thing that crashed start-up; the page heals a
  // stale boot by hot-syncing, guarded so it runs once per boot revision.
  assert.match(source, /reconcileBootGraph/);
  assert.equal(source.match(/__wsmBootReconciled/g)?.length, 2);
  assert.match(source, /reloadUnsafe/);
});

test('the refresh seat rides in the header utilities row, not a fixed overlay', () => {
  // The overlap bug: a position:fixed button in the top-right corner sat on top
  // of DSH's own "open sidebar" corner button. The fix is to join the header's
  // utilities flex row, which is laid out by the conversation header itself.
  assert.match(source, /conversation\.session\.header\.utilities/);
  assert.match(
    source,
    /seat\(HEADER_UTILITIES, \{ id: 'workspace-control-refresh', order: 50, locale: NS \}, HeaderRefresh\)/,
  );
  assert.equal(source.match(/\bCornerRefresh\b/g), null);
  assert.equal(source.match(/wsm-corner/g), null);
  assert.equal(source.match(/position:fixed;top:calc\(/g), null);
});
