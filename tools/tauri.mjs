import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
