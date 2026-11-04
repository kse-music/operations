import { it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createApp, nextTick, type App, type Component } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
const api = vi.hoisted(() => ({
  start: vi.fn(),
  diagnostics: vi.fn(),
  stop: vi.fn(),
  batch: vi.fn(),
  batches: vi.fn(),
  cancel: vi.fn(),
  retryFile: vi.fn(),
}));
vi.mock('@serverdeck/plugin-sdk/services/tasks', () => ({
  tasksApi: api,
  downloadResult: vi.fn(),
}));
vi.mock('@serverdeck/plugin-sdk/services/ops', () => ({
  opsApi: { open: vi.fn(), connections: vi.fn() },
}));
vi.mock('@serverdeck/plugin-sdk/services/files', () => ({ filesApi: { pick: vi.fn() } }));
import { useHostsStore } from '@serverdeck/plugin-sdk/stores/hosts';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import type { Host } from '@serverdeck/plugin-sdk/types/hosts';
let app: App | undefined, root: HTMLDivElement;
const host = (id: string): Host => ({
  id,
  name: `Host ${id}`,
  hostname: `${id}.example`,
  port: 22,
  username: 'test',
  authType: 'password',
  credentialId: null,
  groupId: null,
  tags: [],
  description: '',
  favorite: false,
  connectTimeoutSecs: 3,
  ssh: {
    authTimeoutSecs: 30,
    keepaliveIntervalSecs: 15,
    keepaliveCountMax: 3,
    jumpHostId: null,
    proxy: null,
  },
  createdAt: '',
  updatedAt: '',
});
beforeEach(() => {
  vi.useFakeTimers();
  api.diagnostics.mockResolvedValue([]);
  api.batches.mockResolvedValue([]);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function () {
      this.open = true;
    },
  });
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  root.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
  document.body.innerHTML = '';
});
async function mount(component: Component) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const hosts = useHostsStore();
  hosts.catalog = {
    hosts: [host('a'), host('b')],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  const ops = useOpsStore();
  for (const id of ['a', 'b'])
    ops.connections[id] = {
      host: host(id),
      state: 'connected',
      error: null,
      trust: null,
      session: {
        id: `session-${id}`,
        hostId: id,
        transportId: `transport-${id}`,
        routeHostIds: [id],
      },
    };
  app = createApp(component);
  app.use(pinia);
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  return { hosts, ops };
}
async function set(selector: string, value: string) {
  const el = root.querySelector(selector) as HTMLInputElement | HTMLSelectElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}
function button(text: string, scope: ParentNode = root) {
  const b = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  expect(b).toBeDefined();
  return b!;
}
import BatchView from './BatchView.vue';
it('batch confirmation freezes all targets and command, connection buttons never submit operations', async () => {
  const { ops } = await mount(BatchView);
  const input = root.querySelector('[aria-label="选择批量目标 Host a"]') as HTMLInputElement;
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  await set('[aria-label="批量统一命令"]', 'printf original');
  button('连接所选目标').click();
  await Promise.resolve();
  await nextTick();
  expect(document.querySelector('dialog')).toBeNull();
  root
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await nextTick();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.textContent).toContain('test@a.example:22');
  expect(dialog.textContent).toContain('printf original');
  await set('[aria-label="批量统一命令"]', 'printf changed');
  ops.connections.a!.session!.id = 'new-session';
  const confirm = dialog.querySelector('[aria-label="批量执行确认文字"]') as HTMLInputElement;
  confirm.value = '执行 1 台';
  confirm.dispatchEvent(new Event('input', { bubbles: true }));
  api.batch.mockImplementation(async (input) => ({
    id: 'batch',
    input,
    rows: [],
    finished: true,
    createdAt: 1,
    revision: 1,
  }));
  await nextTick();
  button('确认执行批量操作', dialog).click();
  await Promise.resolve();
  expect(api.batch).toHaveBeenCalledWith(
    expect.objectContaining({
      targets: [{ hostId: 'a', sessionId: 'session-a' }],
      operation: { kind: 'command', command: 'printf original' },
      confirmed: true,
    }),
  );
  expect(api.retryFile).not.toHaveBeenCalled();
});
