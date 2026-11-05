// System packages use exactly the same compiler and packager as uploaded plugins.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPluginUi } from './build-plugin-ui.mjs';
import { requireBuildSpace } from './build-space.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
requireBuildSpace(root);
const names = ['docker', 'assistant'];
const artifacts = path.join(root, 'plugins/system/packages');
await mkdir(path.join(root, '.local/plugin-build'), { recursive: true });
await mkdir(artifacts, { recursive: true });
await buildPluginUi(
  path.join(root, 'plugins/compat/server'),
  path.join(root, 'plugins/compat/server/assets'),
  [path.join(root, 'plugins/system/docker/frontend')],
);
const staging = await mkdtemp(path.join(root, '.local/plugin-build', 'system-'));
for (const name of names) {
  const output = path.join(staging, `${name}.sdplugin`);
  const run = spawnSync(
    process.execPath,
    [path.join(root, 'tools/build-plugin.mjs'), `plugins/system/${name}`, output],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`Failed to build ${name}`);
  const bytes = await readFile(output);
  const value = JSON.parse(bytes);
  if (value.manifest.id !== `cn.hiboot.plugins.${name}`)
    throw new Error('Unexpected system package identity');
  const target = path.join(artifacts, `${name}.sdplugin`);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('System package destination must be an ordinary file');
    if ((await readFile(target)).equals(bytes)) continue;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, target);
}
