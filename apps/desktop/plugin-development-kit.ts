import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';
import type { Plugin } from 'vite';

const fileName = 'serverdeck-plugin-development-kit.zip';
const repository = new URL('../../', import.meta.url);
const template = 'plugins/development-kit';

function createArchive(): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  function add(source: string, destination = source) {
    files[destination] = readFileSync(new URL(source, repository));
  }
  function addDirectory(source: string, destination = source) {
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
    'docs/plugins/PLUGIN_DEVELOPMENT.md',
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

export function pluginDevelopmentKit(): Plugin {
  return {
    name: 'serverdeck-plugin-development-kit',
    configureServer({ config }) {
      if (config.mode === 'test') return;
      // In Tauri dev mode the native asset resolver reads frontendDist from disk.
      const output = resolve(config.root, config.build.outDir);
      mkdirSync(output, { recursive: true });
      writeFileSync(resolve(output, fileName), createArchive());
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source: createArchive() });
    },
  };
}
