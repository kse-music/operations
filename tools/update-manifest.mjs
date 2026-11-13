import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppVersion } from './app-version.mjs';

export function updateManifest({ version, signature, notes, publishedAt }) {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'only stable application versions can be published');
  assert(signature.trim(), 'updater signature is required');
  assert(notes.trim(), 'release notes are required');
  assert(Buffer.byteLength(notes, 'utf8') <= 64 * 1024, 'release notes exceed 64 KiB');
  const signatureText = Buffer.from(signature.trim(), 'base64').toString('utf8');
  assert(
    signatureText
      .split('\n')
      .some(
        (line) =>
          line.startsWith('trusted comment:') && line.split('\t').includes(`version:${version}`),
      ),
    'signature must bind the application version; use tauri build or signer sign --app-version',
  );
  assert(Number.isFinite(Date.parse(publishedAt)), 'valid publication time is required');
  return {
    version,
    notes,
    pub_date: publishedAt,
    platforms: {
      'windows-x86_64': {
        url: `https://github.com/kse-music/operations/releases/download/v${version}/ServerDeck_${version}_x64-setup.exe`,
        signature: signature.trim(),
      },
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = readAppVersion();
  const installer = path.resolve(
    process.argv[2] ?? `target/release/bundle/nsis/ServerDeck_${version}_x64-setup.exe`,
  );
  assert.equal(path.basename(installer), `ServerDeck_${version}_x64-setup.exe`);
  assert((await stat(installer)).size > 0, 'installer is empty');
  const notesFile = process.argv[3];
  assert(notesFile, 'usage: node tools/update-manifest.mjs <installer> <release-notes-file>');
  const manifest = updateManifest({
    version,
    signature: await readFile(`${installer}.sig`, 'utf8'),
    notes: await readFile(notesFile, 'utf8'),
    publishedAt: new Date().toISOString(),
  });
  const output = path.join(path.dirname(installer), 'latest.json');
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated ${output}`);
}
