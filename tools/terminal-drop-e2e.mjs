// Production Rust binary protocol against real Linux interactive PTYs and GNU tools.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { requireBuildSpace } from './build-space.mjs';

assert.equal(
  process.platform,
  'win32',
  'This verification uses the isolated Ubuntu-24.04 WSL test peer.',
);
const root = fileURLToPath(new URL('../', import.meta.url));
const release = process.argv.includes('--release');
const throughput = process.argv.includes('--throughput');
const toolsDirectory = process.env.SERVERDECK_TEST_DROP_TOOLS || null;
const shellPath = process.env.SERVERDECK_TEST_DROP_SHELL || null;
const largeFile = !!process.env.SERVERDECK_TEST_DROP_LARGE;
assert(!largeFile || release, 'The 5 GiB end-to-end check requires --release.');
assert(!throughput || release, 'Throughput measurement requires --release.');
requireBuildSpace(root);
const artifacts = path.join(root, '.local', 'terminal-drop', 'protocol-' + randomUUID());
await mkdir(artifacts, { recursive: true });
const build = spawnSync(
  'cargo',
  [
    'test',
    '-p',
    'serverdeck-application',
    '--lib',
    '--no-run',
    '--message-format=json',
    ...(release ? ['--release'] : []),
  ],
  {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  },
);
await writeFile(path.join(artifacts, 'build.jsonl'), build.stdout || '');
await writeFile(path.join(artifacts, 'build.log'), build.stderr || String(build.error || ''));
assert.equal(build.status, 0, build.stderr || String(build.error));
const artifact = build.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .find(
    (item) =>
      item.reason === 'compiler-artifact' &&
      item.profile.test &&
      item.executable &&
      item.target.name === 'serverdeck_application',
  );
assert(artifact, 'native protocol test executable was not built');
const executable = path.join(artifacts, 'TerminalDropTests.exe');
await copyFile(artifact.executable, executable);
const cases = [
  'tests::real_linux_pty_binary_identity_permissions_conflicts_and_cancel_recovery',
  'ssh_tests::real_openssh_binary_upload_cancel_and_terminal_recovery',
  ...(throughput ? ['tests::real_linux_pty_binary_throughput'] : []),
];
const results = [];
for (const test of cases) {
  const result = spawnSync(
    executable,
    ['--ignored', '--exact', 'terminal_upload::binary::' + test, '--nocapture'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: largeFile ? 600000 : 240000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const output = (result.stdout || '') + (result.stderr || '');
  await writeFile(path.join(artifacts, test.replaceAll('::', '-') + '.log'), output);
  process.stdout.write(output);
  results.push({ test, exitCode: result.status });
  assert.equal(result.status, 0, 'real PTY verification failed: ' + test);
}
await writeFile(
  path.join(artifacts, 'results.json'),
  JSON.stringify({ release, throughput, toolsDirectory, shellPath, largeFile, results }, null, 2),
);
process.stdout.write('Artifacts: ' + artifacts + '\n');
