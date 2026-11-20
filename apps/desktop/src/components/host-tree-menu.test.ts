import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import HostSidebar from './HostSidebar.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import { hostInput, type HostGroup } from '../types/hosts';

let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
beforeEach(() => window.localStorage.clear());
function unmount() {
  app?.unmount();
  app = undefined;
  if (pinia) disposePinia(pinia);
  root?.remove();
}
afterEach(() => {
  unmount();
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
    environmentTags: { tags: [], assignments: {} },
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
const background = () => root.querySelector<HTMLElement>('.host-tree-scroll')!;
const folder = (id: string) =>
  root.querySelector<HTMLElement>(`[data-group-id="${id}"] > .group-toggle`)!;

const transferActions = ['导入…', '导出…'];
const backgroundActions = ['新建主机', '新建文件夹', ...transferActions];

it.each(['empty', 'unavailable'])(
  'offers one import and one export from the %s list and preserves search if export is cancelled',
  async (state) => {
    const { store } = await mount();
    const restored = store.catalog!;
    store.catalog = state === 'empty' ? { ...restored, hosts: [], groups: [] } : null;
    store.search = 'hidden host';
    await nextTick();
    const backup = vi.spyOn(hostsApi, 'backup').mockResolvedValueOnce(null);
    const list = vi.spyOn(hostsApi, 'list').mockResolvedValue(restored);
    try {
      await open(background());
      expect(labels()).toEqual(state === 'empty' ? backgroundActions : transferActions);
      await action('导出…');
      await vi.waitFor(() => expect(store.busy).toBe(false));
      expect(backup).toHaveBeenCalledExactlyOnceWith('export');
      expect(store.notice).toBeNull();
      expect(store.search).toBe('hidden host');
      expect(list).not.toHaveBeenCalled();
    } finally {
      backup.mockRestore();
      list.mockRestore();
    }
  },
);
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

it('opens a target-specific tag submenu and returns focus level by level', async () => {
  const { store } = await mount();
  store.catalog!.environmentTags = {
    tags: [
      { id: 'prod', name: '生产', color: 'red' },
      { id: 'test', name: '测试', color: 'blue' },
    ],
    assignments: { h0: 'prod', h1: 'test' },
  };
  store.selectedId = 'h0';
  const host = (id: string) => root.querySelector<HTMLButtonElement>(`[data-host-id="${id}"]`)!;
  const trigger = () =>
    menu().querySelector<HTMLButtonElement>('[aria-controls="host-environment-menu"]')!;
  const submenu = () => document.querySelector<HTMLElement>('.host-environment-menu');
  const press = async (target: HTMLElement, key: string) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await nextTick();
  };

  await open(host('h1'));
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  expect(submenu()).toBeNull();
  expect(menu().querySelector('[role="menuitemradio"]')).toBeNull();
  trigger().focus();
  await press(trigger(), 'ArrowRight');
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  const choices = () => submenu()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
  expect(document.activeElement).toBe(choices()[0]);
  await press(choices()[0]!, 'ArrowDown');
  expect(document.activeElement).toBe(choices()[1]);
  expect(choices()[1]?.getAttribute('aria-checked')).toBe('true');
  await press(choices()[1]!, 'Escape');
  expect(submenu()).toBeNull();
  expect(document.activeElement).toBe(trigger());

  trigger().dispatchEvent(new MouseEvent('pointerenter'));
  await nextTick();
  expect(submenu()).not.toBeNull();
  choices()[0]?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  expect(submenu()).not.toBeNull();
  await open(host('h0'));
  expect(submenu()).toBeNull();
  trigger().click();
  await nextTick();
  expect(choices()[0]?.getAttribute('aria-checked')).toBe('true');
  const assign = vi.spyOn(hostsApi, 'setEnvironmentTag').mockResolvedValue({
    tags: store.catalog!.environmentTags.tags,
    assignments: { h0: 'test', h1: 'test' },
  });
  try {
    choices()[1]?.click();
    await nextTick();
    expect(assign).toHaveBeenCalledExactlyOnceWith('h0', 'test');
    expect(submenu()).toBeNull();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(host('h0'));
  } finally {
    assign.mockRestore();
  }
});

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
async function pressF2(target: HTMLElement, options: KeyboardEventInit = {}) {
  target.focus();
  const event = new KeyboardEvent('keydown', {
    key: 'F2',
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  await nextTick();
  return event;
}
const renameInput = () => root.querySelector<HTMLInputElement>('.tree-rename-input');
function changeName(name: string): void {
  const input = renameInput()!;
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function editKey(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  renameInput()!.dispatchEvent(event);
  await nextTick();
  return event;
}

it('focuses folder names, icons and counts without collapsing and supports F2 immediately after the click', async () => {
  await mount();
  const row = folder('child');
  const arrow = row.querySelector<HTMLButtonElement>('.group-expander')!;
  const host = root.querySelector('[data-host-id="h1"]');
  for (const target of [
    row,
    row.querySelector<HTMLElement>('.group-name')!,
    row.querySelector<SVGElement>('.host-group-icon')!,
    row.querySelector<HTMLElement>('.group-count')!,
  ]) {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(arrow.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('[data-host-id="h1"]')).toBe(host);
    expect(document.activeElement).toBe(row);
    expect(row.classList.contains('selected')).toBe(true);
    expect(row.getAttribute('aria-current')).toBe('true');
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    await nextTick();
    expect(renameInput()!.value).toBe('上海');
    expect(document.activeElement).toBe(renameInput());
    expect(arrow.disabled).toBe(true);
    await editKey('Escape');
    expect(arrow.disabled).toBe(false);
  }
});

it('keeps one highlighted tree row while folder selection preserves the current host target', async () => {
  const { store, select } = await mount();
  store.selectedId = 'h0';
  await nextTick();
  const host = root.querySelector<HTMLButtonElement>('[data-host-id="h0"]')!;
  expect(host.classList.contains('selected')).toBe(true);
  const child = folder('child');
  child.querySelector<HTMLElement>('.group-name')!.click();
  await nextTick();
  expect(child.classList.contains('selected')).toBe(true);
  expect(host.classList.contains('selected')).toBe(false);
  expect(host.getAttribute('aria-current')).toBeNull();
  expect(root.querySelectorAll('.selected')).toHaveLength(1);
  expect(store.selectedId).toBe('h0');
  expect(select).not.toHaveBeenCalled();
  root.querySelector<HTMLInputElement>('#host-tree-search')!.focus();
  await nextTick();
  expect(child.classList.contains('selected')).toBe(true);
  folder('parent').querySelector<HTMLElement>('.group-name')!.click();
  await nextTick();
  expect(folder('parent').classList.contains('selected')).toBe(true);
  expect(child.classList.contains('selected')).toBe(false);
  host.click();
  await nextTick();
  expect(host.classList.contains('selected')).toBe(true);
  expect(host.getAttribute('aria-current')).toBe('true');
  expect(folder('parent').classList.contains('selected')).toBe(false);
  expect(root.querySelectorAll('.selected')).toHaveLength(1);
  expect(store.selectedId).toBe('h0');
});

it('clears folder highlighting after an external host selection or removal of the selected folder', async () => {
  const { store } = await mount();
  store.selectedId = 'h0';
  folder('child').click();
  await nextTick();
  expect(folder('child').classList.contains('selected')).toBe(true);
  store.selectedId = 'h1';
  await nextTick();
  expect(folder('child').classList.contains('selected')).toBe(false);
  expect(root.querySelector('[data-host-id="h1"]')?.classList.contains('selected')).toBe(true);
  folder('child').click();
  await nextTick();
  store.catalog = {
    ...store.catalog!,
    groups: store.catalog!.groups.filter((group) => group.id !== 'child'),
  };
  await nextTick();
  expect(folder('child')).toBeNull();
  expect(root.querySelectorAll('.group-toggle.selected')).toHaveLength(0);
  expect(store.selectedId).toBe('h1');
});

it('toggles folders only from the arrow and permits F2 from both collapsed names and the arrow button', async () => {
  await mount();
  const row = folder('child');
  const arrow = row.querySelector<HTMLButtonElement>('.group-expander')!;
  arrow.click();
  await nextTick();
  expect(arrow.getAttribute('aria-expanded')).toBe('false');
  expect(root.querySelector('[data-host-id="h1"]')).toBeNull();
  row.querySelector<HTMLElement>('.group-name')!.click();
  await nextTick();
  expect(arrow.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(row);
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
  await nextTick();
  expect(renameInput()!.value).toBe('上海');
  await editKey('Escape');
  arrow.click();
  await nextTick();
  expect(arrow.getAttribute('aria-expanded')).toBe('true');
  expect(root.querySelector('[data-host-id="h1"]')).not.toBeNull();
  await pressF2(arrow);
  expect(renameInput()!.value).toBe('上海');
});

it('restores nested folder states on reopen and still reveals matching search results', async () => {
  const { store } = await mount();
  const expander = (id: string) => folder(id).querySelector<HTMLButtonElement>('.group-expander')!;
  const host = () => root.querySelector('[data-host-id="h1"]');
  expect(host()).not.toBeNull();
  store.selectedId = 'h1';
  await nextTick();
  expander('child').click();
  await nextTick();
  store.catalog = { ...store.catalog! };
  await nextTick();
  expect(host()).toBeNull();
  expander('parent').click();
  await nextTick();
  expect(folder('child')).toBeNull();

  unmount();
  const { store: reopened } = await mount();
  expect(expander('parent').getAttribute('aria-expanded')).toBe('false');
  expect(folder('child')).toBeNull();

  reopened.search = 'host1.example';
  await nextTick();
  expect(host()).not.toBeNull();
  expect(expander('child').disabled).toBe(true);
  reopened.search = '';
  await nextTick();
  expect(expander('parent').getAttribute('aria-expanded')).toBe('false');

  expander('parent').click();
  await nextTick();
  expect(expander('child').getAttribute('aria-expanded')).toBe('false');
  expect(host()).toBeNull();
  expander('child').click();
  await nextTick();
  expect(host()).not.toBeNull();

  unmount();
  await mount();
  expect(host()).not.toBeNull();
});

it('keeps folder controls usable when saved state cannot be read or written', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValueOnce('{');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new DOMException('Storage is full', 'QuotaExceededError');
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await mount();
  const expander = folder('child').querySelector<HTMLButtonElement>('.group-expander')!;
  expect(expander.getAttribute('aria-expanded')).toBe('true');
  expander.click();
  await nextTick();
  expect(expander.getAttribute('aria-expanded')).toBe('false');
  expect(root.querySelector('[data-host-id="h1"]')).toBeNull();
  expect(warn).toHaveBeenCalledWith('Could not restore host folder expansion state.');
  expect(warn).toHaveBeenCalledWith('Could not save host folder expansion state.');
});

it.each(['menu', 'F2'])(
  'renames the target folder inline via %s and preserves its parent, order and expansion',
  async (entry) => {
    const { store, select } = await mount();
    const original = { ...store.catalog!.groups[1]!, sortOrder: 7 };
    store.catalog!.groups[1] = original;
    store.selectedId = 'h0';
    const result = { ...original, name: '应用' };
    const save = vi.spyOn(hostsApi, 'groupSave').mockResolvedValue(result);
    const list = vi.spyOn(hostsApi, 'list');
    if (entry === 'menu') {
      await open(folder('child'));
      await action('重命名');
    } else await pressF2(folder('child'));
    const input = renameInput()!;
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('上海');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(input.closest('button')).toBeNull();
    changeName(' 应用 ');
    await editKey('Enter');
    await vi.waitFor(() => expect(renameInput()).toBeNull());
    expect(save).toHaveBeenCalledExactlyOnceWith('child', {
      name: '应用',
      parentId: 'parent',
      sortOrder: 7,
    });
    expect(store.catalog!.groups[1]).toEqual(result);
    expect(folder('child').textContent).toContain('应用');
    expect(folder('child').querySelector('.group-expander')!.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(document.activeElement).toBe(folder('child'));
    expect(store.selectedId).toBe('h0');
    expect(select).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  },
);

it.each(['menu', 'F2'])(
  'renames only the context host name via %s without changing selection or authentication',
  async (entry) => {
    const { store, select, saved } = await mount();
    const original = {
      ...store.catalog!.hosts[1]!,
      authType: 'password' as const,
      credentialId: 'existing-credential',
      favorite: true,
      description: '保留备注',
    };
    store.catalog!.hosts[1] = original;
    store.selectedId = 'h0';
    const update = vi
      .spyOn(hostsApi, 'update')
      .mockResolvedValue({ ...original, name: '生产主机' });
    const test = vi.spyOn(hostsApi, 'test');
    const row = root.querySelector<HTMLElement>('[data-host-id="h1"]')!;
    if (entry === 'menu') {
      await open(row);
      await action('重命名');
    } else await pressF2(row);
    expect(renameInput()!.value).toBe('Host 1');
    expect(renameInput()!.closest('button')).toBeNull();
    changeName('生产主机');
    await editKey('Enter');
    await vi.waitFor(() => expect(renameInput()).toBeNull());
    expect(update).toHaveBeenCalledExactlyOnceWith('h1', {
      ...hostInput(original),
      name: '生产主机',
    });
    expect(store.catalog!.hosts[1]).toEqual({ ...original, name: '生产主机' });
    expect(root.querySelector('[data-host-id="h1"] .host-name')?.textContent).toBe('生产主机');
    expect(store.selectedId).toBe('h0');
    expect(test).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  },
);

it('keeps failed folder edits inline and allows retry after validation without losing the old name', async () => {
  const { store } = await mount();
  const group = store.catalog!.groups[1]!;
  const save = vi
    .spyOn(hostsApi, 'groupSave')
    .mockRejectedValueOnce({ message: '同名文件夹已存在' })
    .mockResolvedValueOnce({ ...group, name: '测试' });
  await pressF2(folder('child'));
  changeName('生产');
  await editKey('Enter');
  await vi.waitFor(() => expect(renameInput()!.readOnly).toBe(false));
  expect(renameInput()!.value).toBe('生产');
  expect(renameInput()!.getAttribute('aria-invalid')).toBe('true');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('同名文件夹已存在');
  expect(store.catalog!.groups[1]!.name).toBe('上海');
  changeName('测试');
  await editKey('Enter');
  await vi.waitFor(() => expect(renameInput()).toBeNull());
  expect(save).toHaveBeenCalledTimes(2);
  expect(store.catalog!.groups[1]!.name).toBe('测试');
});

it('keeps host save failures inline without changing stored connection fields', async () => {
  const { store } = await mount();
  const original = { ...store.catalog!.hosts[0]! };
  vi.spyOn(hostsApi, 'update').mockRejectedValue({ message: '主机保存失败' });
  await pressF2(root.querySelector<HTMLElement>('[data-host-id="h0"]')!);
  changeName('新的名称');
  await editKey('Enter');
  await vi.waitFor(() => expect(renameInput()!.readOnly).toBe(false));
  expect(renameInput()!.value).toBe('新的名称');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('主机保存失败');
  expect(store.catalog!.hosts[0]).toEqual(original);
  await editKey('Escape');
  expect(renameInput()).toBeNull();
  expect(document.activeElement).toBe(root.querySelector('[data-host-id="h0"]'));
});

it.each(['host', 'folder'])('cancels %s inline edits and skips unchanged names', async (kind) => {
  await mount();
  const save = vi.spyOn(hostsApi, 'groupSave');
  const update = vi.spyOn(hostsApi, 'update');
  const row = () =>
    kind === 'host' ? root.querySelector<HTMLElement>('[data-host-id="h0"]')! : folder('child');
  await pressF2(row());
  changeName('取消草稿');
  await editKey('Escape');
  expect(renameInput()).toBeNull();
  expect(document.activeElement).toBe(row());
  await pressF2(row());
  await editKey('Enter');
  expect(renameInput()).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it('allows clearing a host name and keeps an unchanged unnamed host unnamed', async () => {
  const { store } = await mount();
  const host = store.catalog!.hosts[0]!;
  const update = vi.spyOn(hostsApi, 'update').mockResolvedValue({ ...host, name: '' });
  const row = () => root.querySelector<HTMLElement>('[data-host-id="h0"]')!;
  await pressF2(row());
  changeName('');
  await editKey('Enter');
  await vi.waitFor(() => expect(renameInput()).toBeNull());
  expect(row().textContent?.trim()).toBe(host.hostname);
  await pressF2(row());
  expect(renameInput()!.value).toBe(host.hostname);
  await editKey('Enter');
  expect(update).toHaveBeenCalledTimes(1);
  expect(store.catalog!.hosts[0]!.name).toBe('');
});

it('rejects an empty folder name without submitting and ignores composition, Delete and F2 inside the editor', async () => {
  await mount();
  const save = vi.spyOn(hostsApi, 'groupSave');
  await pressF2(folder('child'));
  changeName('  ');
  await editKey('Enter');
  expect(root.querySelector('[role="alert"]')).not.toBeNull();
  changeName('输入法草稿');
  const input = renameInput();
  for (const key of ['Enter', 'Escape']) await editKey(key, { isComposing: true });
  await editKey('Delete');
  await editKey('F2');
  expect(renameInput()).toBe(input);
  expect(renameInput()!.value).toBe('输入法草稿');
  expect(document.querySelector('dialog')).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it('saves on blur once and preserves a newly selected row while the save is pending', async () => {
  const { store } = await mount();
  let complete!: (group: HostGroup) => void;
  const save = vi.spyOn(hostsApi, 'groupSave').mockImplementation(
    () =>
      new Promise<HostGroup>((resolve) => {
        complete = resolve;
      }),
  );
  await pressF2(folder('child'));
  changeName('后台保存');
  const input = renameInput()!;
  const other = root.querySelector<HTMLButtonElement>('[data-host-id="h0"]')!;
  other.focus();
  other.click();
  await nextTick();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(input.readOnly).toBe(true);
  await editKey('Enter');
  input.dispatchEvent(new FocusEvent('blur'));
  await nextTick();
  expect(save).toHaveBeenCalledTimes(1);
  complete({ ...store.catalog!.groups[1]!, name: '后台保存' });
  await vi.waitFor(() => expect(renameInput()).toBeNull());
  expect(store.selectedId).toBe('h0');
  expect(document.activeElement).toBe(other);
});

it.each(['refresh', 'search'])(
  'cancels an unsubmitted edit on %s without saving its draft',
  async (change) => {
    const { store } = await mount();
    const save = vi.spyOn(hostsApi, 'groupSave');
    await pressF2(folder('child'));
    changeName('未提交');
    if (change === 'refresh') store.catalog = { ...store.catalog! };
    else store.search = 'Host';
    await nextTick();
    expect(renameInput()).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(store.catalog!.groups[1]!.name).toBe('上海');
  },
);

it('opens the top-level creation and import menu on blank space without rendering a root row', async () => {
  await mount();
  expect(folder('')).toBeNull();
  expect([...root.querySelectorAll('.group-name')].map((el) => el.textContent)).toEqual([
    '生产',
    '上海',
  ]);
  expect(root.querySelector('.host-sidebar-heading')).toBeNull();
  expect(root.querySelector('[aria-label="刷新"], [aria-label="管理分组"]')).toBeNull();
  expect(
    root.querySelector('.host-views + .host-sidebar-controls [aria-label="搜索主机"]'),
  ).not.toBeNull();
  await open(background());
  expect(labels()).toEqual(backgroundActions);
  const bounds = menu().getBoundingClientRect();
  expect(Number.parseFloat(menu().style.left) + bounds.width).toBeLessThanOrEqual(innerWidth);
  expect(Number.parseFloat(menu().style.top) + bounds.height).toBeLessThanOrEqual(innerHeight);
});

it('creates hosts in the right-clicked folder while host menus exclude folder creation', async () => {
  const { store, create, select } = await mount();
  store.selectedId = 'h0';
  await open(folder('child'));
  expect(labels()).toEqual(['新建主机', '新建文件夹', '重命名', '删除']);
  await action('新建主机');
  expect(create).toHaveBeenCalledExactlyOnceWith('child');
  await open(root.querySelector<HTMLElement>('[data-host-id="h1"]')!);
  expect(labels()).toEqual(['连接', '编辑', '重命名', '复制', '删除', '已保存会话', '标签']);
  expect(store.selectedId).toBe('h0');
  expect(select).not.toHaveBeenCalled();
  await action('编辑');
  expect(document.querySelector('[aria-label="编辑主机"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="分组"]')).toBeNull();
});

it.each(['empty', 'no matches', 'no favorites'])(
  'offers top-level actions from the %s message',
  async (state) => {
    const { store, create } = await mount();
    if (state === 'empty') store.catalog = { ...store.catalog!, hosts: [], groups: [] };
    if (state === 'no matches') store.search = 'no matching host';
    if (state === 'no favorites')
      root.querySelector<HTMLButtonElement>('.host-views button:last-child')!.click();
    await nextTick();
    await open(background().querySelector<HTMLElement>('.host-empty p')!);
    expect(labels()).toEqual(backgroundActions);
    await action('新建主机');
    expect(create).toHaveBeenCalledExactlyOnceWith(null);
  },
);

it('keeps the count at the end of each folder row and uses the expander to change its icon', async () => {
  await mount();
  for (const row of [folder('parent'), folder('child')]) {
    expect(row.lastElementChild).toBe(row.querySelector('.group-count'));
    expect(row.querySelectorAll('button')).toHaveLength(1);
    expect(row.querySelector('button')).toBe(row.querySelector('.group-expander'));
    expect(row.querySelector('.host-group-icon')).not.toBeNull();
  }
  const row = folder('child');
  const expandedIcon = row.querySelector('.host-group-icon')!.innerHTML;
  const expander = row.querySelector<HTMLButtonElement>('.group-expander')!;
  expander.click();
  await nextTick();
  expect(expander.getAttribute('aria-expanded')).toBe('false');
  expect(row.querySelector('.host-group-icon')!.innerHTML).not.toBe(expandedIcon);
  expander.click();
  await nextTick();
  expect(row.querySelector('.host-group-icon')!.innerHTML).toBe(expandedIcon);
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
  await action('删除');
  const dialog = document.querySelector<HTMLElement>('[aria-label="确认删除文件夹"]')!;
  expect(dialog.querySelector('h2')?.textContent).toBe('确认删除文件夹');
  expect(dialog.textContent).toContain('主机和子文件夹会保留并移到父目录');
  expect(remove).not.toHaveBeenCalled();
  [...dialog.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '删除')!
    .click();
  await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith('parent'));
  await vi.waitFor(() => expect(store.busy).toBe(false));
  store.busy = true;
  await open(background());
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
      .find((button) => button.textContent?.trim() === '删除')!
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

it('ignores Delete and F2 on the list background and search field', async () => {
  const { store } = await mount();
  await pressDelete(background());
  const input = root.querySelector<HTMLInputElement>('#host-tree-search')!;
  store.search = 'Host';
  await nextTick();
  const event = await pressDelete(input);
  expect(event.defaultPrevented).toBe(false);
  expect(input.value).toBe('Host');
  expect(document.querySelector('dialog')).toBeNull();
  await pressF2(background());
  const rename = await pressF2(input);
  expect(rename.defaultPrevented).toBe(false);
  expect(renameInput()).toBeNull();
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
])('ignores Delete and F2 on host and folder rows while %s', async (guard) => {
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
    await pressF2(target, { [guard]: true });
    expect(renameInput()).toBeNull();
  }
});

it('supports keyboard menu navigation and restores focus to the folder or list background', async () => {
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
  background().dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }),
  );
  await nextTick();
  expect(labels()).toEqual(backgroundActions);
  menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(background());
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
      root.querySelector('.host-views')!,
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
        : kind === 'root'
          ? background()
          : folder(initial ? 'parent' : 'child');
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
  await open(background());
  menu().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  expect(menu()).toBeNull();
  const remove = vi.spyOn(window, 'removeEventListener');
  app?.unmount();
  app = undefined;
  expect(remove).toHaveBeenCalledWith('contextmenu', expect.any(Function), true);
  expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
});
