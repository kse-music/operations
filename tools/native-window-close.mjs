import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Exercise the real titlebar close path for the explicitly supplied test process.
export function closeNativeWindow(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'invalid isolated test process');
  const script = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ServerDeckTestClose { [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'
$targetProcess = Get-Process -Id ${pid} -ErrorAction Stop
$windowHandle = $targetProcess.MainWindowHandle
if ($windowHandle -eq [IntPtr]::Zero) { throw 'Missing isolated test window' }
if (-not [ServerDeckTestClose]::PostMessage($windowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not request window close' }
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || 'native window close failed');
}
