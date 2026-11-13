import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import HostSidebar from './HostSidebar.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import { hostInput } from '../types/hosts';

let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});
async function mount(active = true) {
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
  app = createApp(HostSidebar, { active, onCreate: create, onSelect: select, onSaved: saved }).use(
    pinia,
  );
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
async function pressDelete(target: HTMLElement, options: KeyboardEventInit = {}) {
  target.focus();
  const event = new KeyboardEvent('keydown', {
    key: 'Delete',
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  await nextTick();
  return event;
}

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
  expect(labels()).toEqual(['新建主机', '新建文件夹', '导入 SSH 配置…']);
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
  expect(labels()).toEqual(['连接', '编辑', '复制', '删除']);
  expect(store.selectedId).toBe('h0');
  expect(select).not.toHaveBeenCalled();
  await action('编辑');
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
    await action('复制');
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

it.each([true, false])(
  'deletes the focused folder with Delete after confirmation and preserves its contents or failure (%s)',
  async (success) => {
    const { store, select } = await mount();
    store.selectedId = 'h0';
    store.catalog!.hosts[1]!.groupId = 'parent';
    await nextTick();
    const remove = vi.spyOn(hostsApi, 'groupRemove');
    if (success) remove.mockResolvedValue();
    else remove.mockRejectedValue({ message: '删除文件夹失败' });
    vi.spyOn(hostsApi, 'list').mockResolvedValue({
      ...store.catalog!,
      hosts: store.catalog!.hosts.map((host) => ({ ...host, groupId: null })),
      groups: [{ ...store.catalog!.groups[1]!, parentId: null }],
    });
    const event = await pressDelete(folder('parent'));
    expect(event.defaultPrevented).toBe(true);
    let dialog = document.querySelector<HTMLDialogElement>('[aria-label="确认删除文件夹"]')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('生产');
    expect(remove).not.toHaveBeenCalled();
    [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '取消')!
      .click();
    await nextTick();
    expect(document.querySelector('dialog')).toBeNull();
    expect(store.catalog!.groups).toHaveLength(2);
    await pressDelete(folder('parent'));
    dialog = document.querySelector<HTMLDialogElement>('[aria-label="确认删除文件夹"]')!;
    [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '确认删除文件夹')!
      .click();
    await vi.waitFor(() => expect(store.busy).toBe(false));
    expect(remove).toHaveBeenCalledExactlyOnceWith('parent');
    if (success) {
      expect(document.querySelector('dialog')).toBeNull();
      expect(folder('parent')).toBeNull();
      expect(store.catalog!.groups).toEqual([
        expect.objectContaining({ id: 'child', parentId: null }),
      ]);
      expect(store.catalog!.hosts).toHaveLength(2);
      expect(store.catalog!.hosts.every((host) => host.groupId === null)).toBe(true);
      expect(root.querySelectorAll('[data-group-id=""] .tree-host')).toHaveLength(2);
    } else {
      expect(dialog.open).toBe(true);
      expect(store.error).toBe('删除文件夹失败');
      expect(store.catalog!.groups).toHaveLength(2);
      expect(store.catalog!.hosts[1]!.groupId).toBe('parent');
    }
    expect(store.selectedId).toBe('h0');
    expect(select).not.toHaveBeenCalled();
  },
);

it('ignores Delete on the root and search field', async () => {
  const { store } = await mount();
  await pressDelete(folder());
  const input = root.querySelector<HTMLInputElement>('#host-tree-search')!;
  store.search = 'Host';
  await nextTick();
  const event = await pressDelete(input);
  expect(event.defaultPrevented).toBe(false);
  expect(input.value).toBe('Host');
  expect(document.querySelector('dialog')).toBeNull();
});

it.each([
  'busy',
  'inactive',
  'dialog',
  'repeat',
  'isComposing',
  'ctrlKey',
  'altKey',
  'metaKey',
  'shiftKey',
  'prevented',
])('ignores Delete on host and folder rows while %s', async (guard) => {
  const { store } = await mount(guard !== 'inactive');
  if (guard === 'busy') store.busy = true;
  if (guard === 'dialog') {
    const dialog = document.createElement('dialog');
    dialog.open = true;
    root.append(dialog);
  }
  for (const target of [folder('parent'), root.querySelector<HTMLElement>('.tree-host')!]) {
    if (guard === 'prevented')
      target.addEventListener('keydown', (event) => event.preventDefault(), { capture: true });
    await pressDelete(target, { [guard]: true });
    expect(document.querySelector('[aria-label="确认删除主机"]')).toBeNull();
    expect(document.querySelector('[aria-label="确认删除文件夹"]')).toBeNull();
  }
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

it.each(['host', 'folder'])(
  'dismisses the %s menu on right-clicks anywhere else, including stopped events',
  async (kind) => {
    await mount();
    const trigger =
      kind === 'host' ? root.querySelector<HTMLElement>('[data-host-id="h0"]')! : folder('parent');
    for (const outside of [
      root.querySelector<HTMLInputElement>('#host-tree-search')!,
      root.querySelector('.host-tree-scroll')!,
      document.body,
    ]) {
      await open(trigger);
      expect(menu()).not.toBeNull();
      outside.addEventListener(
        'contextmenu',
        (event) => {
          event.preventDefault();
          event.stopPropagation();
        },
        { once: true },
      );
      outside.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await nextTick();
      expect(menu()).toBeNull();
    }
  },
);

it.each([
  ['host', 'host'],
  ['host', 'folder'],
  ['folder', 'host'],
  ['folder', 'folder'],
  ['host', 'root'],
  ['root', 'host'],
] as const)(
  'replaces the %s menu with the new %s target without selecting it first',
  async (from, to) => {
    const { store, create, select } = await mount();
    store.selectedId = 'h0';
    const target = (kind: 'host' | 'folder' | 'root', initial: boolean) =>
      kind === 'host'
        ? root.querySelector<HTMLElement>(`[data-host-id="${initial ? 'h0' : 'h1'}"]`)!
        : folder(kind === 'root' ? '' : initial ? 'parent' : 'child');
    await open(target(from, true));
    target(to, false).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 90 }),
    );
    await nextTick();
    expect(document.querySelectorAll('.host-tree-menu')).toHaveLength(1);
    expect(menu().style.left).toBe('80px');
    expect(menu().style.top).toBe('90px');
    expect(store.selectedId).toBe('h0');
    expect(select).not.toHaveBeenCalled();
    if (to === 'host') {
      await action('连接');
      expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'h1' }));
    } else {
      await action('新建主机');
      expect(create).toHaveBeenCalledExactlyOnceWith(to === 'root' ? null : 'child');
    }
  },
);

it('keeps menu actions usable, dismisses outside presses without stealing focus, and removes global listeners', async () => {
  await mount();
  await open(folder('parent'));
  menu()
    .querySelector('button')!
    .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  await nextTick();
  expect(menu()).not.toBeNull();
  const search = root.querySelector<HTMLInputElement>('#host-tree-search')!;
  search.focus();
  search.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  await nextTick();
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(search);
  await open(folder());
  menu().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  expect(menu()).toBeNull();
  const remove = vi.spyOn(window, 'removeEventListener');
  app?.unmount();
  app = undefined;
  expect(remove).toHaveBeenCalledWith('contextmenu', expect.any(Function), true);
  expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
});
