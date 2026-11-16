import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease } from './release.mjs';

function fixture() {
  const base = 'https://github.com/kse-music/operations/releases';
  const name = 'ServerDeck_0.9.2_x64-setup.exe';
  return {
    tag_name: 'v0.9.2',
    html_url: `${base}/tag/v0.9.2`,
    published_at: '2026-11-16T09:41:15Z',
    draft: false,
    prerelease: false,
    assets: [
      { name, browser_download_url: `${base}/download/v0.9.2/${name}`, size: 11701884 },
      {
        name: `${name}.sig`,
        browser_download_url: `${base}/download/v0.9.2/${name}.sig`,
        size: 440,
      },
    ],
  };
}
test('公开正式版本只输出对应的官方安装包与签名', () => {
  const result = parseRelease(fixture());
  assert.equal(result.version, '0.9.2');
  assert.equal(result.size, 11701884);
  assert.equal(
    result.downloadUrl,
    'https://github.com/kse-music/operations/releases/download/v0.9.2/ServerDeck_0.9.2_x64-setup.exe',
  );
  assert.equal(result.signatureUrl, `${result.downloadUrl}.sig`);
});
test('拒绝草稿、预发布和非正式标签', () => {
  for (const patch of [
    { draft: true },
    { prerelease: true },
    { tag_name: 'v0.9.3-rc.1' },
    { published_at: 'invalid' },
  ])
    assert.throws(() => parseRelease({ ...fixture(), ...patch }));
});
test('拒绝外部下载、跨版本文件和缺失的签名', () => {
  const outside = fixture();
  outside.assets[0].browser_download_url = 'https://example.com/installer.exe';
  const mismatch = fixture();
  mismatch.tag_name = 'v0.9.3';
  mismatch.html_url = 'https://github.com/kse-music/operations/releases/tag/v0.9.3';
  const unsigned = fixture();
  unsigned.assets.pop();
  const wrongSignature = fixture();
  wrongSignature.assets[1].browser_download_url += '?redirect=untrusted';
  const empty = fixture();
  empty.assets[0].size = 0;
  for (const input of [outside, mismatch, unsigned, wrongSignature, empty])
    assert.throws(() => parseRelease(input));
});
