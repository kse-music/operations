import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
import NewRemoteFileDialog from './NewRemoteFileDialog.vue';

let app: App | undefined, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
function mount(busy = false, error: string | null = null) {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  root = document.createElement('div');
  document.body.append(root);
  const submit = vi.fn(),
    close = vi.fn();
  app = createApp(NewRemoteFileDialog, { busy, error, onSubmit: submit, onClose: close });
  app.mount(root);
  return { submit, close };
}
afterEach(() => {
  app?.unmount();
  root?.remove();
  setLocale('zh-CN');
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});
async function name(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[autofocus]')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}
function confirm() {
  document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}
it('provides a compact file name prompt and submits a literal Unicode name', async () => {
  const { submit } = mount();
  await nextTick();
  expect(document.querySelector('dialog')?.getAttribute('aria-label')).toBe('编辑文件');
  expect(document.querySelector<HTMLInputElement>('input[autofocus]')!.value).toBe('');
  expect(document.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  expect(
    [...document.querySelectorAll('footer button')].map((el) => el.textContent?.trim()),
  ).toEqual(['确定', '取消', '帮助']);
  await name("中文 ;$'file.conf");
  confirm();
  expect(submit).toHaveBeenCalledExactlyOnceWith("中文 ;$'file.conf");
});
it.each(['.', '..', 'a/b', '   '])('does not submit an invalid leaf name: %s', async (value) => {
  const { submit } = mount();
  await name(value);
  confirm();
  expect(submit).not.toHaveBeenCalled();
});
it('blocks submission and close during creation and displays the actual error', async () => {
  const { submit, close } = mount(true, '远程文件已创建，但未能打开编辑器');
  await nextTick();
  confirm();
  document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(submit).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>('input[autofocus]')!.disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('已创建');
});
it('localizes the name prompt and expands help within the dialog', async () => {
  setLocale('en-US');
  mount();
  await nextTick();
  expect(document.querySelector('dialog')?.getAttribute('aria-label')).toBe('Edit file');
  document.querySelector<HTMLButtonElement>('[aria-controls="new-file-help"]')!.click();
  await nextTick();
  expect(document.querySelector('#new-file-help')?.textContent).toContain('never overwritten');
});
