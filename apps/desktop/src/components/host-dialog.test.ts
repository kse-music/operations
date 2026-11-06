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
  expect(auth.options[1]!.textContent).toBe('公钥认证（PublicKey）');
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
  expect(form.checkValidity()).toBe(false);
  const password = form.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(password.value).toBe('');
  password.value = 'fixture-only-password';
  password.dispatchEvent(new Event('input', { bubbles: true }));
  const fingerprint = {
    hostname: '192.0.2.10',
    port,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:fixture',
  };
  const test = vi
    .spyOn(hostsApi, 'test')
    .mockRejectedValueOnce(new Error('SSH 认证失败'))
    .mockResolvedValueOnce({ status: 'trust_required', key: fingerprint })
    .mockResolvedValue({ status: 'connected', testId: 'fixture-receipt', expiresInSeconds: 300 });
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
  const button = (label: string) =>
    [...form.querySelectorAll('button')].find((el) => el.textContent?.trim() === label)!;
  const save = button('保存主机');
  expect(button('取消')).toBeUndefined();
  expect(save.disabled).toBe(true);
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(create).not.toHaveBeenCalled();
  button('测试连接').click();
  await vi.waitFor(() =>
    expect(form.querySelector('[role="alert"]')?.textContent).toContain('SSH 认证失败'),
  );
  expect(save.disabled).toBe(true);
  button('测试连接').click();
  await vi.waitFor(() => expect(form.textContent).toContain(fingerprint.fingerprint));
  expect(save.disabled).toBe(true);
  button('信任并继续测试').click();
  await vi.waitFor(() => expect(save.disabled).toBe(false));
  expect(test).toHaveBeenLastCalledWith(
    expect.objectContaining({ port }),
    { kind: 'password', password: 'fixture-only-password' },
    fingerprint,
    undefined,
  );
  password.value = 'changed';
  password.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  expect(save.disabled).toBe(true);
  password.value = 'fixture-only-password';
  password.dispatchEvent(new Event('input', { bubbles: true }));
  button('测试连接').click();
  await vi.waitFor(() => expect(save.disabled).toBe(false));
  save.click();
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
    { kind: 'password', password: 'fixture-only-password' },
    'fixture-receipt',
  );
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ name: '', id: 'new-host' }));
  expect(close).toHaveBeenCalledOnce();
  expect(password.value).toBe('');
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
      credentials: [],
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
      const key = form.querySelector<HTMLTextAreaElement>('textarea')!;
      key.value = 'fixture-only-key';
      key.dispatchEvent(new Event('input', { bubbles: true }));
      await nextTick();
      const passphrase = form.querySelector<HTMLInputElement>('input[type="password"]')!;
      passphrase.value = 'fixture-only-passphrase';
      passphrase.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const name = form.querySelector<HTMLInputElement>('input')!;
    name.value = 'Updated';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const update = vi.spyOn(hostsApi, 'updateTested').mockImplementation(async (_id, input) => ({
      ...host,
      ...input,
    }));
    vi.spyOn(hostsApi, 'list').mockImplementation(async () => ({
      ...store.catalog!,
      hosts: [await update.mock.results[0]!.value],
    }));
    const buttons = [...form.querySelectorAll<HTMLButtonElement>('footer button')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['测试连接', '保存主机']);
    const [testButton, saveButton] = buttons;
    expect(saveButton?.disabled).toBe(true);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(update).not.toHaveBeenCalled();
    const test = vi
      .spyOn(hostsApi, 'test')
      .mockRejectedValueOnce(new Error('SSH 认证失败'))
      .mockResolvedValue({ status: 'connected', testId: 'verified-edit', expiresInSeconds: 300 });
    testButton!.click();
    await vi.waitFor(() =>
      expect(form.querySelector('[role="alert"]')?.textContent).toContain('SSH 认证失败'),
    );
    expect(saveButton?.disabled).toBe(true);
    testButton!.click();
    await vi.waitFor(() => expect(saveButton?.disabled).toBe(false));
    const authentication =
      authType === 'private_key'
        ? {
            kind: 'private_key',
            keyData: 'fixture-only-key',
            passphrase: 'fixture-only-passphrase',
          }
        : undefined;
    expect(test).toHaveBeenLastCalledWith(
      { ...hostInput(host), name: 'Updated', authType },
      authentication,
      undefined,
      host.id,
    );
    expect(update).not.toHaveBeenCalled();
    name.value = 'Updated after test';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(saveButton?.disabled).toBe(true);
    name.value = 'Updated';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    testButton!.click();
    await vi.waitFor(() => expect(saveButton?.disabled).toBe(false));
    saveButton!.click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.busy).toBe(false));
    expect(update).toHaveBeenCalledExactlyOnceWith(
      host.id,
      { ...hostInput(host), name: 'Updated', authType },
      authentication,
      'verified-edit',
    );
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
