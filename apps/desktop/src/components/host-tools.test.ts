import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import HostTools from './HostTools.vue';
import { createPinia } from 'pinia';
import { usePluginsStore } from '../stores/plugins';
import { systemPluginFixtures } from '../services/system-plugins.fixture';

let app: App, root: HTMLDivElement;
function mount(props: InstanceType<typeof HostTools>['$props'], pinia = createPinia()) {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostTools, { ...props }).use(pinia);
  app.mount(root);
}
afterEach(() => {
  app?.unmount();
  root?.remove();
});

it.each([false, true])('scopes secondary tools to the selected host (local=%s)', (local) => {
  const navigate = vi.fn();
  mount({
    active: local ? 'terminals' : 'files',
    local,
    onNavigate: navigate,
  });
  expect(root.querySelectorAll('button')).toHaveLength(local ? 1 : 3);
  expect(root.querySelector('[aria-current="page"]')?.textContent).toContain(
    local ? '本地终端' : 'SFTP 文件',
  );
  root.querySelector<HTMLButtonElement>('[aria-current="page"]')!.click();
  expect(navigate).toHaveBeenCalledWith(local ? 'terminals' : 'files');
  expect(root.querySelector('[aria-label="网络诊断"]')).toBeNull();
  expect([...root.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(
    local ? ['本地终端'] : ['SSH 终端', 'SFTP 文件', '工具'],
  );
});
it('shows only enabled plugins once and opens them from the tools menu without host grants', async () => {
  const pinia = createPinia();
  const plugins = usePluginsStore(pinia);
  const items = systemPluginFixtures();
  items[0]!.enabled = true;
  items[1]!.enabled = true;
  items[1]!.source = 'user';
  items[1]!.manifest = { ...items[1]!.manifest, contributions: [] };
  plugins.installed = items;
  const select = vi.fn();
  mount({ active: 'terminals', local: false, onPlugin: select }, pinia);
  const trigger = root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  trigger.click();
  await nextTick();
  const menu = document.querySelector<HTMLElement>('[aria-label="已启用的插件"]')!;
  expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
  expect(
    menu.querySelector(`[data-plugin-id="${items[0]!.manifest.id}"] svg.lucide-activity`),
  ).not.toBeNull();
  expect(
    menu.querySelector(`[data-plugin-id="${items[1]!.manifest.id}"] svg.lucide-container`),
  ).not.toBeNull();
  expect(menu.textContent).not.toContain('进程与端口');
  menu.querySelector<HTMLButtonElement>(`[data-plugin-id="${items[1]!.manifest.id}"]`)!.click();
  await nextTick();
  expect(select).toHaveBeenCalledWith(items[1]!.manifest.id, '__details');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  trigger.click();
  await nextTick();
  document
    .querySelector('[role="menu"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  expect(document.activeElement).toBe(trigger);
  items[0]!.enabled = false;
  items[1]!.enabled = false;
  plugins.installed = [...items];
  trigger.click();
  await nextTick();
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('暂无已启用的插件');
});
