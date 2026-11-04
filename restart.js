/**
 * The restart helper, as text.
 *
 * Kept out of the service class so both scripts can be asserted without a live
 * Electron host: `test/restart.test.js` checks the lines that make the helper
 * safe (kill the image, kill the parent tree, poll the socket owner, never start
 * a second instance) instead of trusting a string built at run time.
 *
 * `cmd` rather than PowerShell: the helper must start in tens of milliseconds,
 * because the app it is replacing is already dying by then. `timeout` needs a
 * console the helper does not have, so the waits are `ping` against TEST-NET,
 * and `tasklist` is the poll because it is a native binary.
 */
const CRLF = `${String.fromCharCode(13)}${String.fromCharCode(10)}`;

const HELPER_LINES = ({ image, parentPid, selfPid, exe }) => [
  '@echo off',
  'rem Written by dsh-workspace-control: restart the desktop app.',
  'rem Let the Remote answer reach the browser before this process tree dies.',
  'rem `ping` against TEST-NET is the sleep: `timeout` needs a console here.',
  'ping -n 1 -w 250 192.0.2.1 >nul',
  `taskkill /IM "${image}" /F >nul 2>&1`,
  `taskkill /PID ${parentPid} /T /F >nul 2>&1`,
  'rem Wait for the process that owns the listening socket, not for stragglers.',
  'set rounds=0',
  ':wait',
  `tasklist /FI "PID eq ${selfPid}" 2>nul | find /I "${selfPid}" >nul || goto ready`,
  'set /a rounds+=1',
  'if %rounds% geq 24 goto giveup',
  'ping -n 2 -w 100 192.0.2.1 >nul',
  'goto wait',
  'rem Never start a second instance over one that refused to die.',
  ':giveup',
  'del "%~f0" >nul 2>&1',
  'exit /b 1',
  ':ready',
  `start "" "${exe}"`,
  'del "%~f0" >nul 2>&1',
];

/** The `cmd` helper that outlives the app it restarts. */
export const helperScript = (options) => `${HELPER_LINES(options).join(CRLF)}${CRLF}`;

/**
 * The VBScript that asks WMI to start the helper.
 *
 * A plain child is cheaper but dies with this process tree, so the helper is
 * created by WmiPrvSE instead. `cscript` issues that call in ~100 ms where
 * PowerShell needs ~1.2 s of start-up, and `ShowWindow = 0` keeps the helper
 * invisible; PowerShell remains the fallback when VBScript is unavailable.
 */
export const launcherScript = ({ inner }) => [
  'Option Explicit',
  'Dim wmi, service, startup, result, code',
  'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
  'Set service = wmi.Get("Win32_Process")',
  'Set startup = wmi.Get("Win32_ProcessStartup").SpawnInstance_',
  'startup.ShowWindow = 0',
  `code = service.Create("${String(inner).replace(/"/g, '""')}", Null, startup, result)`,
  'WScript.Quit code',
].join(CRLF);

/**
 * The same hidden WMI call through PowerShell, for hosts without VBScript.
 *
 * Invoke-CimMethod with no startup object creates the helper with an ordinary
 * console window, and Windows 11 hands that window to Windows Terminal: the
 * launcher is invisible but a terminal flashes on screen for as long as the
 * helper runs. Win32_Process.Create with ShowWindow = 0 is the hidden path,
 * and it is the same call the VBScript launcher makes.
 */
const psLiteral = (text) => "'" + String(text).replace(/'/g, "''") + "'";

export const powerShellLauncherCommand = ({ inner }) => [
  '$ErrorActionPreference = "Stop"',
  '$startup = ([wmiclass]"Win32_ProcessStartup").CreateInstance()',
  '$startup.ShowWindow = 0',
  '$created = ([wmiclass]"Win32_Process").Create(' + psLiteral(inner) + ', $null, $startup)',
  'Write-Output ("{0} {1}" -f $created.ReturnValue, $created.ProcessId)',
].join('; ');

export const CRLF_TEXT = CRLF;
