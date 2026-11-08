import assert from 'node:assert/strict';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { discoverSystemPlugins, systemPluginRegistry } from './system-plugins.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const qa = path.join(repository, '.local/qa/system-plugin-discovery');

async function fixture(t) {
  await mkdir(qa, { recursive: true });
  const root = await mkdtemp(path.join(qa, 'unit-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), qa);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true });
  });
  await mkdir(path.join(root, 'plugins/system'), { recursive: true });
  return root;
}

async function add(root, name, id = `dev.example.${name}`) {
  const source = path.join(root, 'plugins/system', name);
  await cp(path.join(repository, 'plugins/development-kit/example'), source, { recursive: true });
  const file = path.join(source, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.id = id;
  await writeFile(file, JSON.stringify(manifest));
  return source;
}

test('discovers complete direct source directories by manifest ID and ignores output packages', async (t) => {
  const root = await fixture(t);
  await add(root, 'z-tool', 'org.example.database');
  await add(root, 'a-tool');
  const output = path.join(root, 'plugins/system/packages');
  await mkdir(path.join(output, 'stale-source'), { recursive: true });
  await writeFile(path.join(output, 'stale.sdplugin'), 'not a source plugin');
  await writeFile(path.join(root, 'plugins/system/README.md'), 'source layout');
  const plugins = await discoverSystemPlugins(root);
  assert.deepEqual(
    plugins.map((plugin) => plugin.id),
    ['dev.example.a-tool', 'org.example.database'],
  );
  assert.equal(plugins[1].destination, 'plugins/system/packages/z-tool.sdplugin');
  assert.equal(plugins[1].source, 'plugins/system/z-tool');
  const registry = systemPluginRegistry(plugins);
  assert.match(registry, /const PACKAGES: \[\(&str, &\[u8\]\); 2\]/);
  assert.match(registry, /\("org.example.database", include_bytes!\("z-tool.sdplugin"\)\)/);
  assert.doesNotMatch(registry, /stale|README/);
});

test('adding and removing a source updates the generated registry without changing any list', async (t) => {
  const root = await fixture(t);
  await add(root, 'original');
  const before = systemPluginRegistry(await discoverSystemPlugins(root));
  const added = await add(root, 'new-plugin');
  const after = systemPluginRegistry(await discoverSystemPlugins(root));
  assert.doesNotMatch(before, /new-plugin/);
  assert.match(after, /dev.example.new-plugin/);
  await rename(added, path.join(root, 'removed-source'));
  assert.equal(systemPluginRegistry(await discoverSystemPlugins(root)), before);
});

test('an empty source directory produces an empty registry', async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await discoverSystemPlugins(root), []);
  assert.match(systemPluginRegistry([]), /const PACKAGES: \[\(&str, &\[u8\]\); 0\] = \[\n\];/);
});

test('duplicate manifest IDs fail instead of choosing one plugin', async (t) => {
  const root = await fixture(t);
  await add(root, 'one', 'dev.example.same');
  await add(root, 'two', 'dev.example.same');
  await assert.rejects(discoverSystemPlugins(root), /Duplicate system plugin ID: dev.example.same/);
});

for (const file of [
  'manifest.json',
  'backend/Cargo.toml',
  'backend/Cargo.lock',
  'backend/src/lib.rs',
  'ui.json',
  'frontend/main.ts',
]) {
  test(`incomplete plugin fails with the missing ${file} path`, async (t) => {
    const root = await fixture(t);
    const source = await add(root, 'incomplete');
    await rm(path.join(source, file));
    await assert.rejects(discoverSystemPlugins(root), (error) => {
      assert.match(error.message, /Incomplete system plugin/);
      assert.ok(error.message.includes(path.join(source, file)));
      assert.equal(error.cause.code, 'ENOENT');
      return true;
    });
  });
}

test('malformed manifests report the source path and preserve the parse error', async (t) => {
  const root = await fixture(t);
  const source = await add(root, 'invalid');
  await writeFile(path.join(source, 'manifest.json'), '{');
  await assert.rejects(discoverSystemPlugins(root), (error) => {
    assert.match(error.message, /Cannot read system plugin manifest: .*invalid.*manifest.json/);
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
});

test('invalid IDs and UI paths cannot enter generated Rust or escape the source', async (t) => {
  const root = await fixture(t);
  const source = await add(root, 'invalid', 'dev.example."injected');
  await assert.rejects(discoverSystemPlugins(root), /Invalid system plugin ID/);
  const file = path.join(source, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.id = 'dev.example.valid';
  manifest.entry.ui = '../outside.json';
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(discoverSystemPlugins(root), /Invalid system plugin UI entry/);
  await writeFile(file, 'null');
  await assert.rejects(discoverSystemPlugins(root), /Invalid system plugin ID/);
});

test('directory junctions are rejected without traversing their target', async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(root, 'plugins/system/linked'), 'junction');
  await assert.rejects(discoverSystemPlugins(root), /must not be a link/);
});

test('dependency preparation uses every discovered source and excludes generated packages', async (t) => {
  const { default: childProcess } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const spawn = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0 }));
  syncBuiltinESMExports();
  const previousArgs = process.argv;
  t.after(() => {
    process.argv = previousArgs;
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  process.argv = [process.execPath, 'build-system-plugins.mjs', '--fetch-only'];
  await import('./build-system-plugins.mjs?fetch-discovery-test');
  const expected = await discoverSystemPlugins(repository);
  assert.equal(spawn.mock.callCount(), expected.length);
  for (const [index, call] of spawn.mock.calls.entries()) {
    assert.equal(call.arguments[0], 'cargo');
    assert.deepEqual(call.arguments[1], [
      'fetch',
      '--manifest-path',
      path.join(repository, expected[index].source, 'backend/Cargo.toml'),
      '--target',
      'wasm32-unknown-unknown',
      '--locked',
    ]);
    assert.equal(call.arguments[2].shell, undefined);
  }
});
