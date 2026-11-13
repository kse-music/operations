import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));

test('packaging stamps the actual build time without changing source metadata or payload digests', async () => {
  const qa = path.join(repository, '.local/qa/plugin-package-time');
  await mkdir(qa, { recursive: true });
  const run = await mkdtemp(path.join(qa, 'unit-'));
  const source = path.join(run, 'source');
  await mkdir(source);
  const manifest = JSON.parse(
    await readFile(path.join(repository, 'tests/fixtures/plugins/metadata/manifest.json'), 'utf8'),
  );
  manifest.builtAt = 1;
  const original = JSON.stringify(manifest);
  await writeFile(path.join(source, 'manifest.json'), original);
  const content = 'Package build time regression fixture';
  await writeFile(path.join(source, 'readme.txt'), content);
  const output = path.join(run, 'metadata.sdplugin');
  const before = Date.now();
  const result = spawnSync(process.execPath, ['tools/package-plugin.mjs', source, output], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  });
  const after = Date.now();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const pkg = JSON.parse(await readFile(output, 'utf8'));
  assert(Number.isSafeInteger(pkg.manifest.builtAt));
  assert(pkg.manifest.builtAt >= before && pkg.manifest.builtAt <= after);
  assert.equal(await readFile(path.join(source, 'manifest.json'), 'utf8'), original);
  assert.deepEqual(pkg.manifest.files, [
    {
      path: 'readme.txt',
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    },
  ]);
  assert.equal(Buffer.from(pkg.files[0].content, 'base64').toString(), content);
});
