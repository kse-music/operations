import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import Docker from './App.vue';

const api = vi.hoisted(() => ({
  query: vi.fn(),
  actions: vi.fn<(action: string) => void>(),
  presentations: vi.fn(),
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
  invoke: (action: string, input: { hostId: string; request: unknown }, options?: unknown) => {
    api.actions(action);
    api.presentations(options);
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
function mountDocker(props: { initialSection?: 'compose'; onShell?: () => void } = {}) {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(Docker, { hostId: 'host', ...props }).use(pinia);
  app.mount(root);
}
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('loads details on demand, opens logs and shell directly and delegates mutations to host confirmation', async () => {
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
  const shell = vi.fn();
  mountDocker({ onShell: shell });
  await settle();
  expect(root.textContent).not.toContain('操作反馈');
  expect(root.textContent).not.toContain('TCP 连通性检测');
  expect(root.querySelector('[role="alert"]')).toBeNull();
  const actionLabels = (id: string) =>
    [...root.querySelectorAll(`[data-ops-target="${id}"] .ops-row-actions button`)].map((button) =>
      button.textContent?.trim(),
    );
  expect(actionLabels('container')).toEqual(['详情', '停止', '重启', '删除', '日志', 'Shell']);
  expect(actionLabels('exited')).toEqual(['详情', '启动', '重启', '删除', '日志', 'Shell']);
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
  api.query.mockRejectedValueOnce({ code: 'PLUGIN_USER_CANCELLED', message: '操作已取消' });
  await click('停止');
  expect(api.presentations).toHaveBeenLastCalledWith({
    confirmation: {
      title: '停止容器？',
      message: expect.stringContaining('owned-container'),
      confirmLabel: '停止',
    },
  });
  expect(document.querySelector('dialog')).toBeNull();
  expect(root.querySelector('[role="alert"]')).toBeNull();
  expect(api.query).toHaveBeenCalledWith('host', {
    kind: 'container_action',
    id: 'container',
    action: 'stop',
    confirmed: true,
  });
  const exitedRow = () => root.querySelector('[data-ops-target="exited"]')!;
  const runExitedAction = async (label: string) => {
    const action = [...exitedRow().querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === label,
    )!;
    action.click();
    await settle();
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector('[aria-label="确认运维目标"]')).toBeNull();
  };
  await runExitedAction('启动');
  await runExitedAction('重启');
  await runExitedAction('删除');
  expect(api.query).toHaveBeenCalledWith('host', {
    kind: 'container_action',
    id: 'exited',
    action: 'restart',
    confirmed: true,
  });
  expect(api.presentations).toHaveBeenCalledWith({
    confirmation: {
      title: '重启容器？',
      message: expect.stringContaining('exited-container'),
      confirmLabel: '重启',
    },
  });
  expect(
    api.presentations.mock.calls.some(
      ([options]) =>
        options?.confirmation?.title === '删除容器？' &&
        options.confirmation.message.includes('无法恢复') &&
        options.confirmation.message.includes('exited-container'),
    ),
  ).toBe(true);
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
  expect(api.terminal).toHaveBeenCalledWith('shell-ticket', 'host');
  expect(document.querySelector('[aria-label="确认运维目标"]')).toBeNull();
  await click('镜像');
  expect(actionLabels('image')).toEqual(['删除']);
  await click('删除');
  expect(
    api.presentations.mock.calls.some(
      ([options]) =>
        options?.confirmation?.title === '删除镜像？' &&
        options.confirmation.message.includes('owned-image') &&
        options.confirmation.message.includes('重新拉取'),
    ),
  ).toBe(true);
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
  await click('刷新');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('Docker daemon unavailable');
  expect(root.querySelector('.docker-summary strong')?.textContent).toBe('—');
  expect(api.actions.mock.calls.some(([action]) => action === 'history')).toBe(false);
});

it.each([
  {
    name: 'available Docker',
    detail: {
      dockerInstalled: true,
      dockerState: 'running',
      dockerVersion: {
        Client: { Version: '28.5.1', GitCommit: 'CLIENT_BUILD_METADATA', Os: 'darwin' },
        Server: {
          Version: '27.5.1',
          Os: 'linux',
          Arch: 'amd64',
          GoVersion: 'GO_BUILD_METADATA',
          Components: [{ Name: 'containerd' }],
        },
      },
      dockerOperatingSystem: 'Ubuntu 24.04.3 LTS',
    },
    expected: ['是', '运行中', '27.5.1', '28.5.1', 'linux / amd64', 'Ubuntu 24.04.3 LTS'],
  },
  {
    name: 'missing server information',
    detail: {
      dockerInstalled: true,
      dockerState: 'unavailable',
      dockerVersion: { Client: { Version: '28.5.1', Os: 'darwin', Arch: 'arm64' }, Server: null },
    },
    expected: ['是', '不可用或权限不足', '不可用', '28.5.1', '不可用', '不可用'],
  },
  {
    name: 'Docker not installed',
    detail: { dockerInstalled: false, dockerState: 'absent' },
    expected: ['否', '未安装', '不可用', '不可用', '不可用', '不可用'],
  },
  {
    name: 'invalid version fields',
    detail: {
      dockerInstalled: true,
      dockerState: 'unexpected',
      dockerOperatingSystem: { name: 'UNNEEDED_DETAILS' },
      dockerVersion: {
        Server: { Version: { nested: 'UNNEEDED_DETAILS' }, Os: ['linux'], Arch: null },
        Client: [],
      },
    },
    expected: ['是', '未知', '不可用', '不可用', '不可用', '不可用'],
  },
])('shows only core Docker capability fields for $name', async ({ detail, expected }) => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  api.query.mockImplementation(async (_host, request) => ({
    success: true,
    records: [],
    detail: request.kind === 'capabilities' ? detail : null,
    code: null,
    message: null,
  }));
  mountDocker();
  await settle();
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === 'Docker信息',
  );
  expect(button).toBeTruthy();
  button!.click();
  await settle();
  const modal = document.querySelector('dialog[aria-label="Docker信息"]');
  expect(modal).toBeTruthy();
  expect([...modal!.querySelectorAll('dt')].map((field) => field.textContent)).toEqual([
    'Docker 已安装',
    'Docker 状态',
    'Docker 版本',
    '客户端版本',
    '运行平台',
    '操作系统',
  ]);
  expect([...modal!.querySelectorAll('dd')].map((field) => field.textContent?.trim())).toEqual(
    expected,
  );
  expect(modal!.querySelector('pre, details')).toBeNull();
  for (const hidden of [
    'CLIENT_BUILD_METADATA',
    'GO_BUILD_METADATA',
    'UNNEEDED_DETAILS',
    'containerd',
  ])
    expect(modal!.textContent).not.toContain(hidden);
});

it('manages Compose projects with host confirmations, service details and owned project logs', async () => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  api.query.mockImplementation(async (_host, request) => ({
    success: true,
    code: null,
    message: null,
    records:
      request.kind === 'compose_projects'
        ? [{ Name: 'shop', Status: 'running(2)', ConfigFiles: '/srv/shop/compose.yaml' }]
        : [],
    detail:
      request.kind === 'compose_services'
        ? {
            composeProject: 'shop',
            services: [
              {
                ID: 'web',
                Name: '/shop-web-1',
                Service: 'web',
                Image: 'shop-web',
                State: 'running',
                ExitCode: 0,
              },
            ],
          }
        : { dockerState: 'running' },
  }));
  mountDocker({ initialSection: 'compose' });
  await settle();
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    );
    expect(button, label).toBeTruthy();
    button!.click();
    await settle();
  };
  expect(api.query).toHaveBeenCalledWith('host', { kind: 'compose_projects' });
  expect(root.querySelector('[data-ops-target="shop"]')?.textContent).toContain('running(2)');
  await click('服务');
  expect(api.query).toHaveBeenCalledWith('host', { kind: 'compose_services', project: 'shop' });
  expect(document.querySelector('dialog')?.textContent).toContain('shop-web-1');
  await click('关闭对话框');
  for (const [label, action] of [
    ['启动', 'start'],
    ['停止', 'stop'],
    ['重启', 'restart'],
  ]) {
    await click(label!);
    expect(api.query).toHaveBeenCalledWith('host', {
      kind: 'compose_action',
      project: 'shop',
      action,
      confirmed: true,
    });
    expect(
      api.presentations.mock.calls.some(
        ([options]) =>
          options?.confirmation?.title === `${label} Compose 项目？` &&
          options.confirmation.message.includes('shop'),
      ),
    ).toBe(true);
  }
  api.query.mockRejectedValueOnce({ code: 'USER_CANCELLED', message: '取消' });
  await click('停止');
  expect(root.querySelector('[role="alert"]')).toBeNull();
  await click('日志');
  expect(api.logOpen).toHaveBeenLastCalledWith('host', {
    hostId: 'host',
    source: { kind: 'compose', project: 'shop' },
    lines: 200,
    follow: true,
  });
  await click('镜像');
  expect(document.querySelector('dialog')).toBeNull();
  expect(api.logClose).toHaveBeenCalled();
  await click('Compose 项目');
  api.query.mockRejectedValueOnce(new Error('permission denied'));
  await click('重启');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('permission denied');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('可能部分完成');
  api.query.mockResolvedValueOnce({ success: true, records: [], detail: null });
  await click('刷新');
  expect(root.textContent).toContain('没有匹配项目');
  expect(root.querySelector('.docker-summary strong')?.textContent).toBe('0');
  api.query.mockRejectedValueOnce(new Error('docker: unknown command: compose'));
  await click('刷新');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('unknown command');
  expect(root.querySelector('.docker-summary strong')?.textContent).toBe('—');
});

it('closes a late Compose log stream after its tab is deactivated', async () => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  api.query.mockImplementation(async (_host, request) => ({
    success: true,
    code: null,
    message: null,
    detail: { dockerState: 'running' },
    records:
      request.kind === 'compose_projects'
        ? [{ Name: 'shop', Status: 'running(1)', ConfigFiles: '/srv/shop/compose.yaml' }]
        : [],
  }));
  let finish: (value: { id: string }) => void = () => {};
  api.logOpen.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mountDocker({ initialSection: 'compose' });
  await settle();
  const button = (label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label,
    )!;
  button('日志').click();
  await settle();
  expect(root.querySelector('.ops-table')?.getAttribute('aria-busy')).toBe('true');
  button('容器').click();
  await settle();
  finish({ id: 'container-log' });
  await settle();
  expect(api.logClose).toHaveBeenCalled();
  expect(document.querySelector('dialog')).toBeNull();
});

it('runs host-wide maintenance from the container toolbar with confirmation, feedback and busy guards', async () => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  api.query.mockImplementation(async (_host, request) => ({
    success: true,
    code: null,
    message: request.kind === 'container_maintenance' ? '匹配 2 个，成功 2 个，失败 0 个。' : null,
    detail: request.kind === 'capabilities' ? { dockerState: 'running' } : null,
    records:
      request.kind === 'containers'
        ? [
            { ID: 'a', Names: 'visible' },
            { ID: 'b', Names: 'hidden' },
          ]
        : [],
  }));
  mountDocker();
  await settle();
  const button = (label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === label,
    )!;
  const search = root.querySelector<HTMLInputElement>('[aria-label="运维项目搜索"]')!;
  search.value = 'visible';
  search.dispatchEvent(new Event('input'));
  await settle();
  expect(root.querySelector('[data-ops-target="b"]')).toBeNull();
  expect(button('重启全部容器')).toBeUndefined();
  for (const [label, action, impact] of [
    ['清空容器日志', 'clear_logs', '无法恢复'],
    ['重启已退出容器', 'restart_exited', 'exited'],
  ]) {
    const reads = api.query.mock.calls.filter(
      ([, request]) => request.kind === 'containers',
    ).length;
    button(label!).click();
    await settle();
    expect(api.query).toHaveBeenCalledWith('host', {
      kind: 'container_maintenance',
      action,
      confirmed: true,
    });
    expect(api.presentations).toHaveBeenCalledWith({
      confirmation: {
        title: `${label}？`,
        message: expect.stringContaining(impact!),
        confirmLabel: label,
      },
    });
    const confirmation = api.presentations.mock.calls.find(
      ([options]) => options?.confirmation?.title === `${label}？`,
    )![0]!.confirmation;
    expect(confirmation.message).toContain('不受列表搜索条件影响');
    expect(
      api.query.mock.calls.filter(([, request]) => request.kind === 'containers'),
    ).toHaveLength(reads + 1);
    expect(root.querySelector('.banner.success')?.textContent).toContain('成功 2 个');
  }
  api.query.mockRejectedValueOnce({ code: 'USER_CANCELLED', message: '取消' });
  const reads = api.query.mock.calls.filter(([, request]) => request.kind === 'containers').length;
  button('重启已退出容器').click();
  await settle();
  expect(root.querySelector('[role="alert"]')).toBeNull();
  expect(api.query.mock.calls.filter(([, request]) => request.kind === 'containers')).toHaveLength(
    reads,
  );
  for (const cause of [
    { code: 'DOCKER_PARTIAL_FAILURE', message: '成功 1 个，失败 1 个' },
    { code: 'REMOTE_COMMAND', message: 'permission denied' },
    { code: 'TIMEOUT', message: '执行超时' },
  ]) {
    api.query.mockResolvedValueOnce({ success: false, ...cause });
    button('清空容器日志').click();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(cause.message);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('可能部分完成');
    expect(root.querySelector('.banner.success')).toBeNull();
  }
  let finish: (value: unknown) => void = () => {};
  api.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  button('重启已退出容器').click();
  await settle();
  expect(button('重启已退出容器').disabled).toBe(true);
  expect(button('清空容器日志').disabled).toBe(true);
  const calls = api.query.mock.calls.length;
  button('重启已退出容器').click();
  expect(api.query.mock.calls).toHaveLength(calls);
  finish({ success: true, message: '没有已退出的容器，无需重启。', records: [], detail: null });
  await settle();
  expect(root.querySelector('.banner.success')?.textContent).toContain('没有已退出的容器');
  for (const tab of ['镜像', 'Compose 项目']) {
    button(tab).click();
    await settle();
    expect(button('清空容器日志')).toBeUndefined();
    expect(button('重启全部容器')).toBeUndefined();
    expect(button('重启已退出容器')).toBeUndefined();
  }
});
