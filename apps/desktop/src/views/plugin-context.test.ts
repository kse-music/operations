/* eslint-disable vue/one-component-per-file -- Each test mounts an isolated view. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import PluginView from './PluginView.vue';
import { usePluginsStore } from '../stores/plugins';
import { useHostsStore } from '../stores/hosts';
import { useOpsStore } from '../stores/ops';
import { pluginsApi } from '../services/plugins';
import { hostInput } from '../types/hosts';
import { systemPluginFixtures } from '../services/system-plugins.fixture';
import { toolPluginState } from '../services/system-plugins.fixture';
import { useWorkspaceStore } from '../stores/workspace';
import resourceUi from '../../../../plugins/system/services/ui.json';
import type { PluginUi } from '../types/plugins';

vi.mock('../components/PluginFrame.vue', () => ({
  default: { props: ['active'], template: '<div data-frame :data-active="active" />' },
}));
let pinia: Pinia, app: App | undefined, root: HTMLDivElement;
const state = reactive({ active: true });
const host = {
  ...hostInput(),
  id: 'a',
  name: 'Host a',
  hostname: 'a.example',
  createdAt: '',
  updatedAt: '',
};
const id = 'cn.hiboot.plugins.services';
const settle = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
  await nextTick();
};
function mount() {
  app = createApp({
    render: () =>
      h(PluginView, {
        pluginId: id,
        contributionId: 'server',
        hostId: 'a',
        tabKey: 'extension:resources:server:a',
        active: state.active,
      }),
  }).use(pinia);
  app.mount(root);
}
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  state.active = true;
  root = document.createElement('div');
  document.body.append(root);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  useHostsStore().catalog = {
    hosts: [host],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  const plugins = usePluginsStore(),
    plugin = { ...systemPluginFixtures()[0]!, enabled: true };
  plugins.installed = [plugin];
  plugins.grants[id] = {
    version: 1,
    pluginId: id,
    pluginVersion: plugin.manifest.version,
    publisher: null,
    packageDigest: plugin.packageDigest,
    revision: plugin.revision,
    permissions: plugin.manifest.permissions,
    operations: [...plugin.manifest.permissions],
    readRoots: [],
    writeRoots: [],
  };
  plugins.schemas[id] = { revision: plugin.revision, ui: resourceUi as PluginUi };
  vi.spyOn(pluginsApi, 'context').mockResolvedValue();
  vi.spyOn(pluginsApi, 'activate').mockResolvedValue({ state: 'active' } as never);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  root.remove();
  disposePinia(pinia);
  vi.restoreAllMocks();
});

it('automatically connects the entry host and retries a failed connection without a host selector', async () => {
  const ops = useOpsStore();
  const open = vi.spyOn(ops, 'open').mockImplementation(async () => {
    ops.connections.a = { host, state: 'failed', error: '连接失败', trust: null };
  });
  mount();
  await settle();
  expect(open).toHaveBeenCalledWith(host, false);
  expect(root.querySelector('[aria-label="插件目标主机"]')).toBeNull();
  expect(root.querySelector('[data-frame]')).toBeNull();
  expect(root.textContent).toContain('主机连接失败');
  open.mockImplementation(async () => {
    ops.connections.a = {
      host,
      state: 'connected',
      error: null,
      trust: null,
      session: { id: 'ops-a', hostId: 'a', transportId: 'transport-a', routeHostIds: ['a'] },
    };
  });
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent === '重试连接')!
    .click();
  await settle();
  expect(root.querySelector('[data-frame]')).not.toBeNull();
  expect(pluginsApi.context).toHaveBeenLastCalledWith(id, {
    hostId: 'a',
    opsSession: 'ops-a',
    fileSession: null,
  });
});

it('retains fingerprint review and removes its dialog when the host page becomes inactive', async () => {
  const ops = useOpsStore();
  vi.spyOn(ops, 'open').mockImplementation(async () => {
    ops.connections.a = {
      host,
      state: 'awaiting_trust',
      error: null,
      session: { id: 'ops-a', hostId: 'a', transportId: 'transport-a', routeHostIds: ['a'] },
      trust: {
        type: 'trust',
        hostname: 'a.example',
        port: 22,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:review-required',
        status: 'unknown',
      } as never,
    };
  });
  const trust = vi.spyOn(ops, 'trust').mockResolvedValue();
  mount();
  await settle();
  expect(document.querySelector('dialog[aria-label="核验 SSH 主机指纹"]')?.textContent).toContain(
    'SHA256:review-required',
  );
  expect(trust).not.toHaveBeenCalled();
  expect(root.querySelector('[data-frame]')).toBeNull();
  state.active = false;
  await settle();
  expect(document.querySelector('dialog[aria-label="核验 SSH 主机指纹"]')).toBeNull();
  expect(pluginsApi.context).toHaveBeenLastCalledWith(id, null);
});

it('keeps the cached frame inactive until its released runtime has been reactivated', async () => {
  vi.spyOn(useOpsStore(), 'open').mockResolvedValue();
  useOpsStore().connections.a = {
    host,
    state: 'connected',
    error: null,
    trust: null,
    session: { id: 'ops-a', hostId: 'a', transportId: 'transport-a', routeHostIds: ['a'] },
  };
  mount();
  await settle();
  const frame = root.querySelector('[data-frame]');
  expect(frame?.getAttribute('data-active')).toBe('true');
  state.active = false;
  await settle();
  expect(frame?.getAttribute('data-active')).toBe('false');
  expect(pluginsApi.context).toHaveBeenLastCalledWith(id, null);
  let activated!: (value: never) => void;
  vi.mocked(pluginsApi.activate).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        activated = resolve;
      }),
  );
  state.active = true;
  await settle();
  expect(frame?.getAttribute('data-active')).toBe('false');
  expect((frame as HTMLElement).style.display).toBe('none');
  expect(root.textContent).toContain('正在准备插件');
  activated({ state: 'active' } as never);
  await settle();
  expect(root.querySelector('[data-frame]')).toBe(frame);
  expect(frame?.getAttribute('data-active')).toBe('true');
  expect((frame as HTMLElement).style.display).toBe('');
});
it('keeps the built-in assistant frame and native generation while its host workspace stays open', async () => {
  const plugins = usePluginsStore();
  Object.assign(plugins, toolPluginState());
  const assistant = 'cn.hiboot.plugins.assistant';
  const workspace = useWorkspaceStore();
  await workspace.openPlugin(assistant, 'assistant', 'a');
  vi.spyOn(useOpsStore(), 'open').mockResolvedValue();
  useOpsStore().connections.a = {
    host,
    state: 'connected',
    error: null,
    trust: null,
    session: { id: 'ops-a', hostId: 'a', transportId: 'transport-a', routeHostIds: ['a'] },
  };
  app = createApp({
    render: () =>
      h(PluginView, {
        pluginId: assistant,
        contributionId: 'assistant',
        hostId: 'a',
        tabKey: workspace.pluginPages[0]!.key,
        active: state.active,
      }),
  }).use(pinia);
  app.mount(root);
  await settle();
  const version = plugins.contextVersion(assistant);
  const calls = vi.mocked(pluginsApi.context).mock.calls.length;
  const frame = root.querySelector('[data-frame]');
  expect(frame).not.toBeNull();
  state.active = false;
  await settle();
  expect(plugins.contextVersion(assistant)).toBe(version);
  expect(pluginsApi.context).toHaveBeenCalledTimes(calls);
  expect((frame as HTMLElement).style.display).toBe('');
  state.active = true;
  await settle();
  expect(root.querySelector('[data-frame]')).toBe(frame);
  expect(plugins.contextVersion(assistant)).toBe(version);
});
