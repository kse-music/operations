import { it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createApp, nextTick, defineComponent, h, ref, type App, type Component } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
const api = vi.hoisted(() => ({
  start: vi.fn(),
  diagnostics: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('@serverdeck/plugin-sdk/services/tasks', () => ({
  tasksApi: api,
  downloadResult: vi.fn(),
}));
vi.mock('@serverdeck/plugin-sdk/services/ops', () => ({
  opsApi: { open: vi.fn(), connections: vi.fn() },
}));
import { useHostsStore } from '@serverdeck/plugin-sdk/stores/hosts';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { downloadResult } from '@serverdeck/plugin-sdk/services/tasks';
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
async function mount(component: Component, props: Record<string, unknown> = {}) {
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
  app = createApp(component, props);
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
import NetworkView from './NetworkView.vue';
it('network preserves source, scopes cancellation to one task and exports actual bounded result', async () => {
  const { hosts } = await mount(NetworkView);
  hosts.selectedId = 'a';
  await nextTick();
  const d = {
    id: 'diag-a',
    input: {
      tool: 'ping',
      origin: { kind: 'remote', hostId: 'a', sessionId: 'session-a' },
      target: '127.0.0.1',
      port: 22,
      count: 5,
      timeoutSecs: 30,
    },
    state: 'running',
    output: 'actual sample 中文',
    droppedBytes: 17,
    exitCode: null,
    message: null,
    startedAt: 1,
    finishedAt: null,
    revision: 2,
  };
  api.start.mockResolvedValue(d);
  await set('[aria-label="诊断来源"]', 'remote');
  await set('[aria-label="诊断主机"]', 'a');
  await set('[aria-label="诊断目标"]', '127.0.0.1');
  root
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await nextTick();
  expect(api.start).toHaveBeenCalledWith(
    expect.objectContaining({ origin: { kind: 'remote', hostId: 'a', sessionId: 'session-a' } }),
  );
  expect(root.textContent).toContain('远程 Host a (test@a.example:22)');
  hosts.catalog!.hosts[0]!.hostname = 'changed.example';
  await nextTick();
  expect(root.textContent).toContain('远程 Host a (test@a.example:22)');
  expect(root.textContent).not.toContain('远程 Host a (test@changed.example:22)');
  expect(root.textContent).toContain('actual sample 中文');
  button('停止此诊断').click();
  await Promise.resolve();
  expect(api.stop).toHaveBeenCalledExactlyOnceWith('diag-a');
  button('导出诊断结果').click();
  expect(downloadResult).toHaveBeenCalledWith(
    expect.stringContaining('diag-a'),
    expect.stringContaining('"droppedBytes": 17'),
  );
  app!.unmount();
  app = undefined;
  await vi.advanceTimersByTimeAsync(2000);
  expect(api.stop).toHaveBeenCalledTimes(1);
});
it('network owns its source host and accepts only explicit endpoint intents', async () => {
  const context = ref('a');
  const requestId = ref(0);
  const Parent = defineComponent(
    () => () =>
      h(NetworkView, {
        hostId: context.value,
        requestId: requestId.value,
      }),
  );
  const { hosts } = await mount(Parent);
  await set('[aria-label="诊断来源"]', 'remote');
  await set('[aria-label="诊断目标"]', 'explicit.example');
  expect((root.querySelector('[aria-label="诊断主机"]') as HTMLSelectElement).value).toBe('a');
  hosts.selectedId = 'b';
  await nextTick();
  expect((root.querySelector('[aria-label="诊断主机"]') as HTMLSelectElement).value).toBe('a');
  expect((root.querySelector('[aria-label="诊断目标"]') as HTMLInputElement).value).toBe(
    'explicit.example',
  );
  requestId.value++;
  await nextTick();
  expect((root.querySelector('[aria-label="诊断目标"]') as HTMLInputElement).value).toBe(
    'a.example',
  );
  context.value = 'b';
  await nextTick();
  expect(context.value).toBe('b');
  expect((root.querySelector('[aria-label="诊断来源"]') as HTMLSelectElement).value).toBe('remote');
  expect((root.querySelector('[aria-label="诊断目标"]') as HTMLInputElement).value).toBe(
    'b.example',
  );
  expect(root.textContent).toContain('连接所选目标');
  context.value = 'a';
  await nextTick();
  expect((root.querySelector('[aria-label="诊断主机"]') as HTMLSelectElement).value).toBe('a');
  expect((root.querySelector('[aria-label="诊断目标"]') as HTMLInputElement).value).toBe(
    'a.example',
  );
  expect((root.querySelector('[aria-label="诊断端口"]') as HTMLInputElement).value).toBe('22');
  context.value = '';
  await nextTick();
  expect((root.querySelector('[aria-label="诊断来源"]') as HTMLSelectElement).value).toBe('local');
  expect(root.querySelector('[aria-label="诊断主机"]')).toBeNull();
  expect((root.querySelector('[aria-label="诊断目标"]') as HTMLInputElement).value).toBe('');
});

it('uses the bound host as diagnosis origin without another host selector and preserves explicit local diagnosis', async () => {
  await mount(NetworkView, { hostId: 'a', boundHostId: 'a' });
  expect(root.querySelector<HTMLSelectElement>('[aria-label="诊断来源"]')!.value).toBe('remote');
  expect(root.querySelector('[aria-label="诊断主机"]')).toBeNull();
  await set('[aria-label="诊断目标"]', 'service.example');
  api.start.mockResolvedValue({
    id: 'bound-diagnostic',
    input: {
      tool: 'tcp',
      origin: { kind: 'remote', hostId: 'a', sessionId: 'session-a' },
      target: 'service.example',
    },
    state: 'running',
    startedAt: 1,
    output: '',
    revision: 1,
  });
  root
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await nextTick();
  expect(api.start).toHaveBeenLastCalledWith(
    expect.objectContaining({
      origin: { kind: 'remote', hostId: 'a', sessionId: 'session-a' },
      target: 'service.example',
    }),
  );
  await set('[aria-label="诊断来源"]', 'local');
  root
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await nextTick();
  expect(api.start).toHaveBeenLastCalledWith(
    expect.objectContaining({ origin: { kind: 'local' } }),
  );
});
