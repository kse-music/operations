import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import FilePropertiesDialog from './FilePropertiesDialog.vue';
import { filesApi } from '../services/files';
import type { FileEntry, PropertyResult } from '../types/files';

const entry: FileEntry = {
  name: 'folder',
  path: '/work/folder',
  kind: 'directory',
  size: 4096,
  modified: 1700000000,
  permissions: 0o755,
  uid: 0,
  gid: 1000,
};
const result: PropertyResult = {
  bytes: 1058,
  files: 2,
  directories: 3,
  skippedLinks: 1,
  changed: 0,
  checksum: null,
  cancelled: false,
  message: null,
};
let app: App, pinia: Pinia, root: HTMLElement;
const changed = vi.fn();
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const dialog = () => document.querySelector<HTMLDialogElement>('.file-properties-dialog')!;
const button = (text: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  )!;
const field = (text: string) =>
  [...dialog().querySelectorAll('label')]
    .find((item) => item.textContent?.trim() === text)!
    .querySelector<HTMLInputElement>('input')!;
async function input(text: string, value: string) {
  const item = field(text);
  item.value = value;
  item.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}
async function mount(value = entry) {
  vi.spyOn(filesApi, 'properties').mockResolvedValue({ ...value });
  start(value);
  await vi.waitFor(() => expect(dialog().querySelector('.permission-grid')).not.toBeNull());
}
function start(value = entry) {
  app = createApp(FilePropertiesDialog, {
    id: 'sftp-original',
    entry: value,
    onChanged: changed,
  }).use(pinia);
  app.mount(root);
}
beforeEach(() => {
  pinia = createPinia();
  root = document.createElement('div');
  document.body.append(root);
  changed.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
});
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root.remove();
  vi.restoreAllMocks();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});

it('synchronizes all permission bits with octal mode and blocks invalid values', async () => {
  await mount();
  expect(field('八进制表示').value).toBe('0755');
  const ownerWrite = dialog().querySelector<HTMLInputElement>('[aria-label="拥有者 W"]')!;
  expect(ownerWrite.checked).toBe(true);
  ownerWrite.click();
  await nextTick();
  expect(field('八进制表示').value).toBe('0555');
  field('设置 UID').click();
  await nextTick();
  expect(field('八进制表示').value).toBe('4555');
  await input('八进制表示', '1777');
  expect(field('粘附位').checked).toBe(true);
  expect(field('设置 UID').checked).toBe(false);
  await input('八进制表示', '0888');
  expect(button('应用').disabled).toBe(true);
  await input('八进制表示', '0644');
  await input('拥有者 UID', '4294967295');
  expect(button('应用').disabled).toBe(true);
});

it('requires explicit confirmation and freezes the original session, path and snapshot', async () => {
  await mount();
  const operation = vi
    .spyOn(filesApi, 'propertyOperation')
    .mockResolvedValue({ ...result, changed: 4 });
  await input('八进制表示', '0644');
  await input('拥有者 UID', '42');
  field('递归设置所有者、分组与权限').click();
  field('为目录的读取权限添加对应执行权限').click();
  await nextTick();
  button('应用').click();
  await nextTick();
  expect(operation).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain('中途失败或取消不会回退');
  button('确认应用').click();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(operation).toHaveBeenCalledWith('sftp-original', {
    requestId: expect.any(String),
    path: '/work/folder',
    operation: {
      kind: 'apply',
      change: {
        expected: entry,
        permissions: 0o644,
        uid: 42,
        gid: 1000,
        recursive: true,
        directoryExecute: true,
        confirmed: true,
      },
    },
  });
  await vi.waitFor(() => expect(dialog().textContent).toContain('已应用 4 个项目'));
});

it('shows incomplete directory totals and reports partial writes without hiding the failure', async () => {
  await mount();
  const operation = vi
    .spyOn(filesApi, 'propertyOperation')
    .mockResolvedValue({ ...result, message: '远程权限不足' });
  button('计算').click();
  await vi.waitFor(() => expect(dialog().textContent).toContain('统计不完整'));
  expect(dialog().textContent).toContain('2 个文件，2 个目录');
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('权限不足');
  operation.mockResolvedValue({ ...result, changed: 1, message: '后续目录权限不足' });
  await input('八进制表示', '0700');
  button('应用').click();
  await nextTick();
  button('确认应用').click();
  await vi.waitFor(() => expect(dialog().textContent).toContain('已应用 1 个项目'));
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('后续目录权限不足');
  expect(changed).toHaveBeenCalledOnce();
});

it('calculates SHA-256 for regular files and cancels exactly the pending operation', async () => {
  await mount({ ...entry, kind: 'file', permissions: 0o644 });
  const operation = vi
    .spyOn(filesApi, 'propertyOperation')
    .mockResolvedValue({ ...result, checksum: 'a'.repeat(64) });
  button('校验码').click();
  await nextTick();
  button('计算 SHA-256').click();
  await vi.waitFor(() =>
    expect(dialog().querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('a'.repeat(64)),
  );
  let finish!: (value: PropertyResult) => void;
  operation.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  button('计算 SHA-256').click();
  await nextTick();
  const pending = operation.mock.calls.at(-1)![1];
  const cancel = vi.spyOn(filesApi, 'propertyCancel').mockImplementation(async () => {
    finish({ ...result, cancelled: true, message: '已停止' });
  });
  button('停止').click();
  await vi.waitFor(() =>
    expect(cancel).toHaveBeenCalledExactlyOnceWith('sftp-original', pending.requestId),
  );
  await vi.waitFor(() => expect(dialog().textContent).toContain('已停止'));
  expect(dialog().querySelector('textarea')).toBeNull();
});

it('keeps links read only', async () => {
  await mount({ ...entry, kind: 'symlink' });
  expect(dialog().textContent).toContain('不修改或跟随目标');
  expect(button('应用').disabled).toBe(true);
  button('校验码').click();
  await nextTick();
  expect(button('计算 SHA-256').disabled).toBe(true);
});

it('cancels on unmount using the original session and request', async () => {
  await mount();
  const operation = vi
    .spyOn(filesApi, 'propertyOperation')
    .mockImplementation(() => new Promise(() => {}));
  const cancel = vi.spyOn(filesApi, 'propertyCancel').mockResolvedValue();
  button('计算').click();
  await nextTick();
  const pending = operation.mock.calls[0]![1];
  app.unmount();
  expect(cancel).toHaveBeenCalledExactlyOnceWith('sftp-original', pending.requestId);
});

it('shows property read failures and retries without using stale listing metadata', async () => {
  vi.spyOn(filesApi, 'properties')
    .mockRejectedValueOnce({ message: '读取失败' })
    .mockResolvedValueOnce(entry);
  start();
  await vi.waitFor(() =>
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('读取失败'),
  );
  expect(dialog().querySelector('.permission-grid')).toBeNull();
  button('重试').click();
  await vi.waitFor(() => expect(field('八进制表示').value).toBe('0755'));
});
