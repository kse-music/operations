import { it, expect, afterEach, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import HostSidebar from './HostSidebar.vue';
import { useHostsStore } from '../stores/hosts';
import { hostInput } from '../types/hosts';
import { useBackgroundStore } from '../stores/background';
let app: App, pinia: Pinia, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
});
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
  hosts.search = 'Host 449';
  await nextTick();
  expect(root.querySelectorAll('.tree-host')).toHaveLength(1);
  expect(root.textContent).toContain('Host 449');
});

it('keeps host tools outside the scrolling list and preserves selection, grouping and favorites', async () => {
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
    groups: [{ id: 'group', name: 'Servers', sortOrder: 0 }],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  const select = vi.fn(),
    connect = vi.fn(),
    menu = vi.fn(),
    create = vi.fn(),
    groups = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostSidebar, {
    onSelect: select,
    onConnect: connect,
    onMenu: menu,
    onCreate: create,
    onGroups: groups,
  }).use(pinia);
  app.mount(root);
  await nextTick();
  const scroll = root.querySelector('.host-tree-scroll')!;
  expect(scroll.querySelector('input')).toBeNull();
  expect(scroll.querySelector('[aria-label="新建主机"]')).toBeNull();
  expect(scroll.querySelector('footer')).toBeNull();
  expect(root.querySelector('.host-address')?.textContent).toBe('prod.example');
  const row = root.querySelector<HTMLButtonElement>('.tree-host')!;
  row.click();
  await nextTick();
  expect(hosts.selectedId).toBe('first');
  expect(select).toHaveBeenCalledOnce();
  expect(row.getAttribute('aria-current')).toBe('true');
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(connect).toHaveBeenCalledWith(first);
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  expect(menu).toHaveBeenCalledWith(first, expect.any(MouseEvent));
  root.querySelector<HTMLButtonElement>('[aria-label="新建主机"]')!.click();
  root.querySelector<HTMLButtonElement>('[aria-label="管理分组"]')!.click();
  expect(create).toHaveBeenCalledOnce();
  expect(groups).toHaveBeenCalledOnce();
  root.querySelector<HTMLButtonElement>('.host-filter button:last-child')!.click();
  await nextTick();
  expect(root.querySelectorAll('.tree-host')).toHaveLength(1);
  root.querySelector<HTMLButtonElement>('.group-toggle')!.click();
  await nextTick();
  expect(root.querySelectorAll('.tree-host')).toHaveLength(0);
  expect(root.querySelector('.group-toggle')?.getAttribute('aria-expanded')).toBe('false');
});

it('renders loading, failure and empty states without inventing online hosts', async () => {
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
  expect(root.textContent).toContain('0 已连接');
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
  expect(root.querySelector('.disconnected-dot')?.getAttribute('aria-label')).toBe('未连接');
  expect(root.textContent).toContain('0 已连接');
});
