import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import HostSidebar from './HostSidebar.vue';
import { useHostsStore } from '../stores/hosts';
import { useNotificationsStore } from '../stores/notifications';
import { useWorkspaceStore } from '../stores/workspace';
import { useTerminalsStore } from '../stores/terminals';
import { hostsApi } from '../services/hosts';
import { hostInput } from '../types/hosts';

let app: App, pinia: Pinia, root: HTMLDivElement;
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root?.remove();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
});
async function mount() {
  pinia = createPinia();
  setActivePinia(pinia);
  const hosts = useHostsStore();
  hosts.catalog = {
    hosts: ['a', 'b'].map((id) => ({
      ...hostInput(),
      id,
      name: `Host ${id}`,
      hostname: `${id}.example`,
      createdAt: '',
      updatedAt: '',
    })),
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  const saved = vi.fn();
  useWorkspaceStore().navigate('files', 'a');
  useTerminalsStore().open(hosts.catalog.hosts[0]!);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostSidebar, { onSaved: saved }).use(pinia);
  app.mount(root);
  await nextTick();
  return { hosts, saved };
}
const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label,
  )!;
async function openAction(label: string): Promise<void> {
  root
    .querySelector('[data-host-id="b"]')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  button(label, document.querySelector('[aria-label="主机树操作"]')!).click();
  await nextTick();
}

it('reads and edits the exact host while leaving the active host and terminal intact', async () => {
  const { hosts, saved } = await mount();
  const focused = useTerminalsStore().focused;
  await openAction('编辑主机');
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="编辑主机"]')!;
  const fields = dialog.querySelectorAll<HTMLInputElement>('.form-grid > label input');
  expect(fields[1]!.value).toBe('b.example');
  fields[0]!.value = 'Renamed B';
  fields[0]!.dispatchEvent(new Event('input', { bubbles: true }));
  const updated = { ...hosts.catalog!.hosts[1]!, name: 'Renamed B' };
  const update = vi.spyOn(hostsApi, 'update').mockResolvedValue(updated);
  vi.spyOn(hostsApi, 'list').mockResolvedValue({
    ...hosts.catalog!,
    hosts: [hosts.catalog!.hosts[0]!, updated],
  });
  await nextTick();
  dialog
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(hosts.busy).toBe(false));
  await nextTick();
  expect(update).toHaveBeenCalledWith(
    'b',
    expect.objectContaining({ name: 'Renamed B', hostname: 'b.example' }),
  );
  expect(saved).toHaveBeenCalledWith(updated);
  expect(document.querySelector('dialog')).toBeNull();
  expect(useWorkspaceStore().current).toMatchObject({ view: 'files', hostId: 'a' });
  expect(useTerminalsStore().focused).toBe(focused);
});

it('removes inline actions while retaining context menu operations without changing the workspace', async () => {
  const { saved } = await mount();
  expect(root.querySelector('.tree-host-actions')).toBeNull();
  expect(root.querySelector('[aria-label^="编辑主机 "], [aria-label^="删除主机 "]')).toBeNull();
  const host = root.querySelector<HTMLElement>('[data-host-id="b"]')!;
  host.focus();
  host.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  expect(root.querySelectorAll('.tree-host-row button')).toHaveLength(2);
  expect(root.querySelector('[aria-label^="复制主机 "]')).toBeNull();
  expect(saved).not.toHaveBeenCalled();
  expect(useWorkspaceStore().current?.hostId).toBe('a');
  expect(useTerminalsStore().panes).toHaveLength(1);
});

it.each([true, false])(
  'requires explicit deletion, supports cancellation and preserves failures (%s)',
  async (success) => {
    const { hosts } = await mount();
    const remove = vi.spyOn(hostsApi, 'remove');
    if (success) remove.mockResolvedValue();
    else remove.mockRejectedValue({ message: 'delete failed' });
    vi.spyOn(hostsApi, 'list').mockResolvedValue({
      ...hosts.catalog!,
      hosts: [hosts.catalog!.hosts[0]!],
    });
    await openAction('删除主机');
    let dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="确认删除主机"]')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('b.example');
    expect(remove).not.toHaveBeenCalled();
    button('取消', dialog).click();
    await nextTick();
    expect(document.querySelector('dialog')).toBeNull();
    await openAction('删除主机');
    dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="确认删除主机"]')!;
    button('确认删除主机', dialog).click();
    await vi.waitFor(() => expect(hosts.busy).toBe(false));
    await nextTick();
    expect(remove).toHaveBeenCalledExactlyOnceWith('b');
    if (success) {
      expect(document.querySelector('dialog')).toBeNull();
      expect(hosts.catalog!.hosts).toHaveLength(1);
    } else {
      expect(dialog.open).toBe(true);
      expect(useNotificationsStore().items).toContainEqual(
        expect.objectContaining({ text: 'delete failed', error: true }),
      );
      expect(dialog.textContent).not.toContain('delete failed');
      expect(hosts.catalog!.hosts).toHaveLength(2);
    }
    expect(useTerminalsStore().panes).toHaveLength(1);
  },
);
