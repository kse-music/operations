// Production sender and a real Linux lrzsz/PTTY receiver. This isolates the
// protocol/pipe path; optional IPC delay is an explicit scheduling simulation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const sizeMiB = Number(argument('--size-mib', '16'));
const delayMs = Number(argument('--ipc-delay-ms', '0'));
assert(Number.isInteger(sizeMiB) && sizeMiB > 0 && sizeMiB <= 256);
assert(Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 20);
const baseline = argument('--baseline', null);
const linux = (value) =>
  value.replace(/^([A-Z]):/i, (_, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/');
const receiver =
  process.env.SERVERDECK_RZ_TEST_BINARY ?? linux(path.join(root, '.local/zmodem/lrzsz/usr/bin/rz'));
const artifacts = path.join(root, '.local/qa', `rz-throughput-${randomUUID()}`);
await mkdir(artifacts, { recursive: true });
const payload = randomBytes(sizeMiB * 1024 * 1024);
const source = path.join(artifacts, 'source.bin');
await writeFile(source, payload);
const sha256 = createHash('sha256').update(payload).digest('hex');
const vite = await createServer({
  root: path.join(root, 'apps/desktop'),
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
});
const results = [];
const delay = () =>
  delayMs ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
try {
  for (const [label, modulePath, readSize] of [
    ...(baseline
      ? [['baseline', '/@fs/' + path.resolve(baseline).replaceAll('\\', '/'), 8192]]
      : []),
    ['optimized', '/src/services/zmodem.ts', 65536],
  ]) {
    const { ZmodemUpload } = await vite.ssrLoadModule(modulePath);
    const destination = path.join(artifacts, label);
    await mkdir(destination);
    const file = await open(source);
    const peer = spawn(
      'wsl.exe',
      [
        '-d',
        process.env.SERVERDECK_RZ_TEST_DISTRO ?? 'Ubuntu-24.04',
        '--exec',
        'python3',
        linux(path.join(root, 'tools/zmodem-rz-peer.py')),
        receiver,
        linux(destination),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let reads = 0,
      writes = 0,
      wireBytes = 0,
      updates = 0,
      released = 0,
      started;
    const failures = [];
    let diagnostics = '';
    const upload = new ZmodemUpload({
      write: () => {},
      pick: async () => ({
        token: label,
        files: [{ name: 'payload.bin', size: payload.length, modified: 1645594860 }],
      }),
      read: async (_token, _index, offset) => {
        started ??= performance.now();
        reads++;
        await delay();
        const data = Buffer.alloc(Math.min(readSize, payload.length - offset));
        const { bytesRead } = await file.read(data, 0, data.length, offset);
        assert.equal(bytesRead, data.length);
        return label === 'baseline' ? Array.from(data) : data;
      },
      send: async (data) => {
        writes++;
        wireBytes += data.length;
        await delay();
        await new Promise((resolve, reject) =>
          peer.stdin.write(data, (error) => (error ? reject(error) : resolve())),
        );
      },
      release: async () => {
        released++;
      },
      progress: () => {
        updates++;
      },
      failed: (error) => failures.push(String(error)),
      notice: () => {},
    });
    peer.stdout.on('data', (data) => upload.consume(new Uint8Array(data)));
    peer.stderr.on('data', (data) => {
      diagnostics += data;
    });
    peer.stdin.on('error', (error) => failures.push(String(error)));
    let timer;
    try {
      const status = await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          peer.kill();
          reject(new Error(`rz benchmark timed out: ${diagnostics}; ${failures}`));
        }, 120000);
        peer.on('error', reject);
        peer.on('close', resolve);
      });
      const elapsedSeconds = (performance.now() - started) / 1000;
      assert.equal(status, 0, diagnostics + failures.join('; '));
      for (let attempt = 0; upload.busy && attempt < 100; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(released, 1);
      assert.deepEqual(failures, []);
      assert.equal(
        createHash('sha256')
          .update(await readFile(path.join(destination, 'payload.bin')))
          .digest('hex'),
        sha256,
      );
      const result = {
        label,
        readSize,
        reads,
        writes,
        wireBytes,
        progressUpdates: updates,
        elapsedSeconds,
        mibPerSecond: sizeMiB / elapsedSeconds,
        sha256,
      };
      results.push(result);
      process.stdout.write(JSON.stringify(result) + '\n');
    } finally {
      clearTimeout(timer);
      upload.dispose();
      await file.close();
      peer.stdin.end();
      if (peer.exitCode === null) peer.kill();
    }
  }
  await writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify(
      {
        kind: 'isolated Node/real lrzsz pipe; not native WebView/SSH throughput',
        injectedPerInvokeDelayMs: delayMs,
        sizeMiB,
        results,
      },
      null,
      2,
    ),
  );
  process.stdout.write(path.join(artifacts, 'results.json') + '\n');
} finally {
  await vite.close();
}
