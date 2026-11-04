/**
 * The restart helper is text, so it can be asserted without a desktop host:
 * these are the lines that decide whether the app comes back at all.
 */

import './env.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { helperScript, launcherScript } from '../restart.js';

const lines = (text) => text.split(/\r\n/);
const options = { image: 'DeepSeek Harness.exe', parentPid: 4242, selfPid: 5252, exe: 'D:\DeepSeek Harness\DeepSeek Harness.exe' };

test('the helper ends with a trailing CRLF and starts without a window', () => {
  const text = helperScript(options);
  assert.ok(text.endsWith('\r\n'));
  assert.equal(lines(text)[0], '@echo off');
});

test('the helper kills the image and then the process tree it belongs to', () => {
  const text = helperScript(options);
  const image = text.indexOf('taskkill /IM "DeepSeek Harness.exe" /F');
  const tree = text.indexOf('taskkill /PID 4242 /T /F');
  assert.ok(image > 0, 'the image kill is missing');
  assert.ok(tree > image, 'the tree kill must follow the image kill');
});

test('the helper waits on the socket owner instead of a fixed sleep', () => {
  const text = helperScript(options);
  assert.ok(text.includes('tasklist /FI "PID eq 5252"'));
  assert.ok(text.includes('if %rounds% geq 24 goto giveup'));
});

test('the give-up branch removes itself and never starts a second instance', () => {
  const text = helperScript(options);
  const giveup = text.slice(text.indexOf(':giveup'), text.indexOf(':ready'));
  assert.ok(giveup.includes('del "%~f0"'));
  assert.ok(giveup.includes('exit /b 1'));
  assert.ok(!giveup.includes('start ""'), 'a refused kill must not start another instance');
});

test('the launcher quotes the command for WMI and hides the window', () => {
  const body = launcherScript({ inner: 'cmd.exe /c ""C:\tmp\a.cmd""' });
  assert.ok(body.includes('startup.ShowWindow = 0'));
  assert.ok(body.includes('service.Create("cmd.exe /c """"C:\tmp\a.cmd""""", Null, startup, result)'));
  assert.ok(body.includes('WScript.Quit code'));
});

test('the launcher addresses the local WMI namespace without a broken escape', () => {
  // The JS source needs four backslashes: with two, "\root" parses as a
  // carriage return, the moniker is invalid, and cscript exits 1 with an empty
  // stderr. That failure is silent — the PowerShell fallback takes over — so
  // the fast path stayed dead until this test existed.
  const body = launcherScript({ inner: 'x' });
  const moniker = lines(body).find((line) => line.includes('winmgmts'));
  assert.equal(moniker, 'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")');
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body), 'a control character means the escape is wrong');
});

test('the PowerShell fallback creates the helper hidden as well', async () => {
  const { powerShellLauncherCommand } = await import('../restart.js');
  const command = powerShellLauncherCommand({ inner: 'cmd.exe /c "C:\\tmp\\a.cmd"' });
  assert.ok(command.includes('$startup.ShowWindow = 0'), 'the fallback must hide the console window');
  assert.ok(command.includes('([wmiclass]"Win32_Process").Create('), 'the fallback must create through WMI');
  assert.ok(!command.includes('Invoke-CimMethod'), 'Invoke-CimMethod without a startup object shows a console window');
  assert.ok(command.includes("Create('cmd.exe /c \"C:\\tmp\\a.cmd\"', $null, $startup)"));
});
