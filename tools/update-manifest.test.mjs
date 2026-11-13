import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateManifest } from './update-manifest.mjs';

const input = {
  version: '1.2.3',
  signature: Buffer.from(
    'untrusted comment: test\nZWQ=\ntrusted comment: timestamp:1\tfile:setup.exe\tversion:1.2.3\nZWQ=\n',
  ).toString('base64'),
  notes: '修复传输问题\n保留用户数据',
  publishedAt: '2026-11-13T02:00:00Z',
};
test('produces a static Tauri manifest with a version-pinned official download', () => {
  const result = updateManifest(input);
  assert.equal(result.version, '1.2.3');
  assert.equal(result.notes, input.notes);
  assert.equal(
    result.platforms['windows-x86_64'].url,
    'https://github.com/kse-music/operations/releases/download/v1.2.3/ServerDeck_1.2.3_x64-setup.exe',
  );
  assert.equal(result.platforms['windows-x86_64'].signature, input.signature);
});
test('rejects missing signatures, mismatched signed versions and prereleases', () => {
  for (const changed of [
    { signature: '' },
    { version: '1.2.4' },
    { version: '1.2.3-beta.1' },
    { notes: '' },
    { publishedAt: 'invalid' },
  ]) {
    assert.throws(() => updateManifest({ ...input, ...changed }));
  }
});
