import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Preserve every clipboard format in memory; never persist or log clipboard data.
export async function withPreservedClipboard(token, action) {
  assert.match(token, /^[a-zA-Z0-9_-]+$/);
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$backup = [System.Windows.Forms.DataObject]::new()
$owned = [System.Collections.Generic.List[System.IDisposable]]::new()
$count = 0
$ready = $false
try {
  $source = [System.Windows.Forms.Clipboard]::GetDataObject()
  if ($null -ne $source) {
    foreach ($format in $source.GetFormats($false)) {
      $value = $source.GetData($format, $false)
      if ($null -eq $value) { throw 'Cannot preserve clipboard format' }
      if ($value -is [System.IO.MemoryStream]) {
        $value = [System.IO.MemoryStream]::new($value.ToArray())
        $owned.Add($value)
      } elseif ($value -is [System.ICloneable]) {
        $value = $value.Clone()
        if ($value -is [System.IDisposable]) { $owned.Add($value) }
      }
      $backup.SetData($format, $false, $value)
      $count++
    }
  }
  $ready = $true
  [Console]::WriteLine('READY')
  while ($null -ne ($command = [Console]::ReadLine())) {
    if ($command -eq 'RESTORE') { break }
    if ($command -ne 'READ') { throw 'Unknown clipboard test command' }
    $text = [System.Windows.Forms.Clipboard]::GetText()
    [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ text = $text }))
  }
} catch {
  [Console]::WriteLine('FAILED')
  exit 1
} finally {
  try {
    if ($ready) {
      $current = [System.Windows.Forms.Clipboard]::GetText()
      if ($current.Contains($env:SERVERDECK_CLIPBOARD_TEST_TOKEN)) {
        if ($count -eq 0) { [System.Windows.Forms.Clipboard]::Clear() }
        else { [System.Windows.Forms.Clipboard]::SetDataObject($backup, $true, 5, 100) }
        [Console]::WriteLine('RESTORED')
      } else {
        # Do not overwrite clipboard data copied by the user during the test.
        [Console]::WriteLine('UNCHANGED')
      }
    }
  } catch {
    [Console]::WriteLine('FAILED')
    exit 1
  } finally {
    foreach ($value in $owned) { $value.Dispose() }
  }
}
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, SERVERDECK_CLIPBOARD_TEST_TOKEN: token },
  });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  async function nextLine() {
    let timer;
    try {
      const result = await Promise.race([
        lines.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Clipboard preservation timed out')), 10000);
        }),
      ]);
      if (result.done) throw new Error('Clipboard preservation helper ended unexpectedly');
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    assert.equal(await nextLine(), 'READY', 'Could not preserve clipboard; test was not started');
    await action(async () => {
      child.stdin.write('READ\n');
      const result = JSON.parse(await nextLine());
      return result.text;
    });
  } finally {
    child.stdin.end('RESTORE\n');
    if (child.exitCode === null) {
      const restored = await nextLine();
      assert(['RESTORED', 'UNCHANGED'].includes(restored), 'Clipboard restoration failed');
    }
    assert.equal(await finished, 0, 'Clipboard preservation helper failed');
  }
}
