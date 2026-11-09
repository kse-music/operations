import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import Docker from './App.vue';

const api = vi.hoisted(() => ({
  query: vi.fn(),
  actions: vi.fn<(action: string) => void>(),
  logOpen: vi.fn<(host: string, input: unknown) => Promise<{ id: string }>>(async () => ({
    id: 'container-log',
  })),
  logClose: vi.fn<(id: string) => Promise<void>>(async () => {}),
  terminal: vi.fn(async () => {}),
}));
vi.mock('@serverdeck/plugin-sdk/context', () => ({
  usePlatformContext: () => ({
    hostId: 'host',
    hosts: [{ id: 'host', name: 'QA', hostname: 'qa', username: 'ops', port: 22 }],
    connections: { host: { hostId: 'host', state: 'connected' } },
  }),
}));
vi.mock('@serverdeck/plugin-sdk', () => ({
  invoke: (action: string, input: { hostId: string; request: unknown }) => {
    api.actions(action);
    return action === 'query'
      ? api.query(input.hostId, input.request)
      : action === 'logs'
        ? api.logOpen(input.hostId, input)
        : action === 'shell'
          ? Promise.resolve({ ticket: 'shell-ticket', hostId: input.hostId })
          : Promise.reject(new Error('unexpected action'));
  },
}));
vi.mock('@serverdeck/plugin-sdk/terminal', () => ({ openTerminal: api.terminal }));
vi.mock('@serverdeck/plugin-sdk/platform', () => ({
  call: (r: { kind: string }) =>
    r.kind === 'stream_stop'
      ? api.logClose('container-log')
      : Promise.resolve({ records: [], done: false }),
}));
let app: App, pinia: Pinia, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
});
it('shows container detail tabs, scopes environment values to their tab and preserves action confirmation', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  let statsAvailable = true;
  api.query.mockImplementation(async (_id, request) => ({
    success: request.kind !== 'container_stats' || statsAvailable,
    message: request.kind === 'container_stats' && !statsAvailable ? '资源查询失败' : null,
    code: null,
    detail:
      request.kind === 'capabilities'
        ? { dockerState: 'running' }
        : request.kind === 'container_details'
          ? {
              id: 'container',
              image: 'owned-image',
              state: { Status: 'running', Health: { Status: 'healthy' } },
              ports: { '8080/tcp': [{ HostIp: '::', HostPort: '8081' }], '8443/tcp': null },
              mounts: [{ Type: 'bind', Source: '/srv/fixture', Destination: '/data', RW: false }],
              restartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
              environment: [request.revealEnv ? 'TOKEN=fixture=value' : 'TOKEN=[已隐藏]'],
              environmentRevealed: request.revealEnv,
            }
          : null,
    records:
      request.kind === 'containers'
        ? [
            { ID: 'container', Names: 'owned-container', State: 'running' },
            { ID: 'exited', Names: 'exited-container', State: 'exited' },
          ]
        : request.kind === 'images'
          ? [{ ID: 'image', Repository: 'owned-image' }]
          : request.kind === 'container_stats'
            ? [{ CPUPerc: '12.34%', MemUsage: '42 MiB / 128 MiB' }]
            : [],
  }));
  root = document.createElement('div');
  document.body.append(root);
  const shell = vi.fn();
  app = createApp(Docker, { hostId: 'host', onShell: shell }).use(pinia);
  app.mount(root);
  await settle();
  expect(root.textContent).not.toContain('操作反馈');
  expect(root.querySelector('[role="alert"]')).toBeNull();
  const actionLabels = (id: string) =>
    [...root.querySelectorAll(`[data-ops-target="${id}"] .ops-row-actions button`)].map((button) =>
      button.textContent?.trim(),
    );
  expect(actionLabels('container')).toEqual(['详情', '停止', '删除', '日志', 'Shell']);
  expect(actionLabels('exited')).toEqual(['详情', '启动', '删除', '日志', 'Shell']);
  expect(root.querySelector('.row-action-menu')).toBeNull();
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label,
    );
    expect(button).toBeDefined();
    button!.click();
    await settle();
  };
  await click('详情');
  expect(api.query).toHaveBeenCalledWith('host', {
    kind: 'container_details',
    id: 'container',
    revealEnv: false,
  });
  const detail = () => document.querySelector('dialog[aria-label="容器详情"]');
  const panel = () => detail()?.querySelector('[role="tabpanel"]');
  const selectTab = async (label: string) => {
    const tab = [...(detail()?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find(
      (button) => button.textContent?.trim() === label,
    );
    expect(tab).toBeDefined();
    tab!.click();
    await settle();
  };
  expect(panel()?.textContent).toContain('运行中');
  expect(panel()?.textContent).toContain('健康');
  expect(panel()?.textContent).toContain('异常退出时重启');
  expect(panel()?.querySelector('pre')).toBeNull();
  expect(api.query.mock.calls.some(([, request]) => request.revealEnv)).toBe(false);
  expect(api.query.mock.calls.some(([, request]) => request.kind === 'container_stats')).toBe(
    false,
  );
  await selectTab('资源使用');
  expect(api.query).toHaveBeenCalledWith('host', { kind: 'container_stats', id: 'container' });
  expect(panel()?.textContent).toContain('12.34%');
  await selectTab('端口映射');
  expect(panel()?.textContent).toContain('8080/tcp');
  expect(panel()?.textContent).toContain('8081');
  expect(panel()?.textContent).toContain('未发布到主机');
  await selectTab('挂载');
  expect(panel()?.textContent).toContain('/srv/fixture');
  expect(panel()?.textContent).toContain('/data');
  expect(panel()?.textContent).toContain('只读');
  await selectTab('环境变量');
  expect(api.query).toHaveBeenCalledWith('host', {
    kind: 'container_details',
    id: 'container',
    revealEnv: true,
  });
  expect(panel()?.querySelector('dt')?.textContent).toBe('TOKEN');
  expect(panel()?.querySelector('code')?.textContent).toBe('fixture=value');
  expect(document.querySelectorAll('dialog')).toHaveLength(1);
  await selectTab('概览');
  expect(detail()?.textContent).not.toContain('fixture=value');
  statsAvailable = false;
  await selectTab('资源使用');
  expect(detail()?.querySelector('[role="alert"]')?.textContent).toContain('资源查询失败');
  await selectTab('概览');
  expect(panel()?.textContent).toContain('owned-image');
  let finishEnvironment: (value: unknown) => void = () => {};
  api.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishEnvironment = resolve;
      }),
  );
  await selectTab('环境变量');
  expect(panel()?.querySelector('[role="status"]')?.textContent).toContain('正在读取');
  await click('关闭对话框');
  finishEnvironment({
    success: true,
    detail: { id: 'container', environmentRevealed: true, environment: ['TOKEN=late-fixture'] },
    records: [],
  });
  await settle();
  expect(document.body.textContent).not.toContain('late-fixture');
  await click('日志');
  expect(document.querySelector('dialog')?.getAttribute('aria-label')).toBe('owned-container');
  expect(api.logOpen).toHaveBeenCalledWith('host', {
    hostId: 'host',
    source: { kind: 'container', id: 'container' },
    lines: 200,
    follow: true,
  });
  document.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await settle();
  expect(api.logClose).toHaveBeenCalledWith('container-log');
  await click('停止');
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
    (button) => button.textContent?.trim() === '确认执行',
  )!;
  expect(document.querySelector('[aria-label="确认运维目标"]')).not.toBeNull();
  expect(confirm.disabled).toBe(true);
  await click('取消');
  expect(api.query.mock.calls.some(([, request]) => request.kind === 'container_action')).toBe(
    false,
  );
  const exitedRow = () => root.querySelector('[data-ops-target="exited"]')!;
  const confirmExitedAction = async (label: string) => {
    const action = [...exitedRow().querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === label,
    )!;
    action.click();
    await settle();
    const target = document.querySelector<HTMLInputElement>('[aria-label="确认运维目标"]')!;
    target.value = 'exited';
    target.dispatchEvent(new Event('input'));
    await settle();
    await click('确认执行');
  };
  await confirmExitedAction('启动');
  await confirmExitedAction('删除');
  expect(api.query).toHaveBeenCalledWith('host', {
    kind: 'container_action',
    id: 'exited',
    action: 'start',
    confirmed: true,
  });
  expect(api.query).toHaveBeenCalledWith('host', {
    kind: 'container_action',
    id: 'exited',
    action: 'remove',
    confirmed: true,
  });
  await click('Shell');
  expect(api.terminal).not.toHaveBeenCalled();
  const shellTarget = document.querySelector<HTMLInputElement>('[aria-label="确认运维目标"]')!;
  shellTarget.value = 'container';
  shellTarget.dispatchEvent(new Event('input'));
  await settle();
  await click('确认执行');
  expect(api.terminal).toHaveBeenCalledWith('shell-ticket', 'host');
  expect(document.querySelector('[aria-label="确认运维目标"]')).toBeNull();
  await click('镜像');
  expect(actionLabels('image')).toEqual(['删除']);
  await click('删除');
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.querySelector('[aria-label="确认运维目标"]')).toBeNull();
  expect(api.query).toHaveBeenCalledWith('host', {
    kind: 'image_remove',
    id: 'image',
    confirmed: true,
  });
  api.query.mockRejectedValueOnce({ code: 'PLUGIN_USER_CANCELLED', message: '操作已取消' });
  await click('删除');
  expect(root.querySelector('[role="alert"]')).toBeNull();
  api.query.mockResolvedValue({
    success: false,
    message: 'Docker daemon unavailable',
    code: 'UNAVAILABLE',
    detail: null,
    records: [],
  });
  await click('刷新运维列表');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('Docker daemon unavailable');
  expect(root.querySelector('.docker-summary strong')?.textContent).toBe('—');
  expect(api.actions.mock.calls.some(([action]) => action === 'history')).toBe(false);
});
