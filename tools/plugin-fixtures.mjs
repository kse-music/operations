// Independent uploaded network fixture built from the public compatibility UI and real guest.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export async function networkFixture() {
  const packed = JSON.parse(
    await readFile(
      new URL('../plugins/system/packages/services.sdplugin', import.meta.url),
      'utf8',
    ),
  );
  packed.manifest.permissions = ['ui.contribute', 'network.run'];
  packed.manifest.contributions = [
    { id: 'network', label: '网络诊断', kind: 'tool', tool: 'network' },
  ];
  const ui = {
    uiVersion: 4,
    title: '网络诊断',
    pages: [
      {
        id: 'network',
        title: '网络诊断',
        fields: [],
        actions: [{ id: 'bridge', label: '执行请求', discardDirty: false, enabledWhen: null }],
        initialAction: null,
        log: null,
        surface: { kind: 'tool', tool: 'network' },
      },
    ],
    frontend: { script: 'frontend.js', style: 'frontend.css' },
  };
  for (const [file, bytes] of [
    ['ui.json', Buffer.from(JSON.stringify(ui))],
    [
      'frontend.js',
      await readFile(new URL('../plugins/compat/network/assets/frontend.js', import.meta.url)),
    ],
    [
      'frontend.css',
      await readFile(new URL('../plugins/compat/network/assets/frontend.css', import.meta.url)),
    ],
  ]) {
    packed.files.find((entry) => entry.path === file).content = bytes.toString('base64');
    const digest = packed.manifest.files.find((entry) => entry.path === file);
    digest.size = bytes.length;
    digest.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  return packed;
}
