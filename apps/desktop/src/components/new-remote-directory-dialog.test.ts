import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
import NewRemoteDirectoryDialog from './NewRemoteDirectoryDialog.vue';
import type { NewDirectorySettings } from '../types/files';

let app: App | undefined, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
function mount(settings?: NewDirectorySettings, busy = false) {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  const submit = vi.fn(),
    close = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(NewRemoteDirectoryDialog, {
    settings,
    busy,
    error: null,
    onSubmit: submit,
    onClose: close,
  });
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
const input = (selector: string) => document.querySelector<HTMLInputElement>(selector)!;
async function enter(selector: string, value: string) {
  const field = input(selector);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}
function submitForm() {
  document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}

it('defaults to a blank name and disabled 0755 permissions, then creates with server defaults', async () => {
  const { submit } = mount();
  await nextTick();
  expect(document.querySelector('dialog')?.getAttribute('aria-label')).toBe('创建文件夹');
  expect(input('input[autofocus]').value).toBe('');
  expect(input('.directory-mode input').value).toBe('0755');
  expect(input('[aria-label="拥有者 W"]').matches(':disabled')).toBe(true);
  expect(input('.directory-remember input').checked).toBe(false);
  expect(document.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  await enter('input[autofocus]', "中文 空格 ;$'目录");
  submitForm();
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    name: "中文 空格 ;$'目录",
    permissions: null,
    remember: false,
  });
});

it('synchronizes octal permissions, all special bits and checkboxes, and rejects invalid input', async () => {
  const { submit } = mount();
  await enter('input[autofocus]', 'folder');
  input('.directory-attributes > .checkbox-label input').click();
  await nextTick();
  input('[aria-label="组 W"]').click();
  await nextTick();
  expect(input('.directory-mode input').value).toBe('0775');
  await enter('.directory-mode input', '7700');
  expect(input('[aria-label="拥有者 X"]').checked).toBe(true);
  expect(input('[aria-label="组 R"]').checked).toBe(false);
  const special = [
    ...document.querySelectorAll<HTMLInputElement>(
      '.directory-permission-grid input:not([aria-label])',
    ),
  ];
  expect(special.map((field) => field.checked)).toEqual([true, true, true]);
  special[0]!.click();
  await nextTick();
  expect(input('.directory-mode input').value).toBe('3700');
  for (const value of ['888', '12', '07a5']) {
    await enter('.directory-mode input', value);
    submitForm();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('八进制');
    expect(submit).not.toHaveBeenCalled();
  }
  await enter('.directory-mode input', '0000');
  input('.directory-remember input').click();
  await nextTick();
  submitForm();
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    name: 'folder',
    permissions: 0,
    remember: true,
  });
});

it.each(['.', '..', 'a/b', '   '])('rejects an invalid folder name: %s', async (name) => {
  const { submit } = mount();
  await enter('input[autofocus]', name);
  submitForm();
  expect(submit).not.toHaveBeenCalled();
});

it('restores remembered zero permissions and blocks submission and close while busy', async () => {
  const { submit, close } = mount({ permissions: 0 }, true);
  await nextTick();
  expect(input('.directory-mode input').value).toBe('0000');
  expect(input('.directory-attributes > .checkbox-label input').checked).toBe(true);
  expect(input('.directory-remember input').checked).toBe(true);
  expect(input('input[autofocus]').disabled).toBe(true);
  expect(input('.directory-mode input').matches(':disabled')).toBe(true);
  document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
  submitForm();
  expect(submit).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it('shows localized help within the dialog', async () => {
  setLocale('en-US');
  mount();
  await nextTick();
  expect(document.querySelector('dialog')?.getAttribute('aria-label')).toBe('Create folder');
  document.querySelector<HTMLButtonElement>('[aria-controls="new-directory-help"]')!.click();
  await nextTick();
  expect(document.querySelector('#new-directory-help')?.textContent).toContain('SFTP session');
  expect(document.querySelector('#new-directory-help')?.textContent).toContain('umask');
});
