import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectHtml, checkLink, verifySnapshots } from './documentation.mjs';

const runFile = promisify(execFile);

const origin = 'https://ops.hiboot.cn';
const files = new Set(['index.html', 'docs/index.html', 'docs/hosts.html', 'docs-assets/theme.js']);
const pages = new Map([['docs/hosts.html', inspectHtml('<h2 id="首次连接">连接</h2>')]]);

test('跨目录和编码后的中文锚点可以直达，外部下载不当作站内页面', () => {
  for (const url of [
    '/docs/',
    'hosts.html#%E9%A6%96%E6%AC%A1%E8%BF%9E%E6%8E%A5',
    '/docs-assets/theme.js',
    '/',
    'https://github.com/kse-music/operations/releases',
  ]) {
    assert.doesNotThrow(() => checkLink(url, 'docs/index.html', pages, files, origin));
  }
});

test('校验能捕获不存在的深层页面、锚点和误回 GitHub 的文档链接', () => {
  for (const url of [
    '/docs/missing.html',
    'hosts.html#不存在',
    'https://github.com/kse-music/operations/blob/main/docs/guides/USER_GUIDE.md',
  ]) {
    assert.throws(() => checkLink(url, 'docs/index.html', pages, files, origin));
  }
});

test('HTML 提取检查真实链接和资源，解码实体并忽略代码示例中的转义标签', () => {
  const result = inspectHtml(
    '<h2 id="a&amp;b">标题</h2><a href="/docs/hosts.html#%E9%A6%96%E6%AC%A1%E8%BF%9E%E6%8E%A5">阅读</a><script src="/docs-assets/theme.js"></script>&lt;a href="missing"&gt;',
  );
  assert.deepEqual([...result.ids], ['a&b']);
  assert.equal(result.links.length, 2);
});

test('已提交规范在独立项目内可验证，不需要宿主源码', async () => {
  const manifest = await verifySnapshots(
    fileURLToPath(new URL('../documentation/', import.meta.url)),
  );
  assert.equal(manifest.documents.length, 9);
  assert.match(manifest.sdkVersion, /^\d+\.\d+\.\d+$/);
});

test('规范正文被单独改写时拒绝构建，要求重新同步来源', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'serverdeck-docs-'));
  try {
    await mkdir(path.join(directory, 'developers'));
    const content = '# 公开规范\n';
    await writeFile(
      path.join(directory, 'reference-manifest.json'),
      JSON.stringify({
        documents: [
          {
            file: 'developers/sdk.md',
            contentSha256: createHash('sha256').update(content).digest('hex'),
          },
        ],
      }),
    );
    await writeFile(path.join(directory, 'developers/sdk.md'), content);
    await assert.doesNotReject(verifySnapshots(directory));
    await writeFile(path.join(directory, 'developers/sdk.md'), '# 被改写的规范\n');
    await assert.rejects(verifySnapshots(directory), /未同步的修改/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('按 SDK 版本导入新契约，重写站内教程链接；无效源保留已有快照', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'serverdeck-contract-import-'));
  try {
    const website = path.join(directory, 'site');
    const source = path.join(directory, 'product');
    const sourceDocs = path.join(source, 'docs/plugins');
    await mkdir(path.join(website, 'scripts'), { recursive: true });
    await mkdir(path.join(source, 'packages/plugin-sdk'), { recursive: true });
    await mkdir(sourceDocs, { recursive: true });
    const script = path.join(website, 'scripts/import-plugin-docs.mjs');
    await copyFile(new URL('./import-plugin-docs.mjs', import.meta.url), script);
    const current = JSON.parse(
      await readFile(new URL('../documentation/reference-manifest.json', import.meta.url), 'utf8'),
    );
    await writeFile(
      path.join(source, 'packages/plugin-sdk/package.json'),
      JSON.stringify({ version: current.sdkVersion }),
    );
    for (const entry of current.documents)
      await writeFile(path.join(sourceDocs, entry.source), '# 公开契约\n');
    await writeFile(
      path.join(sourceDocs, 'PLUGIN_SDK.md'),
      `# Plugin SDK ${current.sdkVersion}\n\n[构建契约](PLUGIN_BUILD_CONTRACT.md#源码布局)\n`,
    );
    await writeFile(
      path.join(sourceDocs, 'PLUGIN_BUILD_CONTRACT.md'),
      '# 源码与构建契约\n\n[教程](https://ops.hiboot.cn/developers/quickstart.html)\n\n## 源码布局\n',
    );
    await writeFile(
      path.join(sourceDocs, 'PLUGIN_API_VERSIONING.md'),
      `# 版本\n\n| 契约 | 当前版本 |\n| --- | --- |\n| Host 语义 API / Rust SDK / Vue SDK | ${current.sdkVersion} |\n| Manifest schema / sdplugin format | ${current.packageVersion} |\n| WASM ABI / wire | ${current.abiVersion} |\n| UI | ${current.uiVersion} |\n`,
    );
    const importSource = () => runFile(process.execPath, [script, '--source', source]);
    await importSource();
    const documentation = path.join(website, 'documentation');
    const result = await verifySnapshots(documentation);
    assert.equal(result.sdkVersion, current.sdkVersion);
    assert.ok(result.documents.some((entry) => entry.source === 'PLUGIN_BUILD_CONTRACT.md'));
    assert.ok(!result.documents.some((entry) => entry.source === 'PLUGIN_DEVELOPMENT.md'));
    const reference = path.join(documentation, 'developers/reference');
    assert.match(
      await readFile(path.join(reference, 'sdk.md'), 'utf8'),
      /\]\(\/developers\/reference\/development\.html#源码布局\)/,
    );
    assert.match(
      await readFile(path.join(reference, 'development.md'), 'utf8'),
      /\]\(\/developers\/quickstart\.html\)/,
    );
    const manifestPath = path.join(documentation, 'reference-manifest.json');
    const before = await readFile(manifestPath, 'utf8');
    // The first file changes, but a later invalid file must fail before any snapshot is written.
    await writeFile(path.join(sourceDocs, 'PLUGIN_ARCHITECTURE.md'), '# 新架构正文\n');
    await writeFile(
      path.join(sourceDocs, 'BUILTIN_PLUGINS.md'),
      '# 内置插件\n\n[失效引用](MISSING.md)\n',
    );
    await assert.rejects(importSource(), /尚未映射的本地链接/);
    assert.equal(await readFile(manifestPath, 'utf8'), before);
    await assert.doesNotReject(verifySnapshots(documentation));
    await writeFile(
      path.join(source, 'packages/plugin-sdk/package.json'),
      JSON.stringify({ version: '0.0.0' }),
    );
    await assert.rejects(importSource(), /版本与版本规范不一致/);
    assert.equal(await readFile(manifestPath, 'utf8'), before);
  } finally {
    await rm(directory, { recursive: true });
  }
});
