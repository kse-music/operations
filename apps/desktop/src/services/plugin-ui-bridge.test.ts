import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import { createPluginUiBridge } from './plugin-ui-bridge';
import { usePluginsStore } from '../stores/plugins';
import { useOpsStore } from '../stores/ops';
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
  grant('ui.contribute', 'batch.run');
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
      targets: [{ hostId: 'host', sessionId: snapshot.operations.host!.session.id }],
      operation: { kind: 'command', command: 'printf original' },
      confirmed: true,
    },
  };
  let finish!: (value: unknown) => void;
  api.tool.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const request = ui.call('batch_start', input);
  input.input.operation.command = 'printf changed';
  finish({ id: 'task' });
  await request;
  expect(api.tool).toHaveBeenCalledWith(
    id,
    'batch_start',
    expect.objectContaining({
      input: expect.objectContaining({
        targets: [{ hostId: 'host', sessionId: 'private-session' }],
        operation: { kind: 'command', command: 'printf original' },
      }),
    }),
    page,
    expect.any(AbortSignal),
    true,
  );
});
it('rejects local file sources that were not selected in the native picker', async () => {
  grant('ui.contribute', 'batch.run');
  await expect(
    bridge().call('batch_start', {
      input: { operation: { kind: 'file', source: 'C:/private.txt' }, confirmed: true },
    }),
  ).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' });
  expect(api.tool).not.toHaveBeenCalled();
});
it('returns opaque automation profile bindings and restores them only for subsequent requests', async () => {
  grant('ui.contribute', 'automation.manage');
  const ui = bridge();
  api.tool.mockResolvedValueOnce([
    { id: 'entry', body: 'printf safe' },
    [{ hostId: 'host', hostname: 'qa.example', port: 22, routeSignature: 'private-route' }],
  ]);
  const prepared = (await ui.call('automation_prepare', {
    entryId: 'entry',
    revision: 1,
    hostIds: ['host'],
  })) as [unknown, { routeSignature: string }[]];
  const profile = prepared[1][0]!.routeSignature;
  expect(profile).toMatch(/^sdk-profile-/);
  expect(JSON.stringify(prepared)).not.toContain('private-route');
  api.tool.mockResolvedValueOnce({ id: 'run' });
  await ui.call('automation_start', { input: { expectedProfiles: { host: profile } } });
  expect(api.tool).toHaveBeenLastCalledWith(
    id,
    'automation_start',
    { input: { expectedProfiles: { host: 'private-route' } } },
    page,
    expect.any(AbortSignal),
    true,
  );
});
