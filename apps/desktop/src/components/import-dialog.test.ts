import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import ImportDialog from './ImportDialog.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import { hostInput } from '../types/hosts';

let app: App, pinia: Pinia, root: HTMLDivElement;
const originals = ['showPopover', 'hidePopover', 'scrollIntoView'].map(
  (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
);
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const groups = [
  { id: 'child', name: '上海', parentId: 'parent', sortOrder: 0 },
  { id: 'parent', name: '生产', parentId: null, sortOrder: 0 },
  { id: 'empty', name: '空目录', parentId: 'parent', sortOrder: 0 },
  { id: 'study', name: 'study', parentId: null, sortOrder: 0 },
];
const trigger = () => document.querySelector<HTMLButtonElement>('#openssh-import-group')!;
const tree = () => document.querySelector<HTMLElement>('.host-folder-tree')!;
const rows = () => [...tree().querySelectorAll<HTMLElement>('[role="treeitem"]')];
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  )!;
const closed = vi.fn();

beforeEach(() => {
  for (const [name, state] of [
    ['showPopover', 'open'],
    ['hidePopover', 'closed'],
  ] as const)
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value(this: HTMLElement) {
        const event = new Event('beforetoggle');
        Object.defineProperty(event, 'newState', { value: state });
        this.dispatchEvent(event);
      },
    });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  useHostsStore().catalog = { hosts: [], groups, credentials: [], pendingSecretDeletions: 0 };
  root = document.createElement('div');
  document.body.append(root);
  closed.mockClear();
  app = createApp(ImportDialog, { onClose: closed }).use(pinia);
  app.mount(root);
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  root.remove();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});
async function key(value: string): Promise<void> {
  trigger().dispatchEvent(
    new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
  );
  await nextTick();
}
async function select(name: string): Promise<void> {
  trigger().click();
  await nextTick();
  rows()
    .find((row) => row.getAttribute('aria-label') === name)!
    .click();
  await nextTick();
}
async function preview(): Promise<void> {
  vi.spyOn(hostsApi, 'preview').mockResolvedValue({
    warnings: [],
    candidates: [
      {
        alias: 'web-prod',
        jumpAlias: null,
        host: { ...hostInput(), name: 'web-prod', hostname: '192.0.2.10', username: 'deploy' },
        identityFile: null,
        warnings: [],
        blocked: false,
        duplicate: false,
      },
    ],
  });
  const text = document.querySelector<HTMLTextAreaElement>('textarea')!;
  text.value = 'Host web-prod\n  HostName 192.0.2.10\n  User deploy';
  text.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  button('生成导入预览').click();
  await vi.waitFor(() => expect(document.querySelector('.import-preview')).not.toBeNull());
  const acknowledge = document.querySelector<HTMLInputElement>('.import-confirm input')!;
  acknowledge.click();
  await nextTick();
}

it('renders root, nested and empty folders in parent order and collapses without selecting', async () => {
  trigger().click();
  await nextTick();
  expect(tree().closest('dialog')).not.toBeNull();
  expect(rows().map((row) => [row.textContent?.trim(), row.getAttribute('aria-level')])).toEqual([
    ['根目录', '1'],
    ['生产', '2'],
    ['上海', '3'],
    ['空目录', '3'],
    ['study', '2'],
  ]);
  rows()[1]!.querySelector<HTMLElement>('.host-folder-toggle')!.click();
  await nextTick();
  expect(rows().map((row) => row.textContent?.trim())).toEqual(['根目录', '生产', 'study']);
  expect(rows()[1]!.getAttribute('aria-expanded')).toBe('false');
  expect(trigger().textContent).toContain('根目录');
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  rows()[1]!.querySelector<HTMLElement>('.host-folder-toggle')!.click();
  await nextTick();
  rows()[2]!.click();
  await nextTick();
  expect(trigger().textContent?.trim()).toBe('根目录 / 生产 / 上海');
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  trigger().click();
  await nextTick();
  expect(rows()[2]!.getAttribute('aria-selected')).toBe('true');
  const dismissed = new Event('beforetoggle');
  Object.defineProperty(dismissed, 'newState', { value: 'closed' });
  tree().dispatchEvent(dismissed);
  await nextTick();
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  expect(trigger().textContent?.trim()).toBe('根目录 / 生产 / 上海');
});

it('supports tree keyboard navigation and Escape closes only the picker', async () => {
  await key('ArrowDown');
  await key('ArrowRight'); // First child of root.
  await key('ArrowLeft'); // Collapse parent.
  expect(rows()).toHaveLength(3);
  await key('ArrowRight'); // Expand parent.
  await key('ArrowRight'); // First child of parent.
  await key('Enter');
  expect(trigger().textContent?.trim()).toBe('根目录 / 生产 / 上海');
  expect(document.activeElement).toBe(trigger());
  await key(' ');
  await key('Home');
  await key('ArrowLeft'); // Collapse root.
  expect(rows()).toHaveLength(1);
  await key('Escape');
  expect(closed).not.toHaveBeenCalled();
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  expect(trigger().textContent?.trim()).toBe('根目录 / 生产 / 上海');
  await key('Enter');
  expect(rows()).toHaveLength(5); // Reopening reveals the selected folder's ancestors.
  await key('End');
  await key('ArrowUp');
  await key(' ');
  expect(trigger().textContent?.trim()).toBe('根目录 / 生产 / 空目录');
});

it('keeps the root selectable without folders and closes and disables the tree while busy', async () => {
  useHostsStore().catalog!.groups = [];
  await nextTick();
  trigger().click();
  await nextTick();
  expect(rows()).toHaveLength(1);
  expect(rows()[0]!.getAttribute('aria-expanded')).toBeNull();
  window.dispatchEvent(new Event('scroll'));
  await nextTick();
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  useHostsStore().busy = true;
  await nextTick();
  expect(trigger().disabled).toBe(true);
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
});

it.each([
  ['上海', 'child'],
  ['根目录', null],
] as const)('submits the selected folder %s through the existing import API', async (name, id) => {
  await select('上海');
  if (id === null) await select(name);
  await preview();
  const imported = vi.spyOn(hostsApi, 'import').mockResolvedValue({ value: [], warnings: [] });
  vi.spyOn(hostsApi, 'list').mockResolvedValue(useHostsStore().catalog!);
  button('导入 1 台主机').click();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(imported).toHaveBeenCalledWith(
    'Host web-prod\n  HostName 192.0.2.10\n  User deploy',
    ['web-prod'],
    id,
  );
});

it('preserves the selected folder and preview when importing fails', async () => {
  await select('上海');
  await preview();
  vi.spyOn(hostsApi, 'import').mockRejectedValue({ message: 'import failed' });
  button('导入 1 台主机').click();
  await vi.waitFor(() => expect(useHostsStore().error).toBe('import failed'));
  expect(closed).not.toHaveBeenCalled();
  expect(trigger().textContent?.trim()).toBe('根目录 / 生产 / 上海');
  expect(button('导入 1 台主机').disabled).toBe(false);
  expect(document.querySelector<HTMLInputElement>('.import-confirm input')!.checked).toBe(true);
});
