import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import PluginsView from './PluginsView.vue';
import { usePluginsStore } from '../stores/plugins';
import { useNotificationsStore } from '../stores/notifications';
import { pluginsApi } from '../services/plugins';
import type { InstalledPlugin, PluginManifest } from '../types/plugins';
import { systemPluginFixtures, toolPluginState } from '../services/system-plugins.fixture';
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
});
let app: App, root: HTMLDivElement, pinia: Pinia;
function mountManager(onSettings = vi.fn()) {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(PluginsView, { onSettings }).use(pinia);
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
  button('安装插件').click();
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

it('opens settings by name or gear for every installed plugin', async () => {
  const items = systemPluginFixtures();
  items.push({
    ...items[1]!,
    source: 'user',
    manifest: { ...items[1]!.manifest, id: 'dev.upload', name: 'Uploaded Docker' },
  });
  items[0]!.enabled = true;
  items[1]!.enabled = true;
  vi.spyOn(pluginsApi, 'list').mockImplementation(async () => items.map((item) => ({ ...item })));
  const { grants } = toolPluginState();
  vi.spyOn(pluginsApi, 'permissions').mockImplementation(async (id) => grants[id] ?? null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const change = vi.spyOn(pluginsApi, 'setEnabled');
  pinia = createPinia();
  const settings = vi.fn();
  mountManager(settings);
  await settle();
  const cards = root.querySelectorAll('[data-plugin-id]');
  expect(cards).toHaveLength(3);
  for (const card of cards) {
    expect(card.querySelector('.plugin-row-actions button[aria-label^="卸载 "]')).not.toBeNull();
    expect(card.textContent).not.toContain('权限');
    expect(card.querySelector('.plugin-source')?.textContent).toBe(
      card.getAttribute('data-plugin-id') === 'dev.upload' ? '用户上传' : '系统内置',
    );
    expect(card.querySelector('.plugin-identifier')?.textContent).toBe(
      card.getAttribute('data-plugin-id'),
    );
  }
  const docker = root.querySelector('[data-plugin-id="cn.hiboot.plugins.docker"]')!;
  expect([...docker.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
    '禁用',
  );
  expect(change).not.toHaveBeenCalled();
  expect(docker.textContent).toContain('已启用');
  docker.querySelector<HTMLButtonElement>('.plugin-name-button')!.click();
  expect(settings).toHaveBeenCalledWith('cn.hiboot.plugins.docker');
  const configuration = root.querySelectorAll<HTMLButtonElement>('button[aria-label^="配置 "]');
  expect(configuration).toHaveLength(3);
  for (const [index, button] of configuration.entries()) {
    button.click();
    expect(settings).toHaveBeenLastCalledWith(items[index]!.manifest.id);
  }
});

it('previews a selected package and requires acknowledgement before installing', async () => {
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
  vi.spyOn(pluginsApi, 'pick')
    .mockResolvedValueOnce('bad.zip')
    .mockResolvedValueOnce('C:/plugins/resources.sdplugin');
  pinia = createPinia();
  mountManager();
  await settle();
  expect(root.querySelector('[aria-label="插件上传区域"]')).toBeNull();
  const pick = root.querySelector<HTMLButtonElement>('.plugin-heading-actions .primary')!;
  pick.click();
  await settle();
  expect(preview).not.toHaveBeenCalled();
  pick.click();
  await settle();
  expect(preview).toHaveBeenCalledWith('C:/plugins/resources.sdplugin');
  const button = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
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
});
it('ignores late preview responses after unmounting the manager', async () => {
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
  vi.spyOn(pluginsApi, 'previewInfo').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        first = resolve as typeof first;
      }),
  );
  vi.spyOn(pluginsApi, 'pick').mockResolvedValue('fixture.sdplugin');
  pinia = createPinia();
  mountManager();
  await settle();
  root.querySelector<HTMLButtonElement>('.plugin-heading-actions .primary')!.click();
  await settle();
  app.unmount();
  first(result);
  await settle();
  expect(document.querySelector('.plugin-preview-heading')).toBeNull();
});

it('combines search, source and status filters and restores the list after clearing them', async () => {
  const items = systemPluginFixtures();
  items[0]!.enabled = true;
  items.push({
    ...items[0]!,
    source: undefined,
    enabled: false,
    manifest: {
      ...items[0]!.manifest,
      id: 'dev.upload',
      name: 'Uploaded Docker',
      author: 'Test Publisher',
    },
  });
  vi.spyOn(pluginsApi, 'list').mockResolvedValue(items);
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  pinia = createPinia();
  mountManager();
  await settle();
  const ids = () =>
    [...root.querySelectorAll('[data-plugin-id]')].map((card) =>
      card.getAttribute('data-plugin-id'),
    );
  const choose = async (label: string, value: string) => {
    const select = root.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await nextTick();
  };
  const search = root.querySelector<HTMLInputElement>('[aria-label="搜索插件"]')!;
  const query = async (value: string) => {
    search.value = value;
    search.dispatchEvent(new Event('input'));
    await nextTick();
  };
  await query('  DOCKER  ');
  expect(ids()).toEqual(['cn.hiboot.plugins.docker', 'dev.upload']);
  await choose('插件来源', 'user');
  expect(ids()).toEqual(['dev.upload']);
  await query('test publisher');
  expect(ids()).toEqual(['dev.upload']);
  await query('DEV.UPLOAD');
  expect(ids()).toEqual(['dev.upload']);
  await choose('插件状态', 'enabled');
  expect(ids()).toEqual([]);
  expect(root.querySelector('.plugin-empty')?.textContent).toContain('没有匹配的插件');
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '清除筛选')!
    .click();
  await nextTick();
  expect(ids()).toHaveLength(3);
  expect(search.value).toBe('');
  await choose('插件状态', 'disabled');
  expect(ids()).toEqual(['cn.hiboot.plugins.assistant', 'dev.upload']);
  expect(root.querySelector('.plugin-filter-summary')?.textContent).toContain('显示 2 / 3 个');
});

it('shows initial loading and a retryable error instead of an empty success state', async () => {
  let reject!: (cause: unknown) => void;
  vi.spyOn(pluginsApi, 'list')
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue([]);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  pinia = createPinia();
  mountManager();
  await nextTick();
  expect(root.textContent).toContain('正在读取插件…');
  reject({ message: 'Repository unavailable' });
  await settle();
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('Repository unavailable');
  expect(root.textContent).not.toContain('还没有安装插件');
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '重试')!
    .click();
  await settle();
  expect(root.querySelector('[role="alert"]')).toBeNull();
  expect(root.querySelector('.plugin-empty')?.textContent).toContain('还没有安装插件');
});

it('requires uninstall confirmation and preserves plugin data by default', async () => {
  const item = systemPluginFixtures()[0]!;
  vi.spyOn(pluginsApi, 'list').mockResolvedValue([item]);
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const uninstall = vi.spyOn(pluginsApi, 'uninstall').mockResolvedValue();
  pinia = createPinia();
  mountManager();
  await settle();
  root.querySelector<HTMLButtonElement>('.plugin-remove-button')!.click();
  await nextTick();
  expect(uninstall).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.checked).toBe(
    false,
  );
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')]
    .find((button) => button.textContent?.trim() === '确认卸载')!
    .click();
  await settle();
  expect(uninstall).toHaveBeenCalledWith(item.manifest.id, false, true);
  expect(document.querySelector('dialog')).toBeNull();
});
