// Production TypeScript protocol against a real Linux interactive PTY and GNU tools.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, '.local', 'terminal-drop', 'protocol-' + randomUUID());
const source = path.join(artifacts, 'source');
await mkdir(path.join(source, 'folder', '空目录'), { recursive: true });
const binary = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => i % 256));
await writeFile(path.join(source, 'plain.bin'), binary);
await writeFile(path.join(source, 'folder', '中文 空格.txt'), '中文\r\nbinary \0 😀\n');
await writeFile(path.join(source, 'folder', '.hidden'), '');
const specialName = "quote' $(touch injected) ;.txt";
await writeFile(path.join(source, 'folder', specialName), 'literal filename');
const archive = path.join(artifacts, 'upload.tar');
const packed = spawnSync('tar.exe', ['-cf', archive, '-C', source, 'plain.bin', 'folder']);
assert.equal(packed.status, 0, packed.stderr?.toString());
const bytes = await readFile(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const script = (
  await readFile(path.join(root, 'crates/application/src/terminal_upload/receiver.sh'), 'utf8')
).replaceAll('\r\n', '\n');
const linux = (value) =>
  value.replace(/^([A-Z]):/i, (_, d) => '/mnt/' + d.toLowerCase()).replaceAll('\\', '/');
const vite = await createServer({
  root: path.join(root, 'apps/desktop'),
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
});
const { TerminalDropUpload } = await vite.ssrLoadModule('/src/services/terminal-drop.ts');
const results = [];
async function check(scenario) {
  const nonce = randomUUID().replaceAll('-', '');
  const command =
    "/bin/sh -c '" +
    script.replaceAll("'", "'\\''") +
    "' serverdeck-upload " +
    nonce +
    ' ' +
    bytes.length +
    ' ' +
    (scenario === 'checksum' ? '0'.repeat(64) : sha256) +
    "; printf '\\036SDU:" +
    nonce +
    ":RETURN\\037'\r";
  const peer = spawn(
    'wsl.exe',
    [
      '-d',
      process.env.SERVERDECK_TEST_DISTRO || 'Ubuntu-24.04',
      '--exec',
      'python3',
      linux(path.join(root, 'tools/terminal-drop-peer.py')),
      scenario,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const failures = [],
    notices = [];
  let output = '',
    rawOutput = '',
    diagnostic = '',
    released = 0,
    reads = 0,
    cancelled = false;
  let terminalReady;
  const prompt = new Promise((resolve) => {
    terminalReady = resolve;
  });
  const write = (data) =>
    new Promise((resolve, reject) =>
      peer.stdin.write(data, (error) => (error ? reject(error) : resolve())),
    );
  const upload = new TerminalDropUpload({
    prepare: async () => {
      await prompt;
      return { size: bytes.length, sha256, nonce, command };
    },
    read: async (offset) => {
      reads++;
      return Array.from(bytes.subarray(offset, offset + 65536));
    },
    release: async () => {
      released++;
    },
    send: write,
    interrupt: () => write(Uint8Array.of(3)),
    write: (data) => {
      output += Buffer.from(data).toString('utf8');
      if (output.includes('SD_TEST_PROMPT> ') && scenario !== 'sudo-root') terminalReady();
      // sudo -i intentionally exercises a real login Shell before the receiver.
      if (scenario === 'sudo-root' && output.includes('\x1eSD_PEER_READY\x1f')) terminalReady();
    },
    progress: (value) => {
      if (scenario === 'cancel' && value?.sent > 0 && !cancelled) {
        cancelled = true;
        upload.cancel();
      }
    },
    failed: (error) => failures.push(String(error)),
    notice: (message) => notices.push(message),
  });
  peer.stdout.on('data', (data) => {
    rawOutput += data.toString('utf8');
    upload.consume(new Uint8Array(data));
  });
  peer.stderr.on('data', (data) => {
    diagnostic += data.toString('utf8');
  });
  peer.stdin.on('error', (error) => failures.push(String(error)));
  let timer;
  try {
    await Promise.race([
      upload.run(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'protocol deadline: ' + scenario + '; ' + diagnostic + '; ' + output.slice(-800),
              ),
            ),
          70000,
        );
      }),
    ]);
    assert.equal(upload.busy, false, failures.join('; '));
    await write(Buffer.from("printf '__SD_AFTER__\\n'; exit\r"));
    const status = await new Promise((resolve) => peer.on('close', resolve));
    assert.equal(status, 0, diagnostic);
    const match = diagnostic.match(/SD_PEER_RESULT=(.*)/);
    assert(match, diagnostic);
    const result = JSON.parse(match[1]);
    assert(result.restored, 'TTY settings restored after upload');
    assert(output.includes('__SD_AFTER__'), 'Shell is usable after upload');
    assert(rawOutput.includes('sd_nonce=$1'), 'the real Shell echoed the upload command');
    assert(
      !output.includes('sd_nonce=') && !output.includes('/bin/sh -c') && !output.includes('SDU:'),
      'upload bootstrap, protocol and diagnostics must not render in the terminal',
    );
    assert.equal(released, 1);
    assert(
      !Object.keys(result.entries).some((name) => name.startsWith('.serverdeck-upload.')),
      'temporary directory cleaned',
    );
    if (['ordinary', 'sudo-root'].includes(scenario)) {
      assert.deepEqual(failures, []);
      assert(notices.some((message) => message.includes('上传完成')));
      assert.equal(
        result.entries['plain.bin'].sha256,
        createHash('sha256').update(binary).digest('hex'),
      );
      assert.equal(result.entries['folder/中文 空格.txt'].uid, result.uid);
      assert(result.entries['folder/空目录']);
      assert(result.entries['folder/.hidden']);
      assert(result.entries['folder/' + specialName]);
      assert(!result.entries.injected, 'file names must never execute as Shell commands');
    } else if (scenario === 'cancel') {
      assert(notices.some((message) => message.includes('取消')));
      assert.deepEqual(result.entries, {});
    } else {
      assert(failures.length, 'must report failure');
      assert(!notices.some((message) => message.includes('上传完成')));
      if (scenario === 'permission') assert.equal(reads, 0);
      if (scenario === 'conflict-file')
        assert.equal(
          result.entries['plain.bin'].sha256,
          createHash('sha256').update('existing-content').digest('hex'),
        );
      if (scenario === 'conflict-directory')
        assert.deepEqual(Object.keys(result.entries), ['folder']);
      if (scenario === 'conflict-link')
        assert.equal(result.entries['plain.bin'].link, 'missing-target');
      if (['permission', 'checksum'].includes(scenario)) assert.deepEqual(result.entries, {});
    }
    results.push({ scenario, reads, released, failures, notices, ...result });
    process.stdout.write(scenario + ': passed\n');
  } finally {
    clearTimeout(timer);
    upload.dispose();
    peer.stdin.end();
    if (peer.exitCode === null) peer.kill();
  }
}
try {
  for (const scenario of [
    'ordinary',
    'sudo-root',
    'permission',
    'conflict-file',
    'conflict-directory',
    'conflict-link',
    'checksum',
    'cancel',
  ])
    await check(scenario);
  await writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify({ sha256, results }, null, 2),
  );
  process.stdout.write(path.join(artifacts, 'results.json') + '\n');
} finally {
  await vite.close();
}
