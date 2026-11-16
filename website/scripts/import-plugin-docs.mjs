import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [flag, sourceRoot, ...extra] = process.argv.slice(2);
if (flag !== '--source' || !sourceRoot || extra.length)
  throw new Error('用法：npm run docs:import -- --source <产品源码根目录>');
const source = resolve(sourceRoot);
const sdk = JSON.parse(
  await readFile(join(source, 'packages/plugin-sdk/package.json'), 'utf8'),
).version;
const versionDocument = await readFile(
  join(source, 'docs/plugins/PLUGIN_API_VERSIONING.md'),
  'utf8',
);
const versions = new Map(
  Array.from(
    versionDocument.matchAll(/^\|\s*([^|]+?)\s*\|\s*([\d.]+)\s*\|/gm),
    ([, name, version]) => [name.trim(), version],
  ),
);
if (versions.get('Host 语义 API / Rust SDK / Vue SDK') !== sdk) {
  throw new Error('SDK 包版本与版本规范不一致。');
}
function protocol(name) {
  const value = Number(versions.get(name));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`版本规范缺少有效的 ${name} 版本。`);
  return value;
}
const specifications = [
  ['PLUGIN_ARCHITECTURE.md', 'architecture', '插件架构'],
  ['PLUGIN_BUILD_CONTRACT.md', 'development', '源码与构建契约'],
  ['PLUGIN_SDK.md', 'sdk', `SDK ${sdk} 参考`],
  ['PLUGIN_UI_EXTENSION.md', 'ui', 'UI 扩展契约'],
  ['PLUGIN_PACKAGE_FORMAT.md', 'package-format', '插件包格式'],
  ['PLUGIN_RUNTIME.md', 'runtime', 'WASM 运行时与 ABI'],
  ['PLUGIN_API_VERSIONING.md', 'versions', '版本与兼容性'],
  ['PLUGIN_SECURITY.md', 'security', '权限与安全契约'],
  ['BUILTIN_PLUGINS.md', 'builtins', '内置插件与分发'],
];
const output = fileURLToPath(new URL('../documentation/developers/reference/', import.meta.url));
const prepared = [];
const routes = new Map(
  specifications.map(([file, slug]) => [file, `/developers/reference/${slug}.html`]),
);
const manifest = {
  sdkVersion: sdk,
  uiVersion: protocol('UI'),
  abiVersion: protocol('WASM ABI / wire'),
  packageVersion: protocol('Manifest schema / sdplugin format'),
  documents: [],
};
for (const [file, slug, title] of specifications) {
  const original = (await readFile(join(source, 'docs/plugins', file), 'utf8')).replaceAll(
    '\r\n',
    '\n',
  );
  if (file === 'PLUGIN_SDK.md' && !original.startsWith(`# Plugin SDK ${sdk}\n`))
    throw new Error('SDK 包版本与规范正文不一致。');
  const content = original.replace(/\]\(([^)\s]+)\)/g, (match, target) => {
    if (/^https:\/\/ops\.hiboot\.cn\/(?:docs|developers)\//.test(target)) {
      return `](${target.replace('https://ops.hiboot.cn', '')})`;
    }
    if (/^(?:[a-z]+:|\/|#)/i.test(target)) return match;
    const [name, ...anchor] = target.split('#');
    const route = routes.get(name);
    if (!route) throw new Error(`${file} 包含尚未映射的本地链接：${target}`);
    return `](${route}${anchor.length ? '#' + anchor.join('#') : ''})`;
  });
  const yaml = (value) => `'${value.replaceAll("'", "''")}'`;
  const exported = `---\ntitle: ${yaml(title)}\ndescription: ${yaml(`ServerDeck SDK ${sdk} 的${title}，包含当前公开契约和安全边界。`)}\nreference: true\n---\n\n<div v-pre>\n\n${content.trimEnd()}\n\n</div>\n`;
  prepared.push([`${slug}.md`, exported]);
  manifest.documents.push({
    source: file,
    file: `developers/reference/${slug}.md`,
    sourceSha256: createHash('sha256').update(original).digest('hex'),
    contentSha256: createHash('sha256').update(exported).digest('hex'),
  });
}
await mkdir(output, { recursive: true });
for (const [name, content] of prepared) await writeFile(join(output, name), content);
await writeFile(
  new URL('../documentation/reference-manifest.json', import.meta.url),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`已导入 ${manifest.documents.length} 篇 SDK ${sdk} 规范；构建与阅读均使用项目内快照。`);
