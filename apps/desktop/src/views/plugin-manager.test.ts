import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import PluginsView from './PluginsView.vue';
import { usePluginsStore } from '../stores/plugins';
import { useNotificationsStore } from '../stores/notifications';
import { pluginsApi } from '../services/plugins';
import type {
  InstalledPlugin,
  PluginInventory,
  PluginManifest,
  PluginRuntimeStatus,
} from '../types/plugins';
import { systemPluginFixtures, toolPluginState } from '../services/system-plugins.fixture';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
beforeEach(() => {
  vi.spyOn(pluginsApi, 'inventory').mockImplementation(async () => ({
    installed: await pluginsApi.list(),
    problems: [],
    availableBundled: [],
  }));
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
  setLocale('zh-CN');
  app?.unmount();
  root?.remove();
  if (pinia) disposePinia(pinia);
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
it('keeps the refresh button stable during polling and disables it during manual refresh', async () => {
  const item = systemPluginFixtures()[0]!;
  vi.spyOn(pluginsApi, 'list').mockResolvedValue([item]);
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  const statuses = vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  pinia = createPinia();
  mountManager();
  await nextTick();
  const refresh = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === '刷新',
  )!;
  expect(refresh.disabled).toBe(true);
  await settle();
  expect(refresh.disabled).toBe(false);
  const card = root.querySelector('.plugin-installed-row');
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const plugins = usePluginsStore(pinia);
  plugins.start();
  await settle();
  const inventoryReads = vi.mocked(pluginsApi.inventory).mock.calls.length;
  const permissionReads = vi.mocked(pluginsApi.permissions).mock.calls.length;
  for (const state of ['active', 'crashed'] as const) {
    let finish!: (value: PluginRuntimeStatus[]) => void;
    statuses.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh.disabled).toBe(false);
    expect(root.querySelector('.plugin-installed-row')).toBe(card);
    expect(root.textContent).not.toContain('正在读取插件…');
    finish([
      { id: item.manifest.id, revision: item.revision, state, errorCode: null, diagnostic: null },
    ]);
    await settle();
    expect(plugins.statuses[0]?.state).toBe(state);
    expect(pluginsApi.inventory).toHaveBeenCalledTimes(inventoryReads);
    expect(pluginsApi.permissions).toHaveBeenCalledTimes(permissionReads);
    expect(refresh.disabled).toBe(false);
  }
  let finish!: (value: PluginInventory) => void;
  vi.mocked(pluginsApi.inventory).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  refresh.click();
  await nextTick();
  expect(refresh.disabled).toBe(true);
  finish({ installed: [item], problems: [], availableBundled: [] });
  await settle();
  expect(refresh.disabled).toBe(false);
});
it('reuses the installed list when returning to settings and still refreshes on request', async () => {
  vi.spyOn(pluginsApi, 'list').mockResolvedValue(systemPluginFixtures());
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  pinia = createPinia();
  mountManager();
  await settle();
  app.unmount();
  root.remove();
  mountManager();
  await nextTick();
  expect(root.querySelectorAll('.plugin-installed-row')).toHaveLength(2);
  expect(root.textContent).not.toContain('正在读取插件…');
  expect(pluginsApi.inventory).toHaveBeenCalledTimes(1);
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '刷新')!
    .click();
  await settle();
  expect(pluginsApi.inventory).toHaveBeenCalledTimes(2);
});
it('requires explicit upgrade approval; cancelled upgrade preserves schemas and failure clears stale bindings', async () => {
  const manifest: PluginManifest = {
    schemaVersion: 1,
    id: 'dev.example',
    name: 'Example',
    version: '1.0.0',
    author: 'Developer',
    description: '',
    apiVersion: '^5.0.0',
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
  });
  const install = vi
      .spyOn(pluginsApi, 'install')
      .mockRejectedValue({ code: 'STORAGE', message: 'Commit failed' }),
    context = vi.spyOn(pluginsApi, 'reset').mockResolvedValue();
  vi.spyOn(pluginsApi, 'scopeVisibility').mockResolvedValue();
  vi.spyOn(pluginsApi, 'closeScope').mockResolvedValue();
  vi.spyOn(pluginsApi, 'cancelScope').mockResolvedValue();
  pinia = createPinia();
  mountManager();
  await settle();
  expect(root.querySelector('[aria-label="插件界面语言"]')).toBeNull();
  const plugins = usePluginsStore(pinia);
  const ui = {
    uiVersion: 4 as const,
    title: 'Test',
    pages: [],
    frontend: { script: 'frontend.js', style: 'frontend.css' },
  };
  plugins.schemas['dev.example'] = { revision: 'old', ui };
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
  expect(plugins.schemas['dev.example']?.revision).toBe('old');
  expect(context).not.toHaveBeenCalled();
  button('升级插件').click();
  await nextTick();
  plugins.decide(true);
  await settle();
  expect(context).toHaveBeenCalledWith('dev.example');
  expect(install).toHaveBeenCalledWith('fixture.sdplugin', true, '1.0.0', 'preview-digest');
  expect(plugins.schemas['dev.example']).toBeUndefined();
  expect(plugins.installed[0]?.revision).toBe('old');
  expect(useNotificationsStore(pinia).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Commit failed', error: true })]),
  );
});

it('shows package build times in Beijing time and preserves missing historical metadata', async () => {
  const items = systemPluginFixtures();
  items[0]!.manifest = { ...items[0]!.manifest, builtAt: Date.UTC(2026, 10, 13, 0, 30, 45) };
  const legacyManifest = { ...items[1]!.manifest };
  delete legacyManifest.builtAt;
  items[1]!.manifest = legacyManifest;
  vi.spyOn(pluginsApi, 'list').mockResolvedValue(items);
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  pinia = createPinia();
  mountManager();
  await settle();
  const cards = root.querySelectorAll('.plugin-installed-row');
  const time = cards[0]!.querySelector('time')!;
  expect(time.dateTime).toBe('2026-11-13T00:30:45.000Z');
  expect(time.textContent).toBe('2026-11-13 08:30:45');
  expect(cards[0]!.querySelector('.plugin-build-time')?.textContent?.trim()).toBe(
    '2026-11-13 08:30:45',
  );
  expect(cards[0]!.querySelector('.plugin-build-time')?.getAttribute('title')).toBe('北京时间');
  expect(cards[1]!.querySelector('.plugin-build-time')?.textContent).toContain('未提供');
  expect(cards[1]!.querySelector('time')).toBeNull();

  setLocale('en-US');
  await nextTick();
  expect(time.textContent).toBe('2026-11-13 08:30:45');
  expect(cards[0]!.querySelector('.plugin-build-time')?.textContent?.trim()).toBe(
    '2026-11-13 08:30:45',
  );
  expect(cards[0]!.querySelector('.plugin-build-time')?.getAttribute('title')).toBe('Beijing time');
  expect(cards[1]!.querySelector('.plugin-build-time')?.textContent).toContain('Not provided');
  await usePluginsStore(pinia).refresh();
  expect(time.dateTime).toBe('2026-11-13T00:30:45.000Z');
  usePluginsStore(pinia).installed[0]!.manifest.builtAt = 0;
  await nextTick();
  expect(time.dateTime).toBe('1970-01-01T00:00:00.000Z');
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
  expect(docker.querySelector('.plugin-toggle-button')?.textContent?.trim()).toBe('禁用');
  expect(docker.querySelector('.plugin-toggle-button')?.getAttribute('aria-label')).toBe(
    '禁用 Docker 管理',
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

it.each(['system', 'user'] as const)(
  'enables a %s plugin from the list without opening settings or changing its permissions',
  async (source) => {
    let item = { ...systemPluginFixtures()[0]!, source };
    vi.spyOn(pluginsApi, 'list').mockImplementation(async () => [{ ...item }]);
    const { grants } = toolPluginState();
    const grant = source === 'system' ? grants[item.manifest.id]! : null;
    vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(grant);
    vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
    const authorize = vi.spyOn(pluginsApi, 'grant');
    const change = vi.spyOn(pluginsApi, 'setEnabled').mockImplementation(async (_id, enabled) => {
      item = { ...item, enabled };
      return item;
    });
    pinia = createPinia();
    const settings = vi.fn();
    mountManager(settings);
    await settle();
    const status = root.querySelector<HTMLSelectElement>('[aria-label="插件状态"]')!;
    status.value = 'disabled';
    status.dispatchEvent(new Event('change'));
    await nextTick();
    root.querySelector<HTMLButtonElement>(`[aria-label="启用 ${item.manifest.name}"]`)!.click();
    await settle();
    expect(change).toHaveBeenCalledExactlyOnceWith(item.manifest.id, true);
    expect(settings).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(usePluginsStore(pinia).grants[item.manifest.id]).toEqual(grant);
    expect(root.querySelector('[data-plugin-id]')).toBeNull();
    expect(root.querySelector('.plugin-filter-summary')?.textContent).toContain('1 个已启用');
    status.value = 'all';
    status.dispatchEvent(new Event('change'));
    await nextTick();
    expect(root.querySelector('.plugin-status')?.textContent).toBe('已启用');
    expect(root.querySelector(`[aria-label="禁用 ${item.manifest.name}"]`)).not.toBeNull();
  },
);

it('confirms disabling from the list and only clears plugin drafts after an accepted change', async () => {
  let item = { ...systemPluginFixtures()[0]!, enabled: true };
  vi.spyOn(pluginsApi, 'list').mockImplementation(async () => [{ ...item }]);
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const change = vi.spyOn(pluginsApi, 'setEnabled').mockImplementation(async (_id, enabled) => {
    item = { ...item, enabled };
    return item;
  });
  pinia = createPinia();
  mountManager();
  await settle();
  const plugins = usePluginsStore(pinia);
  plugins.setDraftDirty('test-page', item.manifest.id, true);
  const button = root.querySelector<HTMLButtonElement>('.plugin-toggle-button')!;
  button.click();
  await nextTick();
  expect(plugins.prompt?.title).toBe('禁用插件？');
  expect(change).not.toHaveBeenCalled();
  plugins.decide(false);
  await settle();
  expect(change).not.toHaveBeenCalled();
  expect(plugins.dirty).toBe(true);
  expect(root.querySelector('.plugin-status')?.textContent).toBe('已启用');
  button.click();
  await nextTick();
  plugins.decide(true);
  await settle();
  expect(change).toHaveBeenCalledExactlyOnceWith(item.manifest.id, false);
  expect(plugins.dirty).toBe(false);
  expect(root.querySelector('.plugin-status')?.textContent).toBe('已禁用');
  expect(button.getAttribute('aria-label')).toBe(`启用 ${item.manifest.name}`);
});

it('blocks duplicate list actions while toggling and preserves state when enabling fails', async () => {
  const items = systemPluginFixtures();
  vi.spyOn(pluginsApi, 'list').mockResolvedValue(items);
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  let reject!: (cause: unknown) => void;
  const change = vi.spyOn(pluginsApi, 'setEnabled').mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  pinia = createPinia();
  mountManager();
  await settle();
  const plugins = usePluginsStore(pinia);
  const clear = vi.spyOn(plugins, 'clearPlugin');
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('.plugin-toggle-button')];
  buttons[0]!.click();
  await nextTick();
  expect(buttons.every((button) => button.disabled)).toBe(true);
  buttons[0]!.click();
  buttons[1]!.click();
  expect(change).toHaveBeenCalledTimes(1);
  expect(root.querySelector('.plugin-status')?.textContent).toBe('已禁用');
  reject({ code: 'PERMISSION_DENIED', message: '启用插件失败' });
  await settle();
  expect(plugins.error).toBe('启用插件失败');
  expect(plugins.installed.every((plugin) => !plugin.enabled)).toBe(true);
  expect(clear).not.toHaveBeenCalled();
  expect(buttons.every((button) => !button.disabled)).toBe(true);
  expect(useNotificationsStore(pinia).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: '启用插件失败', error: true })]),
  );
});

it('shows an additional system plugin from the host list without a built-in UI registration', async () => {
  const items = systemPluginFixtures();
  const extra: InstalledPlugin = {
    ...items[0]!,
    manifest: {
      ...items[0]!.manifest,
      id: 'org.example.new-tool',
      name: '新增内置工具',
      icon: 'database',
    },
    enabled: true,
    revision: 'new-system-plugin',
  };
  items.push(extra);
  vi.spyOn(pluginsApi, 'list').mockResolvedValue(items);
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  pinia = createPinia();
  const settings = vi.fn();
  mountManager(settings);
  await settle();
  expect(root.querySelectorAll('[data-plugin-id]')).toHaveLength(3);
  const card = root.querySelector('[data-plugin-id="org.example.new-tool"]')!;
  expect(card.textContent).toContain('新增内置工具');
  expect(card.querySelector('.plugin-source')?.textContent).toBe('系统内置');
  expect(card.querySelector('.plugin-status')?.textContent).toBe('已启用');
  expect(card.querySelector('svg.lucide-database')).not.toBeNull();
  card.querySelector<HTMLButtonElement>('.plugin-name-button')!.click();
  expect(settings).toHaveBeenCalledWith(extra.manifest.id);
});

it('previews a selected package and requires acknowledgement before installing', async () => {
  vi.spyOn(pluginsApi, 'list').mockResolvedValue([]);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const item = systemPluginFixtures()[0]!;
  const preview = vi.spyOn(pluginsApi, 'previewInfo').mockResolvedValue({
    manifest: item.manifest,
    packageDigest: 'digest',
    trust: 'local_development_unverified',
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

it('offers a missing bundled plugin for explicit restore and keeps it disabled after installation', async () => {
  const [docker, assistant] = systemPluginFixtures();
  let restored = false;
  vi.mocked(pluginsApi.inventory).mockImplementation(async () => ({
    installed: restored ? [docker!, assistant!] : [assistant!],
    availableBundled: restored ? [] : [docker!.manifest],
    problems: [],
  }));
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const enable = vi.spyOn(pluginsApi, 'setEnabled');
  let finish!: () => void;
  const restore = vi.spyOn(pluginsApi, 'reinstallBundled').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => {
          restored = true;
          resolve(docker!);
        };
      }),
  );
  pinia = createPinia();
  mountManager();
  await settle();
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === text,
    )!;
  const source = root.querySelector<HTMLSelectElement>('[aria-label="插件来源"]')!;
  source.value = 'user';
  source.dispatchEvent(new Event('change'));
  await nextTick();
  button('恢复内置插件').click();
  await nextTick();
  expect(document.querySelector('dialog')?.textContent).toContain('Docker 管理');
  expect(document.querySelector('dialog')?.textContent).toContain('恢复后默认禁用');
  expect(restore).not.toHaveBeenCalled();
  button('取消').click();
  await nextTick();
  expect(restore).not.toHaveBeenCalled();
  button('恢复内置插件').click();
  await nextTick();
  button('恢复安装').click();
  await nextTick();
  expect(restore).toHaveBeenCalledExactlyOnceWith(docker!.manifest.id, null, true);
  expect(button('恢复安装').disabled).toBe(true);
  expect(button('取消').disabled).toBe(true);
  finish();
  await settle();
  expect(document.querySelector('dialog')).toBeNull();
  expect(root.querySelector(`[data-plugin-id="${docker!.manifest.id}"]`)?.textContent).toContain(
    '已禁用',
  );
  expect(root.textContent).not.toContain('恢复内置插件');
  expect(source.value).toBe('all');
  expect(enable).not.toHaveBeenCalled();
});

it('keeps a failed bundled restore open for retry with its error visible', async () => {
  const docker = systemPluginFixtures()[0]!;
  vi.mocked(pluginsApi.inventory).mockResolvedValue({
    installed: [],
    problems: [],
    availableBundled: [docker.manifest],
  });
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const restore = vi
    .spyOn(pluginsApi, 'reinstallBundled')
    .mockRejectedValue({ message: 'Plugin storage unavailable' });
  pinia = createPinia();
  mountManager();
  await settle();
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === '恢复内置插件')!
    .click();
  await nextTick();
  document.querySelector<HTMLButtonElement>('dialog [aria-label="恢复 Docker 管理"]')!.click();
  await settle();
  expect(restore).toHaveBeenCalledExactlyOnceWith(docker.manifest.id, null, true);
  expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain(
    'Plugin storage unavailable',
  );
  expect(
    document.querySelector<HTMLButtonElement>('dialog [aria-label="恢复 Docker 管理"]')?.disabled,
  ).toBe(false);
  expect(root.querySelector('.plugin-installed-row')).toBeNull();
});

it('shows invalid plugin records beside healthy plugins and requires explicit reinstall confirmation', async () => {
  const healthy = systemPluginFixtures()[0]!;
  const problem = {
    id: 'cn.hiboot.plugins.assistant',
    code: 'PLUGIN_RECORD_INVALID',
    message: '安装记录格式不受当前版本支持',
    recordDigest: 'frozen-digest',
    replacement: { name: 'AI 运维助手', version: '2.0.0' },
  };
  vi.mocked(pluginsApi.inventory).mockResolvedValue({
    installed: [healthy],
    problems: [problem],
    availableBundled: [],
  });
  vi.spyOn(pluginsApi, 'permissions').mockResolvedValue(null);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const reinstall = vi
    .spyOn(pluginsApi, 'reinstallBundled')
    .mockResolvedValue({ ...healthy, enabled: false });
  pinia = createPinia();
  mountManager();
  await settle();
  expect(root.querySelectorAll('.plugin-installed-row')).toHaveLength(1);
  expect(root.querySelector('[aria-label="未加载的插件"]')?.textContent).toContain('AI 运维助手');
  expect(root.textContent).not.toContain('插件列表加载失败');
  const click = async (text: string) => {
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === text)!
      .click();
    await settle();
  };
  await click('备份并重装');
  expect(document.querySelector('dialog')?.textContent).toContain('原版本文件和插件配置保留');
  expect(reinstall).not.toHaveBeenCalled();
  await click('取消');
  expect(reinstall).not.toHaveBeenCalled();
  await click('备份并重装');
  vi.mocked(pluginsApi.inventory).mockResolvedValue({
    installed: [healthy],
    problems: [],
    availableBundled: [],
  });
  await click('确认备份并重装');
  expect(reinstall).toHaveBeenCalledExactlyOnceWith(problem.id, 'frozen-digest', true);
  expect(document.querySelector('dialog')).toBeNull();
  expect(root.querySelector('[aria-label="未加载的插件"]')).toBeNull();
});
it('keeps a failed reinstall visible for retry and offers no bundled replacement for arbitrary uploads', async () => {
  const problem = {
    id: 'dev.invalid-upload',
    code: 'PLUGIN_RECORD_INVALID',
    message: '记录已损坏',
    recordDigest: 'digest',
    replacement: null,
  };
  vi.mocked(pluginsApi.inventory).mockResolvedValue({
    installed: [],
    problems: [problem],
    availableBundled: [],
  });
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  pinia = createPinia();
  mountManager();
  await settle();
  expect(root.textContent).toContain('dev.invalid-upload');
  expect(root.textContent).toContain('重新构建插件');
  expect(root.textContent).not.toContain('备份并重装');
  expect(root.textContent).not.toContain('还没有安装插件');
  const p = usePluginsStore(pinia);
  p.problems = [
    {
      ...problem,
      id: 'cn.hiboot.plugins.docker',
      replacement: { name: 'Docker', version: '2.0.0' },
    },
  ];
  await nextTick();
  const reinstall = vi
    .spyOn(pluginsApi, 'reinstallBundled')
    .mockRejectedValue({ message: '记录已变化，请刷新' });
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '备份并重装')!
    .click();
  await nextTick();
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')]
    .find((button) => button.textContent?.trim() === '确认备份并重装')!
    .click();
  await settle();
  expect(reinstall).toHaveBeenCalledOnce();
  expect(document.querySelector('dialog')).not.toBeNull();
  expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('记录已变化');
});
