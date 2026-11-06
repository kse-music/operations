// System packages use exactly the same compiler and packager as uploaded plugins.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPluginUi } from './build-plugin-ui.mjs';
import { requireBuildSpace } from './build-space.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
requireBuildSpace(root);
const packages = ['docker', 'assistant'].map((name) => ({
  source: `plugins/system/${name}`,
  id: `cn.hiboot.plugins.${name}`,
  destination: `plugins/system/packages/${name}.sdplugin`,
}));
if (process.argv.includes('--with-test-fixtures')) {
  const source = 'tests/fixtures/plugins/server-capabilities';
  packages.push({
    source,
    id: 'dev.serverdeck.server-capabilities',
    destination: `${source}/server-capabilities.sdplugin`,
  });
}
await mkdir(path.join(root, '.local/plugin-build'), { recursive: true });
await buildPluginUi(
  path.join(root, 'plugins/compat/server'),
  path.join(root, 'plugins/compat/server/assets'),
  [path.join(root, 'plugins/system/docker/frontend')],
);
const staging = await mkdtemp(path.join(root, '.local/plugin-build', 'system-'));
for (const { source, id, destination } of packages) {
  const target = path.join(root, destination);
  const output = path.join(staging, path.basename(target));
  const run = spawnSync(
    process.execPath,
    [path.join(root, 'tools/build-plugin.mjs'), source, output],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`Failed to build ${source}`);
  const bytes = await readFile(output);
  const value = JSON.parse(bytes);
  if (value.manifest.id !== id) throw new Error(`Unexpected package identity for ${source}`);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Plugin package destination must be an ordinary file');
    if ((await readFile(target)).equals(bytes)) continue;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, target);
}
