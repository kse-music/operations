// Real Linux lrzsz/PTTY peer; no SSH credentials or user server are involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, '.local', 'zmodem', `protocol-${randomUUID()}`);
await mkdir(artifacts, { recursive: true });
const receiver = process.env.SERVERDECK_RZ_TEST_BINARY;
assert(receiver, 'SERVERDECK_RZ_TEST_BINARY must identify an isolated Linux rz executable');
const distribution = process.env.SERVERDECK_RZ_TEST_DISTRO || 'Ubuntu-24.04';
const linuxPath = (value) =>
  value.replace(/^([A-Z]):/i, (_, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/');
const vite = await createServer({
  root: path.join(root, 'apps', 'desktop'),
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
});
const { ZmodemUpload } = await vite.ssrLoadModule('/src/services/zmodem.ts');
const results = [];

async function check(
  name,
  files,
  { cancel = false, delay = 0, existing = false, abort = false } = {},
) {
  const destination = path.join(artifacts, name);
  await mkdir(destination);
  if (existing)
    await writeFile(path.join(destination, files[0].name), 'existing file must survive');
  const peer = spawn(
    'wsl.exe',
    [
      '-d',
      distribution,
      '--exec',
      'python3',
      linuxPath(path.join(root, 'tools', 'zmodem-rz-peer.py')),
      receiver,
      linuxPath(destination),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  let pickerCount = 0,
    released = 0,
    reads = 0,
    noticed = '',
    text = '',
    diagnostic = '';
  const failures = [];
  const upload = new ZmodemUpload({
    write: (data) => {
      text += Buffer.from(data).toString('utf8');
    },
    send: (data) =>
      new Promise((resolve, reject) =>
        peer.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      ),
    pick: async () => {
      pickerCount++;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return {
        token: name,
        files: cancel ? [] : files.map((file) => ({ name: file.name, size: file.data.length })),
      };
    },
    read: async (token, index, offset) => {
      assert.equal(token, name);
      reads++;
      return Array.from(files[index].data.subarray(offset, offset + 8192));
    },
    release: async (token) => {
      assert.equal(token, name);
      released++;
    },
    progress: (value) => {
      if (abort && value?.sent > 0) upload.cancel();
    },
    failed: (error) => failures.push(String(error)),
    notice: (message) => {
      noticed = message;
    },
  });
  peer.stdout.on('data', (data) => upload.consume(new Uint8Array(data)));
  peer.stderr.on('data', (data) => {
    diagnostic += data.toString();
  });
  peer.stdin.on('error', (error) => failures.push(String(error)));
  let timer;
  try {
    const status = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        peer.kill();
        reject(new Error(`rz test timed out: ${name}; ${diagnostic}; ${failures.join('; ')}`));
      }, 45000);
      peer.on('error', reject);
      peer.on('close', resolve);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pickerCount, 1, 'one native picker request per rz invocation');
    assert.equal(released, 1, 'file grant released');
    assert.equal(upload.busy, false, 'terminal unblocked');
    assert(text.includes(`ZMODEM_RZ_EXIT=${status}`), 'shell output after ZMODEM is preserved');
    if (abort) {
      assert.notEqual(status, 0, 'cancelled receiver must fail');
      assert(noticed.includes('取消'));
    } else {
      assert.equal(status, 0, `receiver failed: ${diagnostic}`);
      assert.deepEqual(failures, []);
      if (cancel) {
        assert.equal(reads, 0);
        assert.deepEqual(await readdir(destination), []);
      } else if (existing) {
        assert.equal(reads, 0, 'receiver skip must not read or overwrite the file');
        assert.equal(
          await readFile(path.join(destination, files[0].name), 'utf8'),
          'existing file must survive',
        );
        assert(noticed.includes('跳过 1'));
      } else {
        for (const file of files)
          assert.deepEqual(await readFile(path.join(destination, file.name)), file.data);
      }
    }
    results.push({
      name,
      status,
      pickerCount,
      released,
      reads,
      noticed,
      files: files.map((file) => ({
        name: file.name,
        size: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
      })),
    });
    process.stdout.write(`${name}: passed\n`);
  } finally {
    clearTimeout(timer);
    upload.dispose();
    peer.stdin.end();
    if (peer.exitCode === null) peer.kill();
  }
}
try {
  const binary = {
    name: '中文 空格.bin',
    data: Buffer.from(Array.from({ length: 2 * 1024 * 1024 }, (_, i) => i % 256)),
  };
  await check('binary-multiple-empty', [
    binary,
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'lines.txt', data: Buffer.from('中文\r\nemoji 😀\n') },
  ]);
  await check('cancel-picker', [], { cancel: true });
  await check('receiver-skip', [binary], { existing: true });
  await check(
    'picker-keepalive',
    [{ name: 'delayed.txt', data: Buffer.from('chosen after keepalive') }],
    { delay: 6500 },
  );
  await check('cancel-transfer', [binary], { abort: true });
  await writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify({ receiver, results }, null, 2),
  );
  process.stdout.write(`${path.join(artifacts, 'results.json')}\n`);
} finally {
  await vite.close();
}
