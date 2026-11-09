import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));

export function readAppVersion(root = repository) {
  for (const file of [
    'package.json',
    'apps/desktop/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
    'apps/desktop/src-tauri/tauri.linux.conf.json',
    'apps/desktop/src-tauri/tauri.macos.conf.json',
  ]) {
    const value = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    assert.equal(
      value.version,
      undefined,
      `${file}: remove the duplicate version; edit Cargo.toml [workspace.package].version`,
    );
  }
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      ['metadata', '--no-deps', '--format-version', '1', '--offline', '--locked'],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
  );
  const member = (name) =>
    metadata.packages.find(
      (item) => item.name === name && metadata.workspace_members.includes(item.id),
    );
  const desktop = member('serverdeck-desktop'),
    application = member('serverdeck-application');
  assert(desktop && application, 'Cargo workspace must contain desktop and application packages');
  assert.equal(desktop.version, application.version, 'desktop and runtime versions must match');
  return desktop.version;
}

export function prepareAppVersion(root = repository) {
  const version = readAppVersion(root);
  execFileSync('cargo', ['update', '--workspace'], {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit',
  });
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(prepareAppVersion());
