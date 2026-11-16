import { spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'apps/desktop/src-tauri/icons');
const temporary = mkdtempSync(path.join(tmpdir(), 'serverdeck-icons-'));

try {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
      'icon',
      path.join(root, 'apps/desktop/src/assets/serverdeck.svg'),
      '--output',
      temporary,
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon generation failed (exit ${result.status})`);

  mkdirSync(output, { recursive: true });
  // Desktop assets only; mobile platform resources are not part of this application.
  for (const entry of readdirSync(temporary, { withFileTypes: true })) {
    if (entry.isFile())
      copyFileSync(path.join(temporary, entry.name), path.join(output, entry.name));
  }
} finally {
  if (path.dirname(temporary) !== path.resolve(tmpdir()) || lstatSync(temporary).isSymbolicLink()) {
    throw new Error(`Refusing to remove an unexpected icon build directory: ${temporary}`);
  }
  rmSync(temporary, { recursive: true });
}
