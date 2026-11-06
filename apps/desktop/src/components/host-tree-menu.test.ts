import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import HostSidebar from './HostSidebar.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import { hostInput } from '../types/hosts';

let app: App, pinia: Pinia, root: HTMLDivElement;
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});
async function mount() {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  const store = useHostsStore();
  store.catalog = {
    hosts: [null, 'child'].map((groupId, index) => ({
      ...hostInput(),
      id: `h${index}`,
      name: `Host ${index}`,
      hostname: `host${index}.example`,
      username: 'ops',
      groupId,
      createdAt: '',
      updatedAt: '',
    })),
    groups: [
      { id: 'parent', name: '生产', parentId: null, sortOrder: 0 },
      { id: 'child', name: '上海', parentId: 'parent', sortOrder: 0 },
    ],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  const create = vi.fn(),
    select = vi.fn(),
    saved = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostSidebar, { onCreate: create, onSelect: select, onSaved: saved }).use(pinia);
  app.mount(root);
  await nextTick();
  return { store, create, select, saved };
}
const folder = (id = '') =>
  root.querySelector<HTMLButtonElement>(`[data-group-id="${id}"] > .group-toggle`)!;
const menu = () => document.querySelector<HTMLElement>('[aria-label="主机树操作"]')!;
async function open(target: HTMLElement) {
  target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10000,
      clientY: 10000,
    }),
  );
  await nextTick();
}
async function action(label: string) {
  [...menu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent === label)!
    .click();
  await nextTick();
}
const labels = () =>
  [...menu().querySelectorAll('[role="menuitem"]')].map((button) => button.textContent);

it('keeps a root, removes toolbar operations, and places search directly below All Hosts', async () => {
  await mount();
  expect(folder().textContent).toContain('根目录');
  expect(root.querySelector('.host-sidebar-heading')).toBeNull();
  expect(root.querySelector('[aria-label="刷新"], [aria-label="管理分组"]')).toBeNull();
  expect(
    root
      .querySelector('.host-list-heading')
      ?.nextElementSibling?.querySelector('[aria-label="搜索主机"]'),
  ).not.toBeNull();
  await open(folder());
  expect(labels()).toEqual(['新建主机', '新建文件夹', '导入 OpenSSH Config…']);
  const bounds = menu().getBoundingClientRect();
  expect(Number.parseFloat(menu().style.left) + bounds.width).toBeLessThanOrEqual(innerWidth);
  expect(Number.parseFloat(menu().style.top) + bounds.height).toBeLessThanOrEqual(innerHeight);
});

it('creates hosts in the right-clicked folder while host menus exclude folder creation', async () => {
  const { store, create, select } = await mount();
  store.selectedId = 'h0';
  await open(folder('child'));
  expect(labels()).toEqual(['新建主机', '新建文件夹', '重命名文件夹', '删除文件夹']);
  await action('新建主机');
  expect(create).toHaveBeenCalledExactlyOnceWith('child');
  await open(root.querySelector<HTMLElement>('[data-host-id="h1"]')!);
  expect(labels()).toEqual(['连接主机', '编辑主机', '复制主机', '删除主机']);
  expect(store.selectedId).toBe('h0');
  expect(select).not.toHaveBeenCalled();
  await action('编辑主机');
  expect(document.querySelector('[aria-label="编辑主机"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="分组"]')).toBeNull();
});

it.each([true, false])(
  'creates a nested folder with the correct parent and preserves failures (%s)',
  async (success) => {
    const { store } = await mount();
    const group = { id: 'new', name: '应用', sortOrder: 0, parentId: 'child' };
    const save = vi.spyOn(hostsApi, 'groupSave');
    if (success) save.mockResolvedValue(group);
    else save.mockRejectedValue({ message: '同名文件夹已存在' });
    vi.spyOn(hostsApi, 'list').mockResolvedValue({
      ...store.catalog!,
      groups: [...store.catalog!.groups, group],
    });
    await open(folder('child'));
    await action('新建文件夹');
    const dialog = document.querySelector<HTMLElement>('[aria-label="新建文件夹"]')!;
    expect(dialog.textContent).toContain('根目录 / 生产 / 上海');
    const input = dialog.querySelector('input')!;
    input.value = '应用';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    dialog
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledExactlyOnceWith(null, {
        name: '应用',
        sortOrder: 0,
        parentId: 'child',
      }),
    );
    await vi.waitFor(() => expect(store.busy).toBe(false));
    expect(document.querySelector('[aria-label="新建文件夹"]') === null).toBe(success);
    if (success) expect(folder('new')).not.toBeNull();
    else {
      expect(input.value).toBe('应用');
      expect(store.error).toBe('同名文件夹已存在');
    }
  },
);

it.each([true, false])(
  'copies the context host rather than the selected host without connecting (%s)',
  async (success) => {
    const { store, saved, select } = await mount();
    store.selectedId = 'h0';
    const copied = { ...store.catalog!.hosts[1]!, id: 'copy', name: '副本' };
    const copy = vi.spyOn(hostsApi, 'copy');
    if (success) copy.mockResolvedValue(copied);
    else copy.mockRejectedValue({ message: '复制失败' });
    vi.spyOn(hostsApi, 'list').mockResolvedValue({
      ...store.catalog!,
      hosts: [...store.catalog!.hosts, copied],
    });
    await open(root.querySelector<HTMLElement>('[data-host-id="h1"]')!);
    await action('复制主机');
    await vi.waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith('h1'));
    await vi.waitFor(() => expect(store.busy).toBe(false));
    expect(select).not.toHaveBeenCalled();
    if (success)
      await vi.waitFor(() =>
        expect(saved).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ id: 'copy', groupId: 'child' }),
        ),
      );
    else {
      expect(saved).not.toHaveBeenCalled();
      expect(store.error).toBe('复制失败');
    }
  },
);

it('confirms folder deletion and disables context mutations while busy', async () => {
  const { store } = await mount();
  const remove = vi.spyOn(hostsApi, 'groupRemove').mockResolvedValue();
  vi.spyOn(hostsApi, 'list').mockResolvedValue(store.catalog!);
  await open(folder('parent'));
  await action('删除文件夹');
  const dialog = document.querySelector<HTMLElement>('[aria-label="确认删除文件夹"]')!;
  expect(dialog.textContent).toContain('主机和子文件夹会保留并移到父目录');
  expect(remove).not.toHaveBeenCalled();
  [...dialog.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '确认删除文件夹')!
    .click();
  await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith('parent'));
  await vi.waitFor(() => expect(store.busy).toBe(false));
  store.busy = true;
  await open(folder());
  for (const button of menu().querySelectorAll<HTMLButtonElement>('button'))
    expect(button.disabled).toBe(true);
});

it('supports keyboard menu navigation, restores focus and does not create folders on blank space', async () => {
  await mount();
  const trigger = folder('child');
  trigger.focus();
  trigger.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
  );
  await nextTick();
  expect(document.activeElement?.textContent).toBe('新建主机');
  menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement?.textContent).toBe('新建文件夹');
  menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  root
    .querySelector('.host-tree-scroll')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  expect(menu()).toBeNull();
});

it('keeps a keyboard menu open for an already queued scroll notification and closes on actual scrolling', async () => {
  await mount();
  const list = root.querySelector<HTMLElement>('.host-tree-scroll')!;
  list.scrollTop = 180;
  const trigger = folder('child');
  trigger.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
  );
  await nextTick();
  expect(menu()).not.toBeNull();
  list.dispatchEvent(new Event('scroll'));
  await nextTick();
  expect(menu()).not.toBeNull();
  list.scrollTop = 200;
  list.dispatchEvent(new Event('scroll'));
  await nextTick();
  expect(menu()).toBeNull();
});
