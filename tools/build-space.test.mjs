import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, mock, test } from 'node:test';
import { requireBuildSpace } from './build-space.mjs';

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

test('refuses a build below 10 GiB of available space', () => {
  const stats = mock.method(fs, 'statfsSync', () => ({
    bavail: 10n * 1024n ** 3n - 1n,
    bsize: 1n,
  }));
  assert.throws(() => requireBuildSpace('workspace'), /构建已停止.*至少需要 10 GiB/);
  assert.deepEqual(stats.mock.calls[0].arguments, ['workspace', { bigint: true }]);
});

test('allows a build at the reserve boundary', () => {
  mock.method(fs, 'statfsSync', () => ({ bavail: 10n * 1024n ** 3n, bsize: 1n }));
  assert.doesNotThrow(() => requireBuildSpace('workspace'));
});

test('uses available blocks and block size to calculate free space', () => {
  mock.method(fs, 'statfsSync', () => ({ bavail: 3n * 1024n ** 2n, bsize: 4096n }));
  assert.doesNotThrow(() => requireBuildSpace('workspace'));
});

test('propagates disk query failures instead of allowing an unchecked build', () => {
  const failure = new Error('disk query failed');
  mock.method(fs, 'statfsSync', () => {
    throw failure;
  });
  assert.throws(
    () => requireBuildSpace('workspace'),
    (error) => error === failure,
  );
});

for (const [entry, args] of [
  ['tauri.mjs', ['build', '--debug']],
  ['build-plugin.mjs', ['unused-plugin', 'unused-output.sdplugin']],
  ['build-system-plugins.mjs', []],
]) {
  test(`${entry} refuses low space before spawning a build`, async () => {
    mock.method(fs, 'statfsSync', () => ({ bavail: 0n, bsize: 4096n }));
    const spawn = mock.method(childProcess, 'spawnSync', () => {
      throw new Error('Unexpected build process');
    });
    syncBuiltinESMExports();
    const previousArgs = process.argv;
    process.argv = [process.execPath, entry, ...args];
    try {
      await assert.rejects(import(`./${entry}?low-space-test`), /构建已停止/);
      assert.equal(spawn.mock.callCount(), 0);
    } finally {
      process.argv = previousArgs;
    }
  });
}
