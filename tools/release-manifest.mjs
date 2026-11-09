import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readAppVersion } from './app-version.mjs';
const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(
  await readFile(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
);
const version = readAppVersion(root);
// Release readiness is tracked in docs/release/RELEASE_CHECKLIST.md, independently of the version.
assert.equal(config.identifier, 'cn.hiboot.desktop', 'application must use the cn.hiboot identity');
assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
const capability = JSON.parse(
  await readFile(path.join(root, 'apps/desktop/src-tauri/capabilities/main.json'), 'utf8'),
);
assert(!capability.remote, 'remote origins must not gain native privileges');
assert(
  !capability.permissions.some((p) => /^(shell|fs|http|process):/.test(p)),
  'no unrestricted plugin access',
);
const ico = await readFile(path.join(root, 'apps/desktop/src-tauri/icons/icon.ico'));
assert(ico.readUInt16LE(4) > 1, 'multi-resolution desktop icon');
const executable = path.resolve(root, 'target/release/serverdeck-desktop.exe');
const installer = path.resolve(
  root,
  `target/release/bundle/nsis/ServerDeck_${version}_x64-setup.exe`,
);
const entries = [];
for (const file of [executable, installer])
  entries.push({
    file: path.relative(root, file),
    bytes: (await stat(file)).size,
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  });
const installedPath = path.join(root, '.local/release-install/serverdeck-desktop.exe');
let installed;
try {
  installed = await readFile(installedPath);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
let packagedIdentity = null;
if (installed) {
  const standalone = await readFile(executable);
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const replacement = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
  const at = standalone.indexOf(marker);
  assert(at >= 0 && standalone.indexOf(marker, at + 1) < 0, 'exactly one Tauri bundle marker');
  const expected = Buffer.from(standalone);
  replacement.copy(expected, at);
  assert(
    expected.equals(installed),
    'installed EXE must differ ONLY by the documented Tauri UNK -> NSS marker',
  );
  packagedIdentity = {
    file: path.relative(root, installedPath),
    sha256: createHash('sha256').update(installed).digest('hex'),
    standaloneEquivalentExcept: '__TAURI_BUNDLE_TYPE_VAR_UNK -> __TAURI_BUNDLE_TYPE_VAR_NSS',
  };
}
const output = path.join(root, '.local/release-qa');
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, 'release-manifest.json'),
  JSON.stringify(
    {
      version,
      platform: 'windows-x86_64',
      signing: 'NotSigned (verified separately with Get-AuthenticodeSignature)',
      updater: false,
      packagedIdentity,
      files: entries,
    },
    null,
    2,
  ),
);
await writeFile(
  path.join(output, 'SHA256SUMS'),
  entries.map((e) => `${e.sha256}  ${path.basename(e.file)}`).join('\n') + '\n',
);
console.log('PASS release version/identity/ACL/icon checks and SHA256 manifest');
