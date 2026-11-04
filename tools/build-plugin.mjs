// Public SDK plugins build independently; packaging includes no native executable or source tree.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const [name, output] = process.argv.slice(2);
if (!name || !output)
  throw new Error('Usage: node tools/build-plugin.mjs PLUGIN_OR_SOURCE_DIRECTORY OUTPUT.sdplugin');
const source = /^[a-z0-9-]+$/.test(name)
    ? path.join(root, 'plugins', 'upload', name)
    : path.resolve(root, name),
  manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
const cargoToml = await readFile(path.join(source, 'backend', 'Cargo.toml'), 'utf8');
const crate = /name\s*=\s*"([^"]+)"/.exec(cargoToml)?.[1]?.replaceAll('-', '_');
if (!crate) throw new Error('Missing crate name');
const cacheName = path.basename(source);
if (!/^[a-z0-9-]+$/.test(cacheName))
  throw new Error('Plugin source directory needs a portable name');
const target = path.join(root, '.local', 'plugin-build', cacheName);
run('cargo', [
  'build',
  '--manifest-path',
  path.join(source, 'backend', 'Cargo.toml'),
  '--target',
  'wasm32-unknown-unknown',
  '--release',
  '--offline',
  '--locked',
  '--target-dir',
  target,
]);
await mkdir(path.join(root, '.local', 'plugin-build'), { recursive: true });
const staging = await mkdtemp(path.join(root, '.local', 'plugin-build', `${cacheName}-package-`));
await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest));
await writeFile(
  path.join(staging, manifest.entry.backend),
  await readFile(path.join(target, 'wasm32-unknown-unknown', 'release', `${crate}.wasm`)),
);
if (manifest.entry.ui)
  await writeFile(
    path.join(staging, manifest.entry.ui),
    await readFile(path.join(source, manifest.entry.ui)),
  );
run(process.execPath, [
  path.join(root, 'tools', 'package-plugin.mjs'),
  staging,
  path.resolve(output),
]);
