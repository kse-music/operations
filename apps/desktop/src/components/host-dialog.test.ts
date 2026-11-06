import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import HostDialog from './HostDialog.vue';
import { hostsApi } from '../services/hosts';
import { useHostsStore } from '../stores/hosts';
import { hostInput, type Host } from '../types/hosts';

let app: App, pinia: Pinia, root: HTMLDivElement;
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
});

function mountDialog(host?: Host) {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  root = document.createElement('div');
  document.body.append(root);
  const saved = vi.fn(),
    close = vi.fn();
  app = createApp(HostDialog, { host, onSaved: saved, onClose: close }).use(pinia);
  app.mount(root);
  return { saved, close };
}

it.each([22, 2222])('submits a new host without a name on port %s', async (port) => {
  pinia = createPinia();
  setActivePinia(pinia);
  const store = useHostsStore();
  store.catalog = { hosts: [], groups: [], credentials: [], pendingSecretDeletions: 0 };
  const { saved, close } = mountDialog();
  await nextTick();
  const form = document.querySelector('dialog form') as HTMLFormElement;
  expect(form.textContent).not.toMatch(/标签|备注|收藏|分组/);
  const auth = form.querySelector<HTMLSelectElement>('[aria-label="认证方式"]')!;
  expect(Array.from(auth.options, ({ value }) => value)).toEqual(['password', 'private_key']);
  expect(auth.value).toBe('password');
  const fields = form.querySelectorAll<HTMLInputElement>('.form-grid > label input');
  expect(fields[0]!.required).toBe(false);
  expect(fields[0]!.value).toBe('');
  expect(fields[1]!.required).toBe(true);
  expect(form.checkValidity()).toBe(false);
  for (const [index, value] of [
    [1, '192.0.2.10'],
    [2, String(port)],
    [3, 'ops'],
  ] as const) {
    fields[index]!.value = value;
    fields[index]!.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await nextTick();
  expect(form.checkValidity()).toBe(true);
  const create = vi.spyOn(hostsApi, 'create').mockImplementation(async (input) => ({
    ...input,
    id: 'new-host',
    createdAt: '',
    updatedAt: '',
  }));
  vi.spyOn(hostsApi, 'list').mockImplementation(async () => ({
    ...store.catalog!,
    hosts: [await create.mock.results[0]!.value],
  }));
  form.querySelector<HTMLButtonElement>('[type="submit"]')!.click();
  await vi.waitFor(() => expect(store.busy).toBe(false));
  expect(create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      name: '',
      hostname: '192.0.2.10',
      port,
      username: 'ops',
      authType: 'password',
      credentialId: null,
      tags: [],
      description: '',
      favorite: false,
    }),
  );
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ name: '', id: 'new-host' }));
  expect(close).toHaveBeenCalledOnce();
  expect(store.catalog?.hosts).toHaveLength(1);
});

it.each(['agent', 'private_key'] as const)(
  'saves an existing Agent host with %s auth and preserves legacy metadata',
  async (authType) => {
    pinia = createPinia();
    setActivePinia(pinia);
    const store = useHostsStore();
    const host: Host = {
      ...hostInput(),
      id: 'existing-host',
      name: 'Existing',
      hostname: 'server.example',
      username: 'ops',
      authType: 'agent',
      tags: ['legacy-tag'],
      description: 'legacy note',
      favorite: true,
      groupId: 'legacy-folder',
      createdAt: '',
      updatedAt: '',
    };
    store.catalog = {
      hosts: [host],
      groups: [],
      credentials: [
        {
          id: 'ssh-key',
          name: 'SSH key',
          kind: 'private_key',
          keyPath: null,
          hasSecret: true,
          hostCount: 0,
          revision: 1,
        },
      ],
      pendingSecretDeletions: 0,
    };
    const { saved, close } = mountDialog(host);
    await nextTick();
    const form = document.querySelector('dialog form') as HTMLFormElement;
    expect(form.textContent).not.toMatch(/标签|备注|收藏|分组/);
    expect(form.querySelector('textarea, input[type="checkbox"]')).toBeNull();
    const auth = form.querySelector<HTMLSelectElement>('[aria-label="认证方式"]')!;
    expect(
      Array.from(auth.options)
        .filter((option) => !option.disabled)
        .map(({ value }) => value),
    ).toEqual(['password', 'private_key']);
    expect(auth.selectedOptions[0]?.textContent).toBe('沿用当前认证');
    expect(form.textContent).toContain('当前主机使用系统 SSH Agent');
    expect(form.querySelector('[aria-label="安全凭据引用"]')).toBeNull();
    if (authType === 'private_key') {
      auth.value = authType;
      auth.dispatchEvent(new Event('change', { bubbles: true }));
      await nextTick();
      expect(form.textContent).not.toContain('当前主机使用系统 SSH Agent');
      const credential = form.querySelector<HTMLSelectElement>('[aria-label="安全凭据引用"]')!;
      credential.value = 'ssh-key';
      credential.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const name = form.querySelector<HTMLInputElement>('input')!;
    name.value = 'Updated';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const update = vi.spyOn(hostsApi, 'update').mockImplementation(async (_id, input) => ({
      ...host,
      ...input,
    }));
    vi.spyOn(hostsApi, 'list').mockImplementation(async () => ({
      ...store.catalog!,
      hosts: [await update.mock.results[0]!.value],
    }));
    form.querySelector<HTMLButtonElement>('[type="submit"]')!.click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.busy).toBe(false));
    expect(update).toHaveBeenCalledExactlyOnceWith(host.id, {
      ...hostInput(host),
      name: 'Updated',
      authType,
      credentialId: authType === 'private_key' ? 'ssh-key' : null,
    });
    expect(store.catalog?.hosts[0]).toMatchObject({
      name: 'Updated',
      tags: ['legacy-tag'],
      description: 'legacy note',
      favorite: true,
    });
    expect(saved).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);
