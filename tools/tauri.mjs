import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireBuildSpace } from './build-space.mjs';
import { prepareAppVersion } from './app-version.mjs';

if (['build', 'dev'].includes(process.argv[2]) && !process.argv.includes('--help')) {
  requireBuildSpace(fileURLToPath(new URL('../', import.meta.url)));
  prepareAppVersion();
}

// Preserve CLI flags across the root npm workspace entry point on Windows.
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)),
    ...process.argv.slice(2),
  ],
  { cwd: fileURLToPath(new URL('../apps/desktop/', import.meta.url)), stdio: 'inherit' },
);
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
}
process.exitCode = result.status ?? 1;
