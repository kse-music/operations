import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import { createPluginUiBridge } from './plugin-ui-bridge';
import { usePluginsStore } from '../stores/plugins';
import { useOpsStore } from '../stores/ops';
import { useWorkspaceStore } from '../stores/workspace';
import { useNotificationsStore } from '../stores/notifications';
import { hostInput } from '../types/hosts';
import type { PluginPermission, PluginUiPage } from '../types/plugins';
const api = vi.hoisted(() => ({ invoke: vi.fn(), tool: vi.fn(), server: vi.fn() }));
vi.mock('./plugin-server', () => ({
  pluginInvokeRequest: api.invoke,
  pluginToolRequest: api.tool,
  pluginServerRequest: api.server,
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
        apiVersion: '^1.4.0',
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
});
afterEach(() => {
  disposePinia(pinia);
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
it('lets an assistant settings page list public model metadata only with assistant permission', async () => {
  const { useModelsStore } = await import('../stores/models');
  const { aiApi } = await import('./ai');
  const { defaultAiConfig } = await import('../types/ai');
  const models = [
    { id: 'model-a', name: 'Bound model', revision: 'r1', hasKey: true, config: defaultAiConfig() },
  ];
  const list = vi.spyOn(aiApi, 'models').mockResolvedValue(models);
  const ui = bridge();
  await expect(ui.call('ai_models', {})).rejects.toMatchObject({
    code: 'PLUGIN_PERMISSION_DENIED',
  });
  grant('ui.contribute', 'assistant.use');
  expect(await ui.call('ai_models', {})).toEqual(models);
  expect(useModelsStore().models).toEqual(models);
  expect(ui.snapshot()).toMatchObject({ models });
  expect(list).toHaveBeenCalledOnce();
});
it('rejects hidden frame requests and late results before a different host can receive them', async () => {
  let active = true;
  const ui = createPluginUiBridge({
    id,
    revision: 'revision',
    page,
    hostId: 'a',
    isActive: () => active,
    stream: vi.fn(),
  });
  let finish!: (value: unknown) => void;
  api.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = ui.call('invoke', { action: 'greet', values: {} });
  active = false;
  ui.suspend();
  finish({ output: 'late result for a' });
  await expect(pending).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' });
  await expect(ui.call('invoke', { action: 'greet', values: {} })).rejects.toMatchObject({
    code: 'PLUGIN_PERMISSION_DENIED',
  });
  expect(api.invoke).toHaveBeenCalledOnce();
  expect(ui.snapshot()).toMatchObject({ hostId: 'a' });
});
it('permits only declared Wasm actions and does not expose native commands or host inventory to a UI-only grant', async () => {
  const ui = bridge();
  api.invoke.mockResolvedValue({ output: 'from Wasm' });
  await expect(
    ui.call('invoke', { action: 'greet', values: { name: 'safe' }, id: 'another-plugin' }),
  ).resolves.toEqual({ output: 'from Wasm' });
  expect(api.invoke).toHaveBeenCalledWith(id, page, 'greet', { name: 'safe' });
  for (const method of [
    'hosts.list',
    'credential_save',
    'ai_model_save',
    'plugin_grant',
    'ops_open',
  ])
    await expect(ui.call(method, { id: 'another-plugin', hostId: 'host' })).rejects.toMatchObject({
      code: 'PLUGIN_PERMISSION_DENIED',
    });
  expect(ui.snapshot()).toMatchObject({ catalog: null, operations: {}, files: {}, models: [] });
});
it('rejects stale results and all later calls after an installation generation changes', async () => {
  const ui = bridge();
  let finish!: (value: unknown) => void;
  api.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const request = ui.call('invoke', { action: 'greet', values: {} });
  usePluginsStore().installed[0]!.revision = 'replacement';
  finish({ output: 'stale' });
  await expect(request).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' });
  await expect(ui.call('invoke', { action: 'greet', values: {} })).rejects.toMatchObject({
    code: 'PLUGIN_PERMISSION_DENIED',
  });
});
it('keeps connection leases opaque and freezes approved input before dispatching through Wasm', async () => {
  grant('ui.contribute', 'assistant.use');
  const host = {
    ...hostInput(),
    credentialId: 'private-credential-reference',
    id: 'host',
    hostname: 'qa.example',
    username: 'qa',
    createdAt: '',
    updatedAt: '',
  };
  useOpsStore().connections.host = {
    host,
    state: 'connected',
    error: null,
    trust: null,
    session: {
      id: 'private-session',
      hostId: 'host',
      transportId: 'private-transport',
      routeHostIds: ['host'],
    },
  };
  const ui = bridge();
  const snapshot = ui.snapshot() as { operations: Record<string, { session: { id: string } }> };
  expect(JSON.stringify(snapshot)).not.toContain('private-session');
  expect(JSON.stringify(snapshot)).not.toContain('private-transport');
  expect(JSON.stringify(snapshot)).not.toContain('private-credential-reference');
  const input = {
    input: {
      sessionId: snapshot.operations.host!.session.id,
      question: 'original question',
    },
  };
  let finish!: (value: unknown) => void;
  api.tool.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const request = ui.call('ai_prepare', input);
  input.input.question = 'changed question';
  finish({ id: 'task' });
  await request;
  expect(api.tool).toHaveBeenCalledWith(
    id,
    'ai_prepare',
    expect.objectContaining({
      input: expect.objectContaining({
        sessionId: 'private-session',
        question: 'original question',
      }),
    }),
    page,
    expect.any(AbortSignal),
    true,
  );
});
it('rejects removed tool operations before dispatch', async () => {
  grant('ui.contribute', 'assistant.use');
  for (const method of [
    'batch_start',
    'automation_catalog',
    'diagnostic_start',
    'diagnostic_list',
    'diagnostic_cancel',
    'files.pick',
  ])
    await expect(bridge().call(method, {})).rejects.toMatchObject({
      code: 'PLUGIN_PERMISSION_DENIED',
    });
  expect(api.tool).not.toHaveBeenCalled();
});

it('retains model navigation and notifications used by the remaining plugins', async () => {
  grant('ui.contribute');
  const ui = bridge();
  await ui.call('workspace.navigate', { view: 'models' });
  expect(useWorkspaceStore().current?.view).toBe('models');
  await ui.call('ui.notify', { message: 'Retained plugin notification', error: true });
  expect(
    useNotificationsStore().items.some((item) => item.text === 'Retained plugin notification'),
  ).toBe(true);
  await expect(ui.call('workspace.navigate', { view: 'settings' })).rejects.toMatchObject({
    code: 'PLUGIN_PERMISSION_DENIED',
  });
});

it('acknowledges approved model navigation when it hides its caller and denies subsequent hidden requests', async () => {
  let active = true;
  const navigate = vi.spyOn(useWorkspaceStore(), 'navigate').mockImplementation(() => {
    active = false;
    usePluginsStore().clearPlugin(id);
  });
  const ui = createPluginUiBridge({
    id,
    revision: 'revision',
    page,
    hostId: '',
    isActive: () => active,
    stream: vi.fn(),
  });
  await expect(ui.call('workspace.navigate', { view: 'models' })).resolves.toBeNull();
  await expect(ui.call('workspace.navigate', { view: 'models' })).rejects.toMatchObject({
    code: 'PLUGIN_PERMISSION_DENIED',
  });
  expect(navigate).toHaveBeenCalledTimes(1);
});
