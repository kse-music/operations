import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import NotificationToasts from './NotificationToasts.vue';
import { useNotificationsStore } from '../stores/notifications';

let app: App, pinia: Pinia, root: HTMLDivElement;
const flush = async () => {
  await nextTick();
  await nextTick();
};
beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(NotificationToasts).use(pinia);
  app.mount(root);
  await flush();
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  root.remove();
  document.querySelectorAll('dialog, form').forEach((element) => element.remove());
});

it('keeps a single dismissible alert inside the active dialog, then returns it to the page', async () => {
  const notifications = useNotificationsStore();
  notifications.push('保存设置失败', true);
  notifications.push('保存设置失败', true);
  await flush();
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(root.textContent).toBe('');
  const dialog = document.createElement('dialog');
  dialog.open = true;
  document.body.append(dialog);
  await flush();
  expect(dialog.querySelector('.toast[role="alert"]')?.textContent).toContain('保存设置失败');
  const nested = document.createElement('dialog');
  nested.open = true;
  document.body.append(nested);
  await flush();
  expect(nested.querySelector('.toast-stack')).not.toBeNull();
  nested.remove();
  await flush();
  expect(dialog.querySelector('.toast-stack')).not.toBeNull();
  dialog.remove();
  await flush();
  expect(document.querySelector('.toast-stack')?.parentElement).toBe(document.body);
  document.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')!.click();
  await flush();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it('replaces browser field validation bubbles with one toast and focuses the first invalid field', async () => {
  const form = document.createElement('form');
  form.innerHTML = '<input aria-label="主机地址" required><input aria-label="用户名" required>';
  document.body.append(form);
  const first = form.querySelector('input')!;
  expect(form.reportValidity()).toBe(false);
  await flush();
  expect(document.activeElement).toBe(first);
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('主机地址：');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(first.validationMessage);
});
