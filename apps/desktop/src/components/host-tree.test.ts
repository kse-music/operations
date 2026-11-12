import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import HostSidebar from './HostSidebar.vue';
import { useHostsStore } from '../stores/hosts';
import { hostInput } from '../types/hosts';
import { useBackgroundStore } from '../stores/background';
import { hostsApi } from '../services/hosts';
let app: App, pinia: Pinia, root: HTMLDivElement;
const pointerMethods = ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture'] as const;
const originalPointerMethods = pointerMethods.map((name) =>
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
);
const originalPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
const hitTarget = vi.fn();
beforeEach(() => {
  const captured = new Set<number>();
  for (const [name, value] of [
    ['setPointerCapture', (id: number) => captured.add(id)],
    ['hasPointerCapture', (id: number) => captured.has(id)],
    ['releasePointerCapture', (id: number) => captured.delete(id)],
  ] as const)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hitTarget });
  hitTarget.mockReset();
});
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
  pointerMethods.forEach((name, index) => {
    const descriptor = originalPointerMethods[index];
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  });
  if (originalPoint) Object.defineProperty(document, 'elementFromPoint', originalPoint);
  else Reflect.deleteProperty(document, 'elementFromPoint');
});
function pointer(target: EventTarget, type: string, x: number, y: number, button = 0) {
  const event = Object.assign(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
    { pointerId: 1, pointerType: 'mouse' },
  );
  target.dispatchEvent(event);
  return event;
}
it('bounds initial host DOM, exposes further rows, and supports arrow/Home/End keyboard focus', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const hosts = useHostsStore();
  hosts.catalog = {
    hosts: Array.from({ length: 450 }, (_, n) => ({
      ...hostInput(),
      id: `host-${n}`,
      name: `Host ${String(n).padStart(3, '0')}`,
      hostname: `host-${n}.example`,
      createdAt: '',
      updatedAt: '',
    })),
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostSidebar).use(pinia);
  app.mount(root);
  await nextTick();
  let rows = root.querySelectorAll<HTMLButtonElement>('.tree-host');
  expect(rows).toHaveLength(200);
  rows[0]!.focus();
  rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(rows[1]);
  rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(document.activeElement).toBe(rows[199]);
  rows[199]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(document.activeElement).toBe(rows[0]);
  const more = [...root.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('显示更多主机'),
  )!;
  more.click();
  await nextTick();
  rows = root.querySelectorAll('.tree-host');
  expect(rows).toHaveLength(400);
  hosts.selectedId = 'host-449';
  await nextTick();
  expect(root.querySelector('.tree-host[data-host-id="host-449"]')).not.toBeNull();
  hosts.search = 'Host 449';
  await nextTick();
  expect(root.querySelectorAll('.tree-host')).toHaveLength(1);
  expect(root.textContent).toContain('Host 449');
});

it('shows an address only once when it already serves as the host name', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const store = useHostsStore();
  store.catalog = {
    hosts: [
      { id: 'default', name: '', hostname: '192.0.2.10', port: 22 },
      { id: 'custom', name: '', hostname: '192.0.2.10', port: 2222 },
      { id: 'named', name: '生产', hostname: '192.0.2.20', port: 2222 },
      { id: 'spaces', name: '   ', hostname: 'server.example', port: 22 },
      { id: 'ipv6', name: '', hostname: '2001:db8::1', port: 2200 },
      { id: 'duplicate', name: '192.0.2.30', hostname: '192.0.2.30', port: 22 },
      { id: 'named-ipv6', name: '实验室', hostname: '2001:db8::2', port: 2200 },
    ].map((host) => ({ ...hostInput(), ...host, createdAt: '', updatedAt: '' })),
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostSidebar).use(pinia);
  app.mount(root);
  await nextTick();
  for (const [id, name, address] of [
    ['default', '192.0.2.10'],
    ['custom', '192.0.2.10:2222'],
    ['named', '生产', '192.0.2.20:2222'],
    ['spaces', 'server.example'],
    ['ipv6', '[2001:db8::1]:2200'],
    ['duplicate', '192.0.2.30'],
    ['named-ipv6', '实验室', '[2001:db8::2]:2200'],
  ]) {
    const row = root.querySelector(`[data-host-id="${id}"]`)!;
    expect(row.querySelector('.host-name')?.textContent).toBe(name);
    expect(row.querySelector('.host-address')?.textContent).toBe(address);
  }
});

it('shows host counts in the root folder without duplicating them in the heading and updates after changes', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const store = useHostsStore();
  const host = {
    ...hostInput(),
    id: 'first',
    name: 'First',
    hostname: 'first.example',
    createdAt: '',
    updatedAt: '',
  };
  store.catalog = {
    hosts: [host, { ...host, id: 'second', name: 'Second', favorite: true }],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostSidebar).use(pinia);
  app.mount(root);
  const count = () =>
    root.querySelector('[data-group-id=""] > .group-toggle .group-count')?.textContent?.trim();
  expect(root.querySelector('.host-list-title')?.textContent?.trim()).toBe('主机');
  expect(root.querySelector('.host-count')).toBeNull();
  expect(count()).toBe('2');
  store.search = 'no-match';
  await nextTick();
  expect(root.querySelectorAll('.tree-host')).toHaveLength(0);
  expect(count()).toBe('0');
  store.search = '';
  await nextTick();
  expect(count()).toBe('2');
  store.catalog.hosts.push({ ...host, id: 'third' });
  await nextTick();
  expect(count()).toBe('3');
  store.catalog.hosts.splice(0, 2);
  await nextTick();
  expect(count()).toBe('1');
  store.catalog.hosts = [];
  await nextTick();
  expect(count()).toBe('0');
  store.catalog = null;
  await nextTick();
  expect(root.querySelector('.host-list-title')?.textContent?.trim()).toBe('主机');
  expect(root.querySelector('.host-count')).toBeNull();
});

it('keeps host tools outside the scrolling list and preserves selection and grouping without metadata controls', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const hosts = useHostsStore();
  const first = {
    ...hostInput(),
    id: 'first',
    name: 'Production',
    hostname: 'prod.example',
    groupId: 'group',
    favorite: true,
    createdAt: '',
    updatedAt: '',
  };
  hosts.catalog = {
    hosts: [first, { ...first, id: 'second', name: 'Staging', favorite: false }],
    groups: [{ id: 'group', name: 'Servers', sortOrder: 0, parentId: null }],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  const select = vi.fn(),
    create = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostSidebar, {
    onSelect: select,
    onCreate: create,
  }).use(pinia);
  app.mount(root);
  await nextTick();
  const scroll = root.querySelector('.host-tree-scroll')!;
  expect(scroll.querySelector('input')).toBeNull();
  expect(scroll.querySelector('[aria-label="新建主机"]')).toBeNull();
  expect(scroll.querySelector('footer')).toBeNull();
  expect(root.querySelector('.host-search-field > svg')).not.toBeNull();
  expect(root.querySelector('.host-address')?.textContent).toBe('prod.example');
  const row = root.querySelector<HTMLButtonElement>('.tree-host')!;
  row.click();
  await nextTick();
  expect(hosts.selectedId).toBe('first');
  expect(select).not.toHaveBeenCalled();
  expect(row.getAttribute('aria-current')).toBe('true');
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(select).toHaveBeenCalledOnce();
  expect(select).toHaveBeenCalledWith(first);
  const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  row.dispatchEvent(context);
  await nextTick();
  expect(context.defaultPrevented).toBe(true);
  expect(root.querySelector('[aria-haspopup="menu"]')).toBeNull();
  expect(root.querySelector('.tree-host-more')).toBeNull();
  expect(select).toHaveBeenCalledOnce();
  expect(document.querySelector('[aria-label="主机树操作"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="主机树操作"]')?.textContent).not.toContain(
    '新建文件夹',
  );
  document.querySelector<HTMLButtonElement>('[aria-label="关闭主机树菜单"]')!.click();
  const rootFolder = root.querySelector<HTMLButtonElement>('[data-group-id=""] .group-toggle')!;
  rootFolder.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
  );
  await nextTick();
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent === '新建主机')!
    .click();
  expect(create).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith(null);
  expect(root.querySelector('.host-sidebar-heading')).toBeNull();
  expect(root.querySelector('[aria-label="管理分组"]')).toBeNull();
  expect(root.querySelector('[aria-label="刷新"]')).toBeNull();
  expect(root.querySelector('[aria-label="主机树工具"]')).toBeNull();
  expect(root.querySelector('#host-tree-tools')).toBeNull();
  expect(root.querySelector('[aria-label="主机排序"]')).toBeNull();
  const heading = root.querySelector('.host-list-heading')!;
  expect(heading.nextElementSibling?.classList.contains('host-sidebar-controls')).toBe(true);
  expect(heading.nextElementSibling?.nextElementSibling).toBe(scroll);
  expect(heading.previousElementSibling).toBeNull();
  expect(root.querySelector('[aria-label="按标签筛选主机"]')).toBeNull();
  expect(root.querySelector('[aria-label="主机筛选"]')).toBeNull();
  expect(root.querySelector('[aria-label="已收藏"]')).toBeNull();
  expect(heading.querySelectorAll('button')).toHaveLength(0);
  expect(heading.querySelector('[aria-label="新建主机"]')).toBeNull();
  expect(root.querySelector<HTMLInputElement>('[aria-label="搜索主机"]')!.placeholder).toBe(
    '搜索主机、地址、用户名…',
  );
  expect(root.textContent).not.toMatch(/收藏|标签|备注/);
  expect(root.querySelectorAll('.tree-host')).toHaveLength(2);
  const group = [...root.querySelectorAll<HTMLButtonElement>('.group-toggle')].find((button) =>
    button.textContent?.includes('Servers'),
  )!;
  group.click();
  await nextTick();
  expect(root.querySelectorAll('.tree-host')).toHaveLength(0);
  expect(group.getAttribute('aria-expanded')).toBe('false');
});

it('shows loading, failure and per-host status with the total in the root folder', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const hosts = useHostsStore();
  hosts.busy = true;
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostSidebar).use(pinia);
  app.mount(root);
  expect(root.textContent).toContain('正在读取主机');
  hosts.busy = false;
  await nextTick();
  expect(root.textContent).toContain('未能读取主机');
  hosts.catalog = { hosts: [], groups: [], credentials: [], pendingSecretDeletions: 0 };
  await nextTick();
  expect(root.textContent).toContain('尚未添加主机');
  expect(root.querySelector('[data-group-id=""] .group-count')?.textContent?.trim()).toBe('0');
  useBackgroundStore().connections = [];
  hosts.catalog.hosts.push({
    ...hostInput(),
    id: 'offline',
    name: 'Offline',
    hostname: 'offline.example',
    createdAt: '',
    updatedAt: '',
  });
  await nextTick();
  const icon = root.querySelector<SVGElement>('.tree-host > svg.host-icon')!;
  expect(icon).not.toBeNull();
  expect(icon.querySelector('rect')).not.toBeNull();
  const gradient = icon.querySelector('linearGradient')!;
  expect(gradient).not.toBeNull();
  expect(icon.querySelector('.host-icon-screen')?.getAttribute('fill')).toBe(
    `url(#${gradient.id})`,
  );
  expect(root.querySelector('.disconnected-dot')).toBeNull();
  expect(icon.getAttribute('role')).toBe('img');
  expect(icon.getAttribute('aria-label')).toBe('未连接');
  expect(icon.getAttribute('aria-hidden')).not.toBe('true');
  expect(icon.classList.contains('connected')).toBe(false);
  const connection = {
    id: 'session',
    hostId: 'offline',
    transportId: 'transport',
    routeHostIds: [],
    hostname: 'offline.example',
    port: 22,
    username: 'ops',
    kind: 'terminal' as const,
    state: 'connecting',
  };
  useBackgroundStore().connections = [connection];
  await nextTick();
  expect(icon.getAttribute('aria-label')).toBe('连接中');
  expect(icon.classList.contains('connected')).toBe(false);
  useBackgroundStore().connections = [{ ...connection, state: 'connected' }];
  await nextTick();
  expect(icon.getAttribute('aria-label')).toBe('已连接');
  expect(icon.classList.contains('connected')).toBe(true);
  useBackgroundStore().connections = [];
  await nextTick();
  expect(icon.getAttribute('aria-label')).toBe('未连接');
  expect(icon.classList.contains('connected')).toBe(false);
  expect(root.querySelector('[data-group-id=""] .group-count')?.textContent?.trim()).toBe('1');
  expect(root.querySelector('.host-sidebar-footer')).toBeNull();
});

async function mountDragTree() {
  pinia = createPinia();
  setActivePinia(pinia);
  const store = useHostsStore();
  const host = {
    ...hostInput(),
    id: 'host',
    name: 'Server',
    hostname: 'server.example',
    groupId: 'a',
    createdAt: '',
    updatedAt: '',
  };
  store.catalog = {
    hosts: [host],
    groups: [
      { id: 'a', name: 'A', sortOrder: 0, parentId: null },
      { id: 'b', name: 'B', sortOrder: 1, parentId: null },
    ],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  const update = vi.spyOn(hostsApi, 'update').mockImplementation(async (_id, input) => {
    Object.assign(host, input);
    return host;
  });
  vi.spyOn(hostsApi, 'list').mockImplementation(async () => ({
    ...store.catalog!,
    hosts: [{ ...host }],
  }));
  const select = vi.fn();
  const props = { onSelect: select };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostSidebar, props).use(pinia);
  app.mount(root);
  await nextTick();
  return { store, host, select, update };
}
it('moves hosts with pointer dragging into empty, collapsed and ungrouped targets and saves through the host API', async () => {
  const { store, host, select, update } = await mountDragTree();
  const collapsed = root.querySelector<HTMLButtonElement>('[data-group-id="b"] .group-toggle')!;
  collapsed.click();
  await nextTick();
  expect(collapsed.getAttribute('aria-expanded')).toBe('false');
  for (const target of ['b', null]) {
    if (target === null) {
      collapsed.click();
      await nextTick();
    }
    const row = root.querySelector<HTMLButtonElement>('.tree-host')!;
    expect(row.draggable).toBe(false);
    pointer(row, 'pointerdown', 10, 10);
    const group = [...root.querySelectorAll('.tree-group')].find(
      (el) => el.querySelector('.group-name')?.textContent === (target === null ? '根目录' : 'B'),
    )!;
    hitTarget.mockReturnValue(group.querySelector('.group-name'));
    const move = pointer(window, 'pointermove', 50, 90);
    await nextTick();
    expect(move.defaultPrevented).toBe(true);
    expect(group.classList.contains('drop-target')).toBe(true);
    expect(root.querySelector('.host-drag-preview')?.textContent).toContain('移动到');
    pointer(window, 'pointerup', 50, 90);
    row.click();
    await vi.waitFor(() => expect(store.busy).toBe(false));
    await nextTick();
    expect(update).toHaveBeenLastCalledWith('host', { ...hostInput(host), groupId: target });
    expect(store.catalog!.hosts[0]!.groupId).toBe(target);
    expect(root.querySelector('.drop-target, .host-drag-preview, .drag-ready')).toBeNull();
  }
  expect(select).not.toHaveBeenCalled();
  update.mockRejectedValueOnce({ message: 'permission denied' });
  await store.move('host', 'a');
  expect(store.catalog!.hosts[0]!.groupId).toBeNull();
  expect(store.error).toBe('permission denied');
});

it.each(['Escape', 'pointercancel', 'outside', 'same-group'])(
  'cancels a host drag on %s without changing groups or connecting',
  async (reason) => {
    const { update, select, store } = await mountDragTree();
    const row = root.querySelector<HTMLButtonElement>('.tree-host')!;
    pointer(row, 'pointerdown', 10, 10);
    hitTarget.mockReturnValue(root.querySelector('[data-group-id="b"] .group-toggle'));
    pointer(window, 'pointermove', 50, 90);
    if (reason === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    else if (reason === 'pointercancel') pointer(window, 'pointercancel', 50, 90);
    else {
      hitTarget.mockReturnValue(reason === 'outside' ? document.body : row);
      pointer(window, 'pointerup', 50, 90);
    }
    row.click();
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await nextTick();
    expect(update).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(store.catalog!.hosts[0]!.groupId).toBe('a');
    expect(root.querySelector('.drop-target, .host-drag-preview, .drag-ready')).toBeNull();
  },
);
it('keeps normal clicks and ignores tiny moves, right buttons and dragging while saving', async () => {
  const { store, select, update } = await mountDragTree();
  const row = root.querySelector<HTMLButtonElement>('.tree-host')!;
  expect(row.classList.contains('drag-ready')).toBe(false);
  pointer(row, 'pointerdown', 10, 10);
  pointer(window, 'pointermove', 13, 12);
  await nextTick();
  expect(row.classList.contains('drag-ready')).toBe(true);
  expect(root.querySelector('.host-dragging')).toBeNull();
  pointer(window, 'pointerup', 13, 12);
  row.click();
  await nextTick();
  expect(row.classList.contains('drag-ready')).toBe(false);
  expect(select).not.toHaveBeenCalled();
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(select).toHaveBeenCalledOnce();
  pointer(row, 'pointerdown', 10, 10, 2);
  await nextTick();
  expect(row.classList.contains('drag-ready')).toBe(false);
  pointer(window, 'pointermove', 50, 90);
  pointer(window, 'pointerup', 50, 90);
  store.busy = true;
  pointer(row, 'pointerdown', 10, 10);
  await nextTick();
  expect(row.classList.contains('drag-ready')).toBe(false);
  pointer(window, 'pointermove', 50, 90);
  pointer(window, 'pointerup', 50, 90);
  await nextTick();
  expect(update).not.toHaveBeenCalled();
  expect(root.querySelector('.host-drag-preview')).toBeNull();
});
it.each(['Enter', ' '])('opens the focused host with %s', async (key) => {
  const { select } = await mountDragTree();
  const row = root.querySelector<HTMLButtonElement>('.tree-host')!;
  row.focus();
  row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  expect(select).toHaveBeenCalledOnce();
});
it('drops onto a host row inside another group without selecting either host', async () => {
  const { store, host, update, select } = await mountDragTree();
  store.catalog!.hosts.push({ ...host, id: 'other', name: 'Other', groupId: 'b' });
  await nextTick();
  const row = root.querySelector<HTMLButtonElement>('[data-group-id="a"] .tree-host')!;
  hitTarget.mockReturnValue(root.querySelector('[data-group-id="b"] .host-name'));
  pointer(row, 'pointerdown', 10, 10);
  pointer(window, 'pointermove', 50, 90);
  pointer(window, 'pointerup', 50, 90);
  row.click();
  await vi.waitFor(() => expect(store.busy).toBe(false));
  expect(update).toHaveBeenCalledWith('host', { ...hostInput(host), groupId: 'b' });
  expect(select).not.toHaveBeenCalled();
});
