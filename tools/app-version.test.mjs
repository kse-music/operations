import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readAppVersion } from './app-version.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const qa = path.join(repository, '.local/qa/app-version');
const repositoryPackage = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));

async function fixture(t) {
  await mkdir(qa, { recursive: true });
  const root = await mkdtemp(path.join(qa, 'unit-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), qa);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true });
  });
  await mkdir(path.join(root, 'apps/desktop/src-tauri/src'), { recursive: true });
  await mkdir(path.join(root, 'crates/application/src'), { recursive: true });
  await mkdir(path.join(root, 'crates/plugin-sdk/src'), { recursive: true });
  await writeFile(
    path.join(root, 'Cargo.toml'),
    '[workspace]\nmembers = ["apps/desktop/src-tauri", "crates/application", "crates/plugin-sdk"]\nresolver = "3"\n[workspace.package]\nversion = "0.3.0"\n',
  );
  for (const [directory, name, version] of [
    ['apps/desktop/src-tauri', 'serverdeck-desktop', 'version.workspace = true'],
    ['crates/application', 'serverdeck-application', 'version.workspace = true'],
    ['crates/plugin-sdk', 'serverdeck-plugin-sdk', 'version = "5.0.0"'],
  ]) {
    await writeFile(
      path.join(root, directory, 'Cargo.toml'),
      `[package]\nname = "${name}"\n${version}\nedition = "2024"\n`,
    );
    await writeFile(path.join(root, directory, 'src/lib.rs'), '');
  }
  for (const [file, value] of [
    ['package.json', { name: 'serverdeck', private: true }],
    ['apps/desktop/package.json', { name: '@serverdeck/desktop', private: true }],
    ['apps/desktop/src-tauri/tauri.conf.json', { productName: 'ServerDeck' }],
    ['apps/desktop/src-tauri/tauri.linux.conf.json', { bundle: { targets: ['deb'] } }],
    ['apps/desktop/src-tauri/tauri.macos.conf.json', { bundle: { targets: ['dmg'] } }],
  ])
    await writeFile(path.join(root, file), JSON.stringify(value));
  return root;
}

test('the repository uses one application version source', () => {
  assert.match(readAppVersion(), /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/);
});

test('changing only the workspace version updates desktop/runtime metadata and leaves the SDK independent', async (t) => {
  const root = await fixture(t);
  assert.equal(readAppVersion(root), '0.3.0');
  execFileSync('cargo', ['update', '--workspace', '--offline'], {
    cwd: root,
    windowsHide: true,
    stdio: 'pipe',
  });
  const manifest = path.join(root, 'Cargo.toml');
  await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('0.3.0', '1.2.3-beta.2'));
  assert.equal(readAppVersion(root), '1.2.3-beta.2');
  assert.ok((await readFile(path.join(root, 'Cargo.lock'), 'utf8')).includes('version = "0.3.0"'));
  execFileSync('cargo', ['update', '--workspace', '--offline'], {
    cwd: root,
    windowsHide: true,
    stdio: 'pipe',
  });
  const lock = await readFile(path.join(root, 'Cargo.lock'), 'utf8');
  for (const name of ['serverdeck-desktop', 'serverdeck-application'])
    assert.ok(lock.includes(`name = "${name}"\nversion = "1.2.3-beta.2"`));
  assert.ok(lock.includes('name = "serverdeck-plugin-sdk"\nversion = "5.0.0"'));
});

for (const file of [
  'package.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/src-tauri/tauri.linux.conf.json',
  'apps/desktop/src-tauri/tauri.macos.conf.json',
]) {
  test(`rejects an independent application version in ${file}`, async (t) => {
    const root = await fixture(t);
    const target = path.join(root, file);
    const value = JSON.parse(await readFile(target, 'utf8'));
    value.version = '9.9.9';
    await writeFile(target, JSON.stringify(value));
    assert.throws(() => readAppVersion(root), /remove the duplicate version/);
  });
}

test('preserves Cargo diagnostics when the canonical version is invalid', async (t) => {
  const root = await fixture(t);
  const manifest = path.join(root, 'Cargo.toml');
  await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('0.3.0', 'invalid'));
  assert.throws(
    () => readAppVersion(root),
    (error) => {
      assert.notEqual(error.status, 0);
      assert.match(error.stderr.toString(), /invalid|version/);
      return true;
    },
  );
});

async function entryFixture(t) {
  const root = await fixture(t);
  await mkdir(path.join(root, 'tools'));
  for (const file of ['tauri.mjs', 'app-version.mjs', 'build-space.mjs'])
    await copyFile(path.join(repository, 'tools', file), path.join(root, 'tools', file));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'serverdeck',
      private: true,
      scripts: { tauri: repositoryPackage.scripts.tauri },
    }),
  );
  await mkdir(path.join(root, 'node_modules/@tauri-apps/cli'), { recursive: true });
  // The real wrapper and Cargo run; only the downstream GUI/build is replaced by a recorder.
  await writeFile(
    path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
    `const fs = require('node:fs');
fs.writeFileSync('cli-invocation.json', JSON.stringify({ args: process.argv.slice(2), lock: fs.readFileSync('../../Cargo.lock', 'utf8') }));
`,
  );
  execFileSync('cargo', ['update', '--workspace', '--offline'], {
    cwd: root,
    windowsHide: true,
    stdio: 'pipe',
  });
  const manifest = path.join(root, 'Cargo.toml');
  await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('0.3.0', '1.2.3-beta.2'));
  return root;
}

for (const mode of ['dev', 'build']) {
  test(`${mode} entry automatically updates an old lock before forwarding the unchanged CLI arguments`, async (t) => {
    const root = await entryFixture(t);
    const npm =
      process.env.npm_execpath ??
      path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const args =
      mode === 'dev'
        ? [npm, 'run', 'tauri', '--', 'dev']
        : ['tools/tauri.mjs', 'build', '--bundles', 'nsis'];
    execFileSync(process.execPath, args, {
      cwd: root,
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
    });
    const invocation = JSON.parse(
      await readFile(path.join(root, 'apps/desktop/cli-invocation.json'), 'utf8'),
    );
    assert.deepEqual(invocation.args, mode === 'dev' ? ['dev'] : ['build', '--bundles', 'nsis']);
    for (const name of ['serverdeck-desktop', 'serverdeck-application'])
      assert.ok(invocation.lock.includes(`name = "${name}"\nversion = "1.2.3-beta.2"`));
    assert.ok(invocation.lock.includes('name = "serverdeck-plugin-sdk"\nversion = "5.0.0"'));
    assert.equal(readAppVersion(root), '1.2.3-beta.2');
  });
}

test('a lock refresh failure prevents the downstream Tauri command from starting', async (t) => {
  const root = await entryFixture(t);
  const manifest = path.join(root, 'apps/desktop/src-tauri/Cargo.toml');
  await writeFile(
    manifest,
    (await readFile(manifest, 'utf8')) +
      '\n[dependencies]\nserverdeck-missing-version-test = "=99.99.99"\n',
  );
  await assert.rejects(async () => {
    execFileSync(process.execPath, ['tools/tauri.mjs', 'build', '--bundles', 'nsis'], {
      cwd: root,
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
    });
  }, /Command failed/);
  await assert.rejects(readFile(path.join(root, 'apps/desktop/cli-invocation.json')), {
    code: 'ENOENT',
  });
  assert.ok((await readFile(path.join(root, 'Cargo.lock'), 'utf8')).includes('version = "0.3.0"'));
});
