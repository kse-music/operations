import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { createArchive, writeDevelopmentKit } from './build-plugin-development-kit.mjs';

test('开发包包含匹配版本的 SDK、依赖、锁文件及规范', () => {
  const files = unzipSync(createArchive());
  const read = (name) => strFromU8(files[name]);
  const sdk = JSON.parse(read('packages/plugin-sdk/package.json'));
  const project = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(project.dependencies['@serverdeck/plugin-sdk'], sdk.version);
  assert.equal(lock.packages[''].dependencies['@serverdeck/plugin-sdk'], sdk.version);
  assert.equal(lock.packages['packages/plugin-sdk'].version, sdk.version);
  assert.ok(read('crates/plugin-sdk/Cargo.toml').includes(`version = "${sdk.version}"`));
  assert.ok(read('docs/plugins/PLUGIN_SDK.md').includes(`# Plugin SDK ${sdk.version}`));
});

test('包内相对文档链接完整，教程统一链接官网且不打包网站源码', () => {
  const files = unzipSync(createArchive());
  assert.ok(files['docs/plugins/PLUGIN_ARCHITECTURE.md']);
  assert.ok(files['docs/plugins/PLUGIN_BUILD_CONTRACT.md']);
  assert.equal(files['docs/plugins/PLUGIN_DEVELOPMENT.md'], undefined);
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith('.md')) continue;
    for (const match of strFromU8(bytes).matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/iu.test(target)) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(name), target));
      assert.ok(files[resolved], `${name}: ${target}`);
    }
  }
  const readme = strFromU8(files['README.md']);
  assert.ok(readme.includes('https://ops.hiboot.cn/developers/quickstart.html'));
  assert.ok(!readme.includes('npm run package'));
  assert.ok(!Object.keys(files).some((name) => name.startsWith('website/')));
  assert.ok(
    strFromU8(files['docs/plugins/PLUGIN_BUILD_CONTRACT.md']).includes(
      '[官网开发者中心](https://ops.hiboot.cn/developers/)',
    ),
  );
});

test('独立构建按 SDK 版本命名，可重复生成且拒绝覆盖不同内容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'serverdeck-kit-'));
  try {
    const result = writeDevelopmentKit(directory);
    assert.equal(
      result.output,
      join(directory, `serverdeck-plugin-development-kit-${result.sdkVersion}.zip`),
    );
    assert.deepEqual(await readFile(result.output), Buffer.from(createArchive()));
    assert.deepEqual(writeDevelopmentKit(directory), result);
    await writeFile(result.output, 'existing archive');
    assert.throws(() => writeDevelopmentKit(directory), /同一 SDK 版本的开发包内容已变化/);
    assert.equal(await readFile(result.output, 'utf8'), 'existing archive');
  } finally {
    await rm(directory, { recursive: true });
  }
});
