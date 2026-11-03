import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import FilesView from './FilesView.vue';
import { useFilesStore } from '../stores/files';
import { useHostsStore } from '../stores/hosts';
import { filesApi } from '../services/files';
import { hostInput } from '../types/hosts';
import type { FileEntry } from '../types/files';

const release = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => release) }),
}));
let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const entry: FileEntry = {
  name: 'config',
  path: '/srv/api/config',
  kind: 'directory',
  size: null,
  modified: null,
  permissions: 0o755,
  uid: 1000,
  gid: 1000,
};
beforeEach(async () => {
  pinia = createPinia();
  const host = {
    ...hostInput(),
    id: 'a',
    name: 'API',
    hostname: '192.0.2.11',
    username: 'operator',
    createdAt: '',
    updatedAt: '',
  };
  const hosts = useHostsStore(pinia),
    files = useFilesStore(pinia);
  hosts.catalog = { hosts: [host], groups: [], credentials: [], pendingSecretDeletions: 0 };
  files.active = 'a';
  files.local = { path: 'D:/test', parent: null, entries: [] };
  files.connections.a = {
    host,
    id: 'sftp-a',
    state: 'connected',
    error: null,
    trust: null,
    path: '/srv/api',
    listing: { path: '/srv/api', parent: '/srv', entries: [entry] },
    loading: false,
  };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(FilesView, { hostId: 'a' }).use(pinia);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  app.mount(root);
  await nextTick();
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

it('uses the existing SFTP connection to navigate and keeps it alive when the page unmounts', async () => {
  const list = vi
    .spyOn(filesApi, 'list')
    .mockResolvedValue({ path: '/srv/api/config', parent: '/srv/api', entries: [] });
  const close = vi.spyOn(filesApi, 'close');
  root.querySelector('.file-name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await vi.waitFor(() => expect(useFilesStore(pinia).current?.path).toBe('/srv/api/config'));
  expect(list).toHaveBeenCalledWith('sftp-a', '/srv/api/config');
  expect(root.querySelector('[aria-label="本地路径"]')).not.toBeNull();
  expect(root.querySelector('[aria-label="选择上传文件…"]')).not.toBeNull();
  app!.unmount();
  app = undefined;
  expect(close).not.toHaveBeenCalled();
  expect(useFilesStore(pinia).connections.a?.id).toBe('sftp-a');
  expect(release).toHaveBeenCalled();
});

it('opens the existing upload confirmation with the current session and destination', async () => {
  vi.spyOn(filesApi, 'pick').mockResolvedValue(['D:/test/release.tar.gz']);
  const start = vi.spyOn(filesApi, 'start');
  root.querySelector<HTMLButtonElement>('[aria-label="选择上传文件…"]')!.click();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog[aria-label="确认文件传输"]')).not.toBeNull(),
  );
  const dialog = document.querySelector('dialog[aria-label="确认文件传输"]')!;
  expect(dialog.textContent).toContain('API');
  expect(dialog.querySelector<HTMLInputElement>('[aria-label="传输目标目录"]')?.value).toBe(
    '/srv/api',
  );
  expect(start).not.toHaveBeenCalled();
  const conflict = dialog.querySelector<HTMLSelectElement>('[aria-label="冲突处理"]')!;
  conflict.value = 'overwrite';
  conflict.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')?.required).toBe(true);
});

it('keeps failures retryable and retains the established endpoint when host settings change', async () => {
  const files = useFilesStore(pinia),
    hosts = useHostsStore(pinia);
  hosts.catalog!.hosts[0] = { ...hosts.catalog!.hosts[0]!, hostname: 'changed.example' };
  const list = vi
    .spyOn(filesApi, 'list')
    .mockRejectedValue({ code: 'SFTP_NETWORK', message: '连接中断' });
  root.querySelector<HTMLButtonElement>('[aria-label="刷新远程"]')!.click();
  await vi.waitFor(() => expect(files.current?.state).toBe('failed'));
  expect(list).toHaveBeenCalledWith('sftp-a', '/srv/api');
  expect(files.current?.error).toBe('连接中断');
  await nextTick();
  expect(files.current?.host).toMatchObject({ hostname: '192.0.2.11', username: 'operator' });
  expect(
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === '连接 SFTP',
    )?.disabled,
  ).toBe(false);
});
