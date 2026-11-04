import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import PluginsView from './PluginsView.vue';
import { usePluginsStore } from '../stores/plugins';
import { useNotificationsStore } from '../stores/notifications';
import { pluginsApi } from '../services/plugins';
import type { InstalledPlugin, PluginManifest } from '../types/plugins';
import { systemPluginFixtures } from '../services/system-plugins.fixture';
const native = vi.hoisted(() => ({
  enabled: false,
  listener: null as
    | null
    | ((event: {
        payload: { type: string; paths: string[]; position: { x: number; y: number } };
      }) => void),
  release: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...(await original<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => native.enabled,
}));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (listener: typeof native.listener) => {
      native.listener = listener;
      return native.release;
    },
  }),
}));
beforeEach(() => {
  native.enabled = false;
  native.listener = null;
  native.release.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
});
let app: App, root: HTMLDivElement, pinia: Pinia;
function mountManager() {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(PluginsView).use(pinia);
  app.mount(root);
}
afterEach(() => {
  app?.unmount();
  root?.remove();
  if (pinia) disposePinia(pinia);
  vi.restoreAllMocks();
});
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
it('requires explicit upgrade approval; cancelled upgrade preserves drafts and failure clears stale bindings', async () => {
  const manifest: PluginManifest = {
    schemaVersion: 1,
    id: 'dev.example',
    name: 'Example',
    version: '1.0.0',
    author: 'Developer',
    description: '',
    apiVersion: '^1',
    entry: { backend: null, ui: null },
    permissions: [],
    contributions: [],
    platforms: ['windows'],
    files: [],
    publisher: null,
  };
  const plugin: InstalledPlugin = {
    manifest,
    enabled: true,
    revision: 'old',
    packageDigest: 'old-digest',
    trust: 'local_development_unverified',
    previousVersion: null,
  };
  vi.spyOn(pluginsApi, 'list').mockResolvedValue([plugin]);
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  vi.spyOn(pluginsApi, 'previewInfo').mockResolvedValue({
    manifest: { ...manifest, version: '1.1.0' },
    packageDigest: 'preview-digest',
    trust: 'local_development_unverified',
    compatible: true,
  });
  const install = vi
      .spyOn(pluginsApi, 'install')
      .mockRejectedValue({ code: 'STORAGE', message: 'Commit failed' }),
    context = vi.spyOn(pluginsApi, 'context').mockResolvedValue();
  pinia = createPinia();
  mountManager();
  await settle();
  expect(root.querySelector('[aria-label="插件界面语言"]')).toBeNull();
  const plugins = usePluginsStore(pinia);
  const key = 'extension:dev.example:host:a';
  plugins.drafts[key] = {
    values: { content: 'unsaved' },
    output: null,
    dirty: true,
    revision: 'old',
  };
  vi.spyOn(pluginsApi, 'pick').mockResolvedValue('fixture.sdplugin');
  expect(root.querySelector('[aria-label="本地插件包路径"]')).toBeNull();
  const button = (text: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  button('选择插件包').click();
  await settle();
  const ack = document.querySelector<HTMLInputElement>('.plugin-install-ack input')!;
  ack.checked = true;
  ack.dispatchEvent(new Event('change'));
  await nextTick();
  button('升级插件').click();
  await nextTick();
  expect(plugins.prompt?.title).toBe('升级插件？');
  expect(install).not.toHaveBeenCalled();
  plugins.decide(false);
  await settle();
  expect(plugins.drafts[key]?.dirty).toBe(true);
  expect(context).not.toHaveBeenCalled();
  button('升级插件').click();
  await nextTick();
  plugins.decide(true);
  await settle();
  expect(context).toHaveBeenCalledWith('dev.example', null);
  expect(install).toHaveBeenCalledWith('fixture.sdplugin', true, '1.0.0', 'preview-digest');
  expect(plugins.drafts[key]).toBeUndefined();
  expect(plugins.installed[0]?.revision).toBe('old');
  expect(useNotificationsStore(pinia).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Commit failed', error: true })]),
  );
});

it('keeps only uninstall actions in the list and opens individual settings from the name', async () => {
  const items = systemPluginFixtures();
  items.push({
    ...items[1]!,
    source: 'user',
    manifest: { ...items[1]!.manifest, id: 'dev.upload', name: 'Uploaded Docker' },
  });
  items[1]!.enabled = true;
  vi.spyOn(pluginsApi, 'list').mockImplementation(async () => items.map((item) => ({ ...item })));
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const change = vi.spyOn(pluginsApi, 'setEnabled');
  pinia = createPinia();
  mountManager();
  await settle();
  const cards = root.querySelectorAll('[data-plugin-id]');
  expect(cards).toHaveLength(6);
  for (const card of cards) {
    expect(card.querySelectorAll('.plugin-row-actions button')).toHaveLength(1);
    expect(card.querySelector('.plugin-row-actions button')?.getAttribute('aria-label')).toMatch(
      /^卸载 /,
    );
    expect(card.textContent).not.toContain('权限');
    expect(card.textContent).not.toContain('系统内置');
    expect(card.textContent).not.toContain('用户上传');
  }
  const docker = root.querySelector('[data-plugin-id="cn.hiboot.plugins.docker"]')!;
  expect([...docker.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
    '禁用',
  );
  expect(change).not.toHaveBeenCalled();
  expect(docker.textContent).toContain('已启用');
});

it('accepts one native dropped package, previews it and requires acknowledgement before installing', async () => {
  native.enabled = true;
  vi.spyOn(pluginsApi, 'list').mockResolvedValue([]);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const item = systemPluginFixtures()[0]!;
  const preview = vi.spyOn(pluginsApi, 'previewInfo').mockResolvedValue({
    manifest: item.manifest,
    packageDigest: 'digest',
    trust: 'local_development_unverified',
    compatible: true,
  });
  const install = vi.spyOn(pluginsApi, 'install').mockResolvedValue(item);
  pinia = createPinia();
  mountManager();
  await settle();
  const zone = root.querySelector<HTMLElement>('[aria-label="插件上传区域"]')!;
  vi.spyOn(zone, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 20, 500, 160));
  const drop = (paths: string[]) =>
    native.listener!({ payload: { type: 'drop', paths, position: { x: 120, y: 60 } } });
  drop(['bad.zip']);
  await settle();
  expect(preview).not.toHaveBeenCalled();
  drop(['one.sdplugin', 'two.sdplugin']);
  await settle();
  expect(preview).not.toHaveBeenCalled();
  drop(['C:/plugins/resources.sdplugin']);
  await settle();
  expect(preview).toHaveBeenCalledWith('C:/plugins/resources.sdplugin');
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === '安装插件',
  )!;
  expect(button.disabled).toBe(true);
  expect(install).not.toHaveBeenCalled();
  const ack = document.querySelector<HTMLInputElement>('.plugin-install-ack input')!;
  ack.checked = true;
  ack.dispatchEvent(new Event('change'));
  await nextTick();
  button.click();
  await settle();
  expect(install).toHaveBeenCalledWith('C:/plugins/resources.sdplugin', true, null, 'digest');
  app.unmount();
  expect(native.release).toHaveBeenCalledOnce();
});
it('ignores late preview responses after a newer drop or closing the dialog', async () => {
  native.enabled = true;
  vi.spyOn(pluginsApi, 'list').mockResolvedValue([]);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  let first!: (value: unknown) => void;
  const item = systemPluginFixtures()[0]!;
  const result = {
    manifest: item.manifest,
    packageDigest: 'new',
    trust: 'local_development_unverified' as const,
    compatible: true,
  };
  vi.spyOn(pluginsApi, 'previewInfo')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve as typeof first;
        }),
    )
    .mockResolvedValueOnce(result);
  pinia = createPinia();
  mountManager();
  await settle();
  vi.spyOn(
    root.querySelector<HTMLElement>('[aria-label="插件上传区域"]')!,
    'getBoundingClientRect',
  ).mockReturnValue(new DOMRect(0, 0, 500, 200));
  const drop = (path: string) =>
    native.listener!({ payload: { type: 'drop', paths: [path], position: { x: 50, y: 50 } } });
  drop('old.sdplugin');
  drop('new.sdplugin');
  await settle();
  first({ ...result, manifest: { ...item.manifest, name: 'stale' } });
  await settle();
  expect(document.querySelector('.plugin-preview-heading')?.textContent).toContain('new.sdplugin');
  expect(document.querySelector('.plugin-preview-heading')?.textContent).not.toContain('stale');
});
