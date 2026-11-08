// System packages use exactly the same compiler and packager as uploaded plugins.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBuildSpace } from './build-space.mjs';
import { discoverSystemPlugins, systemPluginRegistry } from './system-plugins.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
requireBuildSpace(root);
const systemPackages = await discoverSystemPlugins(root);
const packages = [...systemPackages];
if (process.argv.includes('--with-test-fixtures')) {
  const source = 'tests/fixtures/plugins/server-capabilities';
  packages.push({
    source,
    id: 'dev.serverdeck.server-capabilities',
    destination: `${source}/server-capabilities.sdplugin`,
  });
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
if (process.argv.includes('--fetch-only')) {
  for (const { source } of packages)
    run('cargo', [
      'fetch',
      '--manifest-path',
      path.join(root, source, 'backend/Cargo.toml'),
      '--target',
      'wasm32-unknown-unknown',
      '--locked',
    ]);
} else {
  await mkdir(path.join(root, '.local/plugin-build'), { recursive: true });
  const staging = await mkdtemp(path.join(root, '.local/plugin-build', 'system-'));
  for (const [index, { source, id }] of packages.entries()) {
    const output = path.join(staging, `${index}.sdplugin`);
    run(process.execPath, [path.join(root, 'tools/build-plugin.mjs'), source, output]);
    const bytes = await readFile(output);
    const value = JSON.parse(bytes);
    if (value.manifest.id !== id) throw new Error(`Unexpected package identity for ${source}`);
  }
  for (const [index, { destination }] of packages.entries()) {
    const target = path.join(root, destination);
    const bytes = await readFile(path.join(staging, `${index}.sdplugin`));
    await publish(target, bytes);
  }
  await publish(
    path.join(root, 'plugins/system/packages/registry.rs'),
    Buffer.from(systemPluginRegistry(systemPackages)),
  );
}
async function publish(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Plugin package destination must be an ordinary file');
    if ((await readFile(target)).equals(bytes)) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, target);
}
