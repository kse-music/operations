import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import { createPluginUiBridge } from './plugin-ui-bridge';
import { usePluginsStore } from '../stores/plugins';
import { useOpsStore } from '../stores/ops';
import { useNotificationsStore } from '../stores/notifications';
import { hostInput } from '../types/hosts';
import { pluginsApi } from './plugins';
import { filesApi } from './files';
import type { PluginPermission, PluginUiPage } from '../types/plugins';
const api = vi.hoisted(() => ({ invoke: vi.fn(), platform: vi.fn() }));
vi.mock('./plugin-server', () => ({
  pluginInvokeRequest: api.invoke,
  pluginPlatformRequest: api.platform,
}));
let pinia: Pinia;
const id = 'dev.qa.independent';
const page: PluginUiPage = {
  id: 'custom',
  title: 'Custom',
  surface: { kind: 'frontend' },
  initialAction: null,
  fields: [],
  actions: [{ id: 'greet', label: 'Greet', discardDirty: false, enabledWhen: null }],
  log: null,
};

it.each(['elevated', 'switchingUser'] as const)(
  'rejects a plugin file connection while the desktop identity is %s',
  async (state) => {
    const { useHostsStore } = await import('../stores/hosts');
    const { useFilesStore } = await import('../stores/files');
    const host = { ...hostInput(), id: 'host', createdAt: '', updatedAt: '' };
    useHostsStore().catalog = {
      hosts: [host],
      groups: [],
      credentials: [],
      pendingSecretDeletions: 0,
    };
    const files = useFilesStore();
    files.connections.host = {
      host,
      id: 'sudo',
      path: '/',
      state: 'connected',
      error: null,
      trust: null,
      listing: null,
      loading: false,
      [state]: true,
    };
    const open = vi.spyOn(files, 'open');
    grant('ui.contribute', 'sftp.read');
    await expect(
      bridge().call('connections.ensure', { hostId: 'host', files: true }),
    ).rejects.toMatchObject({ code: 'PLUGIN_SFTP_IDENTITY' });
    expect(open).not.toHaveBeenCalled();
    expect(files.connections.host.id).toBe('sudo');
  },
);
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  const plugins = usePluginsStore();
  plugins.installed = [
    {
      source: 'user',
      manifest: {
        schemaVersion: 1,
        id,
        name: 'Independent',
        version: '1.0.0',
        author: 'QA',
        description: 'QA',
        apiVersion: '^5.0.0',
        entry: { backend: 'backend.wasm', ui: 'ui.json' },
        permissions: ['ui.contribute'],
        contributions: [],
        platforms: ['windows'],
        files: [],
        publisher: null,
      },
      enabled: true,
      trust: 'local_development_unverified',
      packageDigest: 'digest',
      revision: 'revision',
      previousVersion: null,
    },
  ];
  grant('ui.contribute');
  vi.spyOn(pluginsApi, 'scopeVisibility').mockResolvedValue();
  vi.spyOn(pluginsApi, 'closeScope').mockResolvedValue();
  vi.spyOn(pluginsApi, 'cancelScope').mockResolvedValue();
});
afterEach(() => {
  disposePinia(pinia);
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
function grant(...permissions: PluginPermission[]) {
  usePluginsStore().grants[id] = {
    version: 1,
    pluginId: id,
    pluginVersion: '1.0.0',
    publisher: null,
    packageDigest: 'digest',
    revision: 'revision',
    permissions,
    operations: [...permissions],
    readRoots: [],
    writeRoots: [],
  };
}
function bridge() {
  return createPluginUiBridge({ id, revision: 'revision', page, hostId: '', stream: vi.fn() });
}

it('opens the native file picker only with transfer permission and discards late hidden results', async () => {
  const pick = vi.spyOn(filesApi, 'pick').mockResolvedValue(['C:/images/image.tar']);
  await expect(bridge().call('localFiles.pick', { kind: 'files' })).rejects.toMatchObject({
    code: 'PLUGIN_PERMISSION_DENIED',
  });
  expect(pick).not.toHaveBeenCalled();
  grant('ui.contribute', 'sftp.transfer');
  expect(await bridge().call('localFiles.pick', { kind: 'files' })).toEqual([
    'C:/images/image.tar',
  ]);
  let active = true;
  const ui = createPluginUiBridge({
    id,
    revision: 'revision',
    page,
    hostId: 'host',
    isActive: () => active,
  });
  let finish: (value: string[]) => void = () => {};
  pick.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = ui.call('localFiles.pick', { kind: 'folder' });
  active = false;
  finish(['C:/exports']);
  await expect(pending).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' });
});

it('passes optional terminal display text while preserving ticket and permission checks', async () => {
  grant('ui.contribute', 'ssh.execute');
  const terminal = vi.fn();
  let active = true;
  const ui = createPluginUiBridge({
    id,
    revision: 'revision',
    page,
    hostId: 'host',
    terminal,
    isActive: () => active,
  });
  await ui.call('terminal.open', { ticket: 'opaque', hostId: 'host' });
  expect(terminal).toHaveBeenLastCalledWith('opaque', 'host', undefined);
  await ui.call('terminal.open', {
    ticket: 'opaque',
    hostId: 'host',
    presentation: { title: ' api ', description: 'abcdef · /bin/sh' },
  });
  expect(terminal).toHaveBeenLastCalledWith('opaque', 'host', {
    title: 'api',
    description: 'abcdef · /bin/sh',
  });
  active = false;
  await expect(
    ui.call('terminal.open', { ticket: 'opaque', hostId: 'host' }),
  ).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' });
  active = true;
  grant('ui.contribute');
  await expect(ui.call('terminal.open', { ticket: 'opaque', hostId: 'host' })).rejects.toThrow(
    '终端票据',
  );
  expect(terminal).toHaveBeenCalledTimes(2);
});
it.each([
  null,
  [],
  { title: 1 },
  { title: ' ' },
  { title: 'x'.repeat(161) },
  { description: 'x'.repeat(241) },
  { title: 'a\nb' },
  { title: 'api', command: 'forged command' },
])('rejects invalid terminal presentation %j', async (presentation) => {
  grant('ui.contribute', 'ssh.execute');
  const terminal = vi.fn();
  const ui = createPluginUiBridge({ id, revision: 'revision', page, hostId: 'host', terminal });
  await expect(
    ui.call('terminal.open', { ticket: 'opaque', hostId: 'host', presentation }),
  ).rejects.toThrow('终端显示信息');
  expect(terminal).not.toHaveBeenCalled();
});

it('notifies only this plugin after a successful settings write and keeps failures unchanged', async () => {
  const subject = bridge(),
    plugins = usePluginsStore();
  plugins.settingsRevisions['dev.other'] = 7;
  expect(subject.snapshot().settingsRevision).toBe(0);
  api.platform.mockRejectedValueOnce(new Error('save failed'));
  await expect(
    subject.call('platform.request', { operation: { kind: 'settings_write', value: {} } }),
  ).rejects.toThrow('save failed');
  expect(subject.snapshot().settingsRevision).toBe(0);
  api.platform.mockResolvedValue(null);
  await subject.call('platform.request', { operation: { kind: 'settings_write', value: {} } });
  expect(subject.snapshot().settingsRevision).toBe(1);
  await subject.call('platform.request', { operation: { kind: 'settings_read' } });
  expect(subject.snapshot().settingsRevision).toBe(1);
  expect(plugins.settingsRevisions['dev.other']).toBe(7);
});

it('binds draft ownership to the trusted page key and rejects invalid or hidden input', async () => {
  let active = true;
  const ui = createPluginUiBridge({
    id,
    revision: 'revision',
    page,
    hostId: 'host',
    contextKey: 'owner',
    isActive: () => active,
  });
  await ui.call('workspace.draft', { dirty: true, contextKey: 'forged' });
  expect(usePluginsStore().dirtyPages).toEqual({ owner: id });
  await expect(ui.call('workspace.draft', { dirty: 'true' })).rejects.toThrow('草稿作用域');
  active = false;
  await expect(ui.call('workspace.draft', { dirty: false })).rejects.toMatchObject({
    code: 'PLUGIN_PERMISSION_DENIED',
  });
  expect(usePluginsStore().dirty).toBe(true);
});
it.each([
  'ai_models',
  'ai_prepare',
  'ai_execute',
  'ai_local_codex_authorize',
  'ops_query',
  'system_query',
  'plugin_tool_stage',
  'invoke_native',
  'terminal_trust',
])('denies private/old method %s', async (method) => {
  await expect(bridge().call(method, {})).rejects.toMatchObject({
    code: 'PLUGIN_PERMISSION_DENIED',
  });
  expect(api.invoke).not.toHaveBeenCalled();
  expect(api.platform).not.toHaveBeenCalled();
});
it('passes action and platform requests through the same owner-bound helpers', async () => {
  const ui = createPluginUiBridge({
    id,
    revision: 'revision',
    page,
    hostId: 'host',
    contextKey: 'trusted',
  });
  api.invoke.mockResolvedValue({ ok: true });
  expect(
    await ui.call('invoke', { action: 'greet', input: { name: 'Ada' }, owner: 'forged' }),
  ).toEqual({ ok: true });
  expect(api.invoke).toHaveBeenCalledWith(
    id,
    page,
    'greet',
    { name: 'Ada' },
    expect.any(Function),
    'trusted',
    undefined,
  );
  const confirmation = { title: '停止容器？', message: '容器：web', confirmLabel: '停止' };
  await ui.call('invoke', { action: 'greet', input: {}, confirmation, owner: 'forged' });
  expect(api.invoke).toHaveBeenLastCalledWith(
    id,
    page,
    'greet',
    {},
    expect.any(Function),
    'trusted',
    confirmation,
  );
  await ui.call('platform.request', { operation: { kind: 'hosts' } });
  expect(api.platform).toHaveBeenCalledWith(id, { kind: 'hosts' }, expect.any(Function), 'trusted');
});
it('does not expose host inventory or lease metadata to a UI-only grant', async () => {
  const { useHostsStore } = await import('../stores/hosts');
  useHostsStore().catalog = {
    hosts: [
      {
        ...hostInput(),
        id: 'host',
        name: 'Server',
        credentialId: 'private-key',
        createdAt: '',
        updatedAt: '',
      },
    ],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  useOpsStore().connections.host = {
    host: useHostsStore().catalog!.hosts[0]!,
    state: 'connected',
    error: null,
    trust: null,
    session: {
      id: 'secret-lease',
      hostId: 'host',
      transportId: 'secret-transport',
      routeHostIds: ['host'],
    },
  };
  expect(bridge().snapshot()).toMatchObject({ hosts: [], connections: {} });
  grant('ui.contribute', 'hosts.read');
  const snapshot = bridge().snapshot(),
    json = JSON.stringify(snapshot);
  expect(snapshot.hosts).toHaveLength(1);
  expect(snapshot.connections.host).toEqual({ hostId: 'host', state: 'connected', error: null });
  for (const secret of [
    'private-key',
    'secret-lease',
    'secret-transport',
    'credentialId',
    'authMethod',
    'proxyCommand',
  ])
    expect(json).not.toContain(secret);
  grant('ui.contribute', 'ssh.execute');
  const selected = createPluginUiBridge({
    id,
    revision: 'revision',
    page,
    hostId: 'host',
  }).snapshot();
  expect(selected.hosts).toEqual([]);
  expect(Object.keys(selected.connections)).toEqual(['host']);
});
it('exports only public model metadata under the models.use grant', async () => {
  const { useModelsStore } = await import('../stores/models');
  const { defaultAiConfig } = await import('../types/ai');
  useModelsStore().models = [
    {
      id: 'model',
      name: 'Model',
      revision: 'r1',
      hasKey: true,
      config: { ...defaultAiConfig(), baseUrl: 'https://private-endpoint' },
    },
  ];
  expect(bridge().snapshot().models).toEqual([]);
  grant('ui.contribute', 'models.use');
  expect(bridge().snapshot().models).toMatchObject([{ id: 'model', revision: 'r1', hasKey: true }]);
  expect(JSON.stringify(bridge().snapshot())).not.toContain('private-endpoint');
});
it.each(['system', 'user'] as const)(
  'lets any declared settings UI navigate and close: %s',
  async (source) => {
    usePluginsStore().installed[0]!.source = source;
    const settingsAction = vi.fn();
    const ui = createPluginUiBridge({
      id,
      revision: 'revision',
      page,
      hostId: '',
      contextKey: 'settings',
      settingsAction,
    });
    await ui.call('workspace.navigate', { view: 'models' });
    await ui.call('settings.close', {});
    expect(settingsAction.mock.calls).toEqual([['models'], ['close']]);
    await expect(ui.call('workspace.navigate', { view: 'terminal' })).rejects.toThrow('导航目标');
  },
);
it.each(['system', 'user'] as const)(
  'retains only started work for an open hidden workspace: %s',
  async (source) => {
    usePluginsStore().installed[0]!.source = source;
    let active = true;
    let finish!: (v: unknown) => void;
    api.invoke.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const ui = createPluginUiBridge({
      id,
      revision: 'revision',
      page,
      hostId: 'host',
      contextKey: 'a',
      isActive: () => active,
      canRetain: () => true,
    });
    const job = ui.call('invoke', { action: 'greet', input: {} });
    active = false;
    ui.suspend();
    finish({ answer: 'complete' });
    expect(await job).toEqual({ answer: 'complete' });
    await expect(ui.call('invoke', { action: 'greet', input: {} })).rejects.toMatchObject({
      code: 'PLUGIN_PERMISSION_DENIED',
    });
    expect(pluginsApi.scopeVisibility).toHaveBeenCalledWith(id, 'a', false);
  },
);
it('rejects late results from replaced packages and disposed scopes', async () => {
  let finish!: (v: unknown) => void;
  api.invoke.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  const ui = createPluginUiBridge({ id, revision: 'revision', page, hostId: '', contextKey: 'a' });
  const checked = expect(ui.call('invoke', { action: 'greet', input: {} })).rejects.toMatchObject({
    code: 'PLUGIN_PERMISSION_DENIED',
  });
  usePluginsStore().installed[0]!.revision = 'new';
  finish('stale');
  await checked;
  usePluginsStore().installed[0]!.revision = 'revision';
  await ui.dispose();
  expect(pluginsApi.closeScope).toHaveBeenCalledWith(id, 'a');
  await expect(ui.call('invoke', { action: 'greet', input: {} })).rejects.toMatchObject({
    code: 'PLUGIN_PERMISSION_DENIED',
  });
});
it('cancels prompts and requests only for its owner', async () => {
  const p = usePluginsStore();
  const a = createPluginUiBridge({ id, revision: 'revision', page, hostId: '', contextKey: 'a' });
  const answer = p.ask('Other page', 'Frozen operation', undefined, 'b');
  await a.call('actions.cancel', {});
  await a.dispose();
  expect(p.prompt?.owner).toBe('b');
  expect(pluginsApi.cancelScope).toHaveBeenCalledWith(id, 'a');
  p.decide(false);
  await answer;
});
it('reports interface font scale and bounded notifications', async () => {
  const ui = bridge();
  document.documentElement.style.setProperty('--interface-font-scale', '1.25');
  expect(ui.snapshot().interfaceFontScale).toBe(1.25);
  document.documentElement.style.removeProperty('--interface-font-scale');
  const push = vi.spyOn(useNotificationsStore(), 'push');
  await ui.call('ui.notify', { message: 'Done' });
  expect(push).toHaveBeenCalledWith('Done', false);
  await expect(ui.call('ui.notify', { message: 'x'.repeat(2049) })).rejects.toThrow('通知超过');
});
it('waits for late SSH fingerprint metadata and only the trusted parent can accept it', async () => {
  const { useHostsStore } = await import('../stores/hosts');
  const { terminalApi } = await import('./terminal');
  const host = { ...hostInput(), id: 'host', hostname: 'fixture', createdAt: '', updatedAt: '' };
  useHostsStore().catalog = {
    hosts: [host],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  grant('ui.contribute', 'ssh.execute');
  const ops = useOpsStore();
  vi.spyOn(ops, 'open').mockImplementation(async () => {
    ops.connections.host = {
      host,
      state: 'awaiting_trust',
      trust: null,
      error: null,
      session: {
        id: 'native-lease',
        hostId: 'host',
        transportId: 'private',
        routeHostIds: ['host'],
      },
    };
  });
  const trust = vi.spyOn(terminalApi, 'trust').mockImplementation(async () => {
    ops.connections.host!.state = 'connected';
    ops.connections.host!.trust = null;
  });
  const ui = createPluginUiBridge({
    id,
    revision: 'revision',
    page,
    hostId: 'host',
    contextKey: 'owner',
  });
  const pending = ui.call('connections.ensure', { hostId: 'host' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(trust).not.toHaveBeenCalled();
  expect(usePluginsStore().prompt).toBeNull();
  ops.connections.host!.trust = {
    hostname: 'fixture',
    port: 22,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:fixture',
    status: 'unknown',
  } as never;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(usePluginsStore().prompt?.message).toContain('SHA256:fixture');
  expect(trust).not.toHaveBeenCalled();
  usePluginsStore().decide(true);
  expect(await pending).toEqual({ hostId: 'host', state: 'connected' });
  expect(trust).toHaveBeenCalledExactlyOnceWith('native-lease', true);
});
it('preserves connection failure diagnostics and stops waiting when its page hides', async () => {
  const { useHostsStore } = await import('../stores/hosts');
  const host = { ...hostInput(), id: 'host', createdAt: '', updatedAt: '' };
  useHostsStore().catalog = {
    hosts: [host],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  grant('ui.contribute', 'ssh.execute');
  const ops = useOpsStore();
  vi.spyOn(ops, 'open').mockImplementation(async () => {
    ops.connections.host = {
      host,
      state: 'connecting',
      trust: null,
      error: null,
      session: undefined,
    };
  });
  const ui = createPluginUiBridge({
    id,
    revision: 'revision',
    page,
    hostId: 'host',
    contextKey: 'owner',
  });
  const failed = expect(ui.call('connections.ensure', { hostId: 'host' })).rejects.toThrow(
    '异步认证失败',
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  Object.assign(ops.connections.host!, { state: 'failed', error: '异步认证失败' });
  await failed;
  const cancelled = expect(ui.call('connections.ensure', { hostId: 'host' })).rejects.toMatchObject(
    { code: 'PLUGIN_CANCELLED' },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  ui.suspend();
  await cancelled;
});

it('allows hidden-page reduction of full access while blocking hidden elevation', async () => {
  const ui = createPluginUiBridge({
    id,
    revision: 'revision',
    page,
    hostId: '',
    stream: vi.fn(),
    contextKey: 'trusted',
    isActive: () => false,
  });
  api.platform.mockResolvedValue(null);
  await ui.call('platform.request', { operation: { kind: 'approval_mode', mode: 'request' } });
  expect(api.platform).toHaveBeenCalledExactlyOnceWith(
    id,
    { kind: 'approval_mode', mode: 'request' },
    expect.any(Function),
    'trusted',
  );
  await expect(
    ui.call('platform.request', { operation: { kind: 'approval_mode', mode: 'full' } }),
  ).rejects.toThrow();
  expect(api.platform).toHaveBeenCalledTimes(1);
});
