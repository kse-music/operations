import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import ServerView from './ServerView.vue';
import { usePluginsStore } from '../stores/plugins';
import { systemPluginFixtures } from '../services/system-plugins.fixture';
let app: App, root: HTMLDivElement, pinia: Pinia;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await nextTick();
};
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  app?.unmount();
  root.remove();
  disposePinia(pinia);
  vi.restoreAllMocks();
});
it('lists system and uploaded server contributions and opens settings for unavailable plugins', async () => {
  const plugins = usePluginsStore();
  const items = systemPluginFixtures();
  items.push({
    ...items[0]!,
    source: 'user',
    manifest: { ...items[0]!.manifest, id: 'dev.upload', name: 'Uploaded monitor' },
  });
  plugins.installed = items;
  plugins.loaded = true;
  vi.spyOn(plugins, 'refresh').mockResolvedValue();
  const manage = vi.fn(),
    open = vi.fn(),
    settings = vi.fn();
  app = createApp(ServerView, {
    hostId: 'a',
    onManage: manage,
    onPlugin: open,
    onSettings: settings,
  }).use(pinia);
  app.mount(root);
  await flush();
  expect(root.querySelectorAll('.plugin-card')).toHaveLength(2);
  expect(root.querySelector('.plugin-source')).toBeNull();
  expect(root.querySelector('.monitor-view, .operations-view')).toBeNull();
  root.querySelector<HTMLButtonElement>('.plugin-card button')!.click();
  await flush();
  expect(settings).toHaveBeenCalledWith(items[0]!.manifest.id);
  expect(open).not.toHaveBeenCalled();
  expect(manage).not.toHaveBeenCalled();
});
