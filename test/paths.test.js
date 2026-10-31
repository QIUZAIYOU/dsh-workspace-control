/**
 * The pure path rules, which the move transaction leans on everywhere.
 */

import './env.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeId, lastSegment, pathKey, samePath, titleFollowsPath } from '../index.js';

test('lastSegment reads either separator and ignores a trailing one', () => {
  assert.equal(lastSegment('D:\\Github\\alpha'), 'alpha');
  assert.equal(lastSegment('D:\\Github\\alpha\\'), 'alpha');
  assert.equal(lastSegment('/home/me/alpha/'), 'alpha');
  assert.equal(lastSegment('alpha'), 'alpha');
  assert.equal(lastSegment(''), '');
  assert.equal(lastSegment(undefined), '');
});

test('titleFollowsPath only accepts a title that repeats its own folder', () => {
  assert.equal(titleFollowsPath('alpha', 'D:\\Github\\alpha'), true);
  assert.equal(titleFollowsPath('Alpha', 'D:\\Github\\alpha'), true);
  assert.equal(titleFollowsPath('work stuff', 'D:\\Github\\alpha'), false);
  assert.equal(titleFollowsPath('', 'D:\\Github\\alpha'), false);
  assert.equal(titleFollowsPath(undefined, 'D:\\Github\\alpha'), false);
});

test('pathKey is case sensitive only where the platform is', () => {
  assert.equal(samePath('D:\\Github\\alpha', 'D:\\Github\\alpha'), true);
  assert.equal(samePath('D:\\Github\\alpha\\', 'D:\\Github\\alpha'), true);
  if (process.platform === 'win32') {
    assert.equal(pathKey('D:\\Github\\Alpha'), pathKey('d:\\github\\alpha'));
  } else {
    assert.notEqual(pathKey('/home/Alpha'), pathKey('/home/alpha'));
  }
});

test('encodeId escapes only what the layout cannot hold', () => {
  assert.equal(encodeId('session-abc.123'), 'session-abc.123');
  assert.equal(encodeId('a b'), 'a~0020b');
  assert.equal(encodeId('a/b'), 'a~002fb');
});
