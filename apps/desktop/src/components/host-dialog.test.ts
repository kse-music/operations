import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import HostDialog from './HostDialog.vue';
import { hostsApi } from '../services/hosts';
import { useHostsStore } from '../stores/hosts';

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

it.each([22, 2222])('submits a new host without a name on port %s', async (port) => {
  pinia = createPinia();
  setActivePinia(pinia);
  const store = useHostsStore();
  store.catalog = { hosts: [], groups: [], credentials: [], pendingSecretDeletions: 0 };
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
  app = createApp(HostDialog, { onSaved: saved, onClose: close }).use(pinia);
  app.mount(root);
  await nextTick();
  const form = document.querySelector('dialog form') as HTMLFormElement;
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
    }),
  );
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ name: '', id: 'new-host' }));
  expect(close).toHaveBeenCalledOnce();
  expect(store.catalog?.hosts).toHaveLength(1);
});
