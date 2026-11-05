import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import PluginDialogs from './PluginDialogs.vue';
import { usePluginsStore } from '../stores/plugins';

let app: App, root: HTMLElement, pinia: Pinia;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(PluginDialogs).use(pinia);
  app.mount(root);
});
afterEach(() => {
  app?.unmount();
  root?.remove();
  if (pinia) disposePinia(pinia);
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
});

it.each(['确认删除', '取消', '关闭对话框'])(
  'shows the frozen image and resolves %s without typing a target',
  async (action) => {
    const plugins = usePluginsStore();
    const target = `sha256:${'a'.repeat(64)}`;
    const review = plugins.ask('删除镜像？', '不强制删除，不删除卷。', undefined, {
      imageId: target,
      hostName: 'Production',
      hostAddress: 'operator@192.0.2.10:22',
      pluginName: 'Docker 管理',
      pluginVersion: '1.5.1',
    });
    await nextTick();
    const dialog = document.querySelector<HTMLDialogElement>('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain(target);
    expect(dialog.textContent).toContain('operator@192.0.2.10:22');
    expect(dialog.textContent).toContain('Docker 管理 v1.5.1');
    expect(dialog.textContent).toContain('60 秒内有效');
    expect(dialog.querySelector('input')).toBeNull();
    const button = [...dialog.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === action || node.getAttribute('aria-label') === action,
    )!;
    expect(button.disabled).toBe(false);
    button.click();
    expect(await review).toBe(action === '确认删除');
    await nextTick();
    expect(document.querySelector('dialog')).toBeNull();
  },
);

it('retains required confirmation text for other plugin operations', async () => {
  const plugins = usePluginsStore();
  const review = plugins.ask('执行计划', '检查完整计划', 'approve plan');
  await nextTick();
  const button = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
    (node) => node.textContent?.trim() === '明确确认',
  )!;
  expect(button.disabled).toBe(true);
  const input = document.querySelector<HTMLInputElement>('[aria-label="插件操作确认文字"]')!;
  input.value = 'approve plan';
  input.dispatchEvent(new Event('input'));
  await nextTick();
  expect(button.disabled).toBe(false);
  button.click();
  expect(await review).toBe(true);
});
