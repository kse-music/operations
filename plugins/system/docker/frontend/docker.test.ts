import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, reactive, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import Docker from './App.vue';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
import { updateVisibility } from '@serverdeck/plugin-sdk/visibility';

const platform = reactive({
  hostId: 'host',
  hosts: [{ id: 'host', name: 'QA', hostname: 'qa', username: 'ops', port: 22 }],
  connections: { host: { hostId: 'host', state: 'connected' } },
});

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
  usePlatformContext: () => platform,
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
  platform.connections.host.state = 'connected';
  updateVisibility(true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  setLocale('zh-CN');
  app?.unmount();
  updateVisibility(true);
  if (pinia) disposePinia(pinia);
  root?.remove();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('reuses loaded tabs and metrics on return, and keeps their values visible while refreshing', async () => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  const response = (kind: string) => ({
    success: true,
    detail: kind === 'capabilities' ? { dockerVersion: { Server: { Version: '27.5.1' } } } : null,
    records:
      kind === 'containers'
        ? [{ ID: 'cached-container', Names: 'cached', State: 'running' }]
        : kind === 'images'
          ? [{ ID: 'cached-image', Repository: 'cached-image' }]
          : [],
  });
  api.query.mockImplementation(async (_host, request) => response(request.kind));
  mountDocker();
  await settle();
  const button = (label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === label,
    )!;
  button('镜像').click();
  await settle();
  const reads = api.query.mock.calls.length;
  button('容器').click();
  await settle();
  expect(api.query).toHaveBeenCalledTimes(reads);
  expect(root.querySelector('[data-ops-target="cached-container"]')).not.toBeNull();
  const values = () =>
    [...root.querySelectorAll('.docker-summary strong')].map((node) => node.textContent);
  updateVisibility(false);
  await settle();
  expect(values()).toEqual(['27.5.1', '1', '1', '0']);
  updateVisibility(true);
  await settle();
  expect(api.query).toHaveBeenCalledTimes(reads);
  const row = root.querySelector('[data-ops-target="cached-container"]');
  const finish: (() => void)[] = [];
  api.query.mockImplementation(
    (_host, request) =>
      new Promise((resolve) => {
        finish.push(() => resolve(response(request.kind)));
      }),
  );
  button('刷新').click();
  await settle();
  expect(root.querySelector('[data-ops-target="cached-container"]')).toBe(row);
  expect(root.textContent).not.toContain('正在读取列表…');
  expect(values()).toEqual(['27.5.1', '1', '1', '0']);
  expect(button('正在读取…').disabled).toBe(true);
  finish.forEach((resolve) => resolve());
  await settle();
  expect(button('刷新').disabled).toBe(false);
  const refreshed = api.query.mock.calls.length;
  api.query.mockImplementation(async (_host, request) => response(request.kind));
  button('镜像').click();
  await settle();
  expect(api.query).toHaveBeenCalledTimes(refreshed + 1);
});

it('invalidates snapshots on reconnect and ignores reads completed after the page was hidden', async () => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  const stale: (() => void)[] = [];
  api.query.mockImplementation(
    (_host, request) =>
      new Promise((resolve) => {
        stale.push(() =>
          resolve({
            success: true,
            records:
              request.kind === 'containers'
                ? [{ ID: 'stale', Names: 'stale', State: 'running' }]
                : [],
            detail: null,
          }),
        );
      }),
  );
  mountDocker();
  await settle();
  updateVisibility(false);
  await settle();
  stale.forEach((resolve) => resolve());
  await settle();
  expect(root.querySelector('[data-ops-target="stale"]')).toBeNull();
  api.query.mockImplementation(async (_host, request) => ({
    success: true,
    records:
      request.kind === 'containers' ? [{ ID: 'fresh', Names: 'fresh', State: 'running' }] : [],
    detail:
      request.kind === 'capabilities' ? { dockerVersion: { Server: { Version: '28.0.0' } } } : null,
  }));
  updateVisibility(true);
  await settle();
  expect(root.querySelector('[data-ops-target="fresh"]')).not.toBeNull();
  expect(root.querySelector('.docker-summary strong')?.textContent).toBe('28.0.0');
  updateVisibility(false);
  await settle();
  platform.connections.host.state = 'idle';
  await settle();
  expect(root.querySelector('.docker-summary strong')?.textContent).toBe('—');
  const reads = api.query.mock.calls.length;
  platform.connections.host.state = 'connected';
  await settle();
  expect(api.query).toHaveBeenCalledTimes(reads);
  updateVisibility(true);
  await settle();
  expect(api.query).toHaveBeenCalledTimes(reads + 5);
  expect(root.querySelector('[data-ops-target="fresh"]')).not.toBeNull();
});

it.each([false, true])(
  'updates cached lists after a hidden container mutation succeeds (page hidden: %s)',
  async (hidden) => {
    vi.clearAllMocks();
    pinia = createPinia();
    setActivePinia(pinia);
    let changed = false;
    let complete!: () => void;
    api.query.mockImplementation(async (_host, request) => {
      if (request.kind === 'container_action')
        return new Promise((resolve) => {
          complete = () => {
            changed = true;
            resolve({ success: true, records: [] });
          };
        });
      return {
        success: true,
        detail: null,
        records:
          request.kind === 'containers'
            ? [{ ID: 'container', Names: 'container', State: changed ? 'exited' : 'running' }]
            : request.kind === 'images'
              ? [{ ID: changed ? 'new-image' : 'old-image' }]
              : [],
      };
    });
    mountDocker();
    await settle();
    const click = async (label: string) => {
      [...root.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent?.trim() === label)!
        .click();
      await settle();
    };
    await click('镜像');
    expect(root.querySelector('[data-ops-target="old-image"]')).not.toBeNull();
    await click('容器');
    await click('停止');
    expect(changed).toBe(false);
    await click('镜像');
    if (hidden) {
      updateVisibility(false);
      await settle();
    }
    const reads = api.query.mock.calls.length;
    complete();
    await settle();
    expect(changed).toBe(true);
    if (hidden) {
      expect(api.query).toHaveBeenCalledTimes(reads);
      updateVisibility(true);
      await settle();
    }
    expect(root.querySelector('[data-ops-target="new-image"]')).not.toBeNull();
    expect(root.querySelector('[data-ops-target="old-image"]')).toBeNull();
    expect(root.querySelectorAll('.docker-summary strong')[2]?.textContent).toBe('0');
  },
);
it('discards a list response made stale by another tab mutation and reloads the visible list', async () => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  let changed = false;
  let delayImages = false;
  let complete!: () => void;
  const stale: (() => void)[] = [];
  api.query.mockImplementation(async (_host, request) => {
    if (request.kind === 'container_action')
      return new Promise((resolve) => {
        complete = () => {
          changed = true;
          resolve({ success: true, records: [] });
        };
      });
    const response = {
      success: true,
      detail: null,
      records:
        request.kind === 'containers'
          ? [{ ID: 'container', Names: 'container', State: 'running' }]
          : request.kind === 'images'
            ? [{ ID: changed ? 'new-image' : 'old-image' }]
            : [],
    };
    if (request.kind === 'images' && delayImages)
      return new Promise((resolve) => stale.push(() => resolve(response)));
    return response;
  });
  mountDocker();
  await settle();
  const click = async (label: string) => {
    [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.trim() === label)!
      .click();
    await settle();
  };
  await click('镜像');
  await click('容器');
  await click('停止');
  await click('镜像');
  delayImages = true;
  await click('刷新');
  expect(stale).toHaveLength(2);
  delayImages = false;
  complete();
  await settle();
  stale.forEach((resolve) => resolve());
  await settle();
  expect(root.querySelector('[data-ops-target="new-image"]')).not.toBeNull();
  expect(root.querySelector('[data-ops-target="old-image"]')).toBeNull();
});

it('keeps all four global metrics above the tabs and independent of tab selection and search', async () => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  api.query.mockImplementation(async (_host, request) => ({
    success: true,
    code: null,
    message: null,
    detail:
      request.kind === 'capabilities' ? { dockerVersion: { Server: { Version: '27.5.1' } } } : null,
    records:
      request.kind === 'images'
        ? [{ ID: 'one', Repository: 'first' }, { ID: 'one', Repository: 'second' }, { ID: 'two' }]
        : request.kind === 'containers'
          ? [
              { ID: 'running', State: 'running' },
              { ID: 'paused', State: 'paused' },
              { ID: 'exited', State: 'exited' },
            ]
          : request.kind === 'compose_projects'
            ? [{ Name: 'shop' }, { Name: 'worker' }]
            : [],
  }));
  mountDocker();
  await settle();
  const summary = root.querySelector('.docker-summary')!;
  const values = () => [...summary.querySelectorAll('strong')].map((node) => node.textContent);
  expect(values()).toEqual(['27.5.1', '2', '1', '2']);
  expect(summary.parentElement).toBe(root.querySelector('.docker-workbench'));
  expect(summary.nextElementSibling).toBe(root.querySelector('.server-tabs'));
  for (const label of ['镜像', 'Compose 项目', '容器']) {
    [...root.querySelectorAll<HTMLButtonElement>('.server-tabs button')]
      .find((button) => button.textContent?.trim() === label)!
      .click();
    await settle();
    const search = root.querySelector<HTMLInputElement>('[aria-label="运维项目搜索"]')!;
    search.value = 'no matches';
    search.dispatchEvent(new Event('input'));
    await settle();
    expect(root.querySelector('.docker-summary')).toBe(summary);
    expect(root.querySelectorAll('.docker-summary')).toHaveLength(1);
    expect(root.querySelector('.operations-view .docker-summary')).toBeNull();
    expect(values()).toEqual(['27.5.1', '2', '1', '2']);
  }
  expect(
    api.query.mock.calls.filter(([, request]) => request.kind === 'capabilities'),
  ).toHaveLength(1);
});

it('isolates a failed global metric, retries on refresh and ignores an older version response', async () => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  let firstVersion = true;
  let failCompose = true;
  let finishVersion!: (response: unknown) => void;
  api.query.mockImplementation(async (_host, request) => {
    if (request.kind === 'capabilities' && firstVersion) {
      firstVersion = false;
      return new Promise((resolve) => {
        finishVersion = resolve;
      });
    }
    if (request.kind === 'compose_projects' && failCompose)
      throw new Error('Compose not installed');
    return {
      success: true,
      code: null,
      message: null,
      detail:
        request.kind === 'capabilities'
          ? { dockerVersion: { Server: { Version: '28.0.0' } } }
          : null,
      records: [],
    };
  });
  mountDocker();
  await settle();
  const values = () =>
    [...root.querySelectorAll('.docker-summary strong')].map((node) => node.textContent);
  expect(values()).toEqual(['—', '0', '0', '—']);
  expect(root.querySelector('.docker-summary')?.getAttribute('aria-busy')).toBe('true');
  expect(root.querySelectorAll('.docker-summary article')[3]?.getAttribute('title')).toBe(
    'Compose not installed',
  );
  expect(root.querySelector('.operations-view [role="alert"]')).toBeNull();
  failCompose = false;
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '刷新')!
    .click();
  await settle();
  expect(values()).toEqual(['28.0.0', '0', '0', '0']);
  expect(root.querySelector('.docker-stat-error')).toBeNull();
  expect(root.querySelector('.docker-summary')?.getAttribute('aria-busy')).toBe('false');
  finishVersion({
    success: true,
    records: [],
    detail: { dockerVersion: { Server: { Version: 'old' } } },
  });
  await settle();
  expect(values()).toEqual(['28.0.0', '0', '0', '0']);
});

it('updates English labels without reloading data or translating container names', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  api.query.mockImplementation(async (_host, request) => ({
    success: true,
    code: null,
    message: null,
    detail: request.kind === 'capabilities' ? { dockerState: 'running' } : null,
    records:
      request.kind === 'containers'
        ? [{ ID: 'language-container', Names: '容器', Image: '用户镜像', State: 'running' }]
        : [],
  }));
  mountDocker();
  await settle();
  const count = api.query.mock.calls.length;
  const row = root.querySelector('[data-ops-target="language-container"]');
  setLocale('en-US');
  await settle();
  expect(root.textContent).toContain('Running containers');
  expect(root.textContent).toContain('Compose projects');
  expect(root.textContent).toContain('用户镜像');
  expect(root.querySelector('[data-ops-target="language-container"]')).toBe(row);
  expect(row?.textContent).toContain('容器');
  expect(api.query).toHaveBeenCalledTimes(count);
  setLocale('zh-CN');
  await settle();
  expect(root.textContent).toContain('运行容器');
  expect(api.query).toHaveBeenCalledTimes(count);
});
it('opens the selected container shell with its name, short ID and actual shell context', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const id = 'a'.repeat(64);
  api.terminal.mockClear();
  api.query.mockImplementation(async (_host, request) => ({
    success: true,
    code: null,
    message: null,
    detail: request.kind === 'capabilities' ? { dockerState: 'running' } : null,
    records:
      request.kind === 'containers' ? [{ ID: id, Names: 'backend-api', State: 'running' }] : [],
  }));
  mountDocker();
  await settle();
  root
    .querySelector<HTMLButtonElement>(
      `[data-ops-target="${id}"] .ops-row-actions button:last-child`,
    )!
    .click();
  await settle();
  expect(api.terminal).toHaveBeenCalledExactlyOnceWith('shell-ticket', 'host', {
    title: 'backend-api',
    description: 'aaaaaaaaaaaa · /bin/sh',
  });
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
        : request.kind === 'container_startup'
          ? {
              id: 'container',
              source: 'inspect',
              environmentRevealed: request.revealEnv,
              warnings: [],
              configuration: {
                services: {
                  container: {
                    image: 'owned-image',
                    ports: [{ target: 8080, published: '8081', protocol: 'tcp', host_ip: '::' }],
                    expose: ['8443/tcp'],
                    volumes: [
                      { type: 'bind', source: '/srv/fixture', target: '/data', read_only: true },
                    ],
                  },
                },
              },
            }
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
  expect(
    [...(detail()?.querySelectorAll('[role="tab"]') ?? [])].map((tab) => tab.textContent?.trim()),
  ).toEqual(['概览', '资源使用', '启动配置', '环境变量']);
  await selectTab('启动配置');
  expect(api.query).toHaveBeenCalledWith('host', {
    kind: 'container_startup',
    id: 'container',
    revealEnv: true,
    inspectOnly: false,
  });
  expect(panel()?.querySelector('pre')?.textContent).toContain('published: "8081"');
  expect(panel()?.querySelector('pre')?.textContent).toContain('"8443/tcp"');
  expect(panel()?.querySelector('pre')?.textContent).toContain('/srv/fixture');
  expect(panel()?.querySelector('pre')?.textContent).toContain('/data');
  expect(panel()?.querySelector('pre')?.textContent).toContain('read_only: true');
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
  expect(api.terminal).toHaveBeenCalledWith('shell-ticket', 'host', {
    title: 'owned-container',
    description: 'container · /bin/sh',
  });
  expect(document.querySelector('[aria-label="确认运维目标"]')).toBeNull();
  await click('镜像');
  expect(actionLabels('image')).toEqual(['删除', '导出', '远程传输']);
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
    expected: '27.5.1',
  },
  {
    name: 'missing server information',
    detail: {
      dockerInstalled: true,
      dockerState: 'unavailable',
      dockerVersion: { Client: { Version: '28.5.1', Os: 'darwin', Arch: 'arm64' }, Server: null },
    },
    expected: '不可用',
  },
  {
    name: 'Docker not installed',
    detail: { dockerInstalled: false, dockerState: 'absent' },
    expected: '不可用',
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
    expected: '不可用',
  },
])(
  'shows the daemon version in the global summary without a Docker information dialog for $name',
  async ({ detail, expected }) => {
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
    const summary = root.querySelector('.docker-summary')!;
    expect(summary.querySelector('strong')?.textContent).toBe(expected);
    expect(
      [...summary.querySelectorAll('article > div > span')].map((field) => field.textContent),
    ).toEqual(['Docker 版本', '本地镜像', '运行容器', 'Compose 配置']);
    expect(root.querySelector('.ops-capabilities, dialog')).toBeNull();
    expect(root.textContent).not.toContain('Docker信息');
    expect(root.textContent).not.toContain('Docker：');
    expect(summary.querySelector('pre, details')).toBeNull();
    for (const hidden of [
      'CLIENT_BUILD_METADATA',
      'GO_BUILD_METADATA',
      'UNNEEDED_DETAILS',
      'containerd',
    ])
      expect(root.textContent).not.toContain(hidden);
  },
);

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
  api.query.mockResolvedValue({ success: true, records: [], detail: null });
  await click('刷新');
  expect(root.textContent).toContain('没有匹配项目');
  expect(root.querySelectorAll('.docker-summary strong')[3]?.textContent).toBe('0');
  api.query.mockRejectedValue(new Error('docker: unknown command: compose'));
  await click('刷新');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('unknown command');
  expect(root.querySelectorAll('.docker-summary strong')[3]?.textContent).toBe('0');
  expect(root.querySelectorAll('.docker-summary article')[3]?.textContent).toContain('读取失败');
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
    ).toHaveLength(reads + 2);
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
