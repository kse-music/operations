import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

const repository = new URL('../', import.meta.url);
const template = 'plugins/development-kit';

export function createArchive() {
  const files = {};
  function add(source, destination = source) {
    files[destination] = readFileSync(new URL(source, repository));
  }
  function addDirectory(source, destination = source) {
    const entries = readdirSync(new URL(source, repository), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${source}/${entry.name}`;
      const target = `${destination}/${entry.name}`;
      if (entry.isDirectory()) addDirectory(relative, target);
      else if (entry.isFile()) add(relative, target);
      else throw new Error(`Unsupported development kit input: ${relative}`);
    }
  }

  for (const file of [
    'README.md',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vitest.config.ts',
    'example/manifest.json',
    'example/ui.json',
    'example/backend/Cargo.toml',
    'example/backend/Cargo.lock',
  ]) {
    add(`${template}/${file}`, file);
  }
  for (const folder of ['example/frontend', 'example/backend/src']) {
    addDirectory(`${template}/${folder}`, folder);
  }
  for (const file of [
    'LICENSE',
    '.cargo/config.toml',
    'crates/plugin-sdk/Cargo.toml',
    'packages/plugin-sdk/package.json',
    'packages/plugin-sdk/tsconfig.json',
    'tools/build-plugin.mjs',
    'tools/build-plugin-ui.mjs',
    'tools/build-space.mjs',
    'tools/package-plugin.mjs',
    'docs/plugins/PLUGIN_ARCHITECTURE.md',
    'docs/plugins/PLUGIN_BUILD_CONTRACT.md',
    'docs/plugins/PLUGIN_SDK.md',
    'docs/plugins/PLUGIN_UI_EXTENSION.md',
    'docs/plugins/PLUGIN_PACKAGE_FORMAT.md',
    'docs/plugins/PLUGIN_RUNTIME.md',
    'docs/plugins/PLUGIN_SECURITY.md',
    'docs/plugins/PLUGIN_API_VERSIONING.md',
    'docs/plugins/BUILTIN_PLUGINS.md',
  ]) {
    add(file);
  }
  addDirectory('crates/plugin-sdk/src');
  addDirectory('packages/plugin-sdk/src');
  return zipSync(files, { mtime: new Date(2020, 0, 1) });
}

export function writeDevelopmentKit(
  directory = fileURLToPath(new URL('.local/plugin-development-kit/', repository)),
) {
  const sdkVersion = JSON.parse(
    readFileSync(new URL('packages/plugin-sdk/package.json', repository), 'utf8'),
  ).version;
  const fileName = `serverdeck-plugin-development-kit-${sdkVersion}.zip`;
  const archive = createArchive();
  mkdirSync(directory, { recursive: true });
  const output = join(directory, fileName);
  try {
    writeFileSync(output, archive, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!readFileSync(output).equals(Buffer.from(archive)))
      throw new Error(`同一 SDK 版本的开发包内容已变化，请核对版本并使用新的输出目录：${output}`, {
        cause: error,
      });
  }
  return { sdkVersion, output, bytes: archive.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('用法：node tools/build-plugin-development-kit.mjs [输出目录]');
  console.log(JSON.stringify(writeDevelopmentKit(directory && resolve(directory))));
}
