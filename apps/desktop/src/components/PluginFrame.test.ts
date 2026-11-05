/* eslint-disable vue/one-component-per-file -- Each test mounts an isolated component. */
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, ref, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import PluginFrame from './PluginFrame.vue';
import type { PluginUiPage } from '../types/plugins';
import { useModelsStore } from '../stores/models';

const bridge = vi.hoisted(() => ({
  suspend: vi.fn(),
  snapshot: vi.fn(() => ({ theme: 'dark' })),
  dispose: vi.fn(async () => {}),
  call: vi.fn(),
}));
vi.mock('../services/plugin-ui-bridge', () => ({ createPluginUiBridge: () => bridge }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
let app: App | undefined, pinia: Pinia | undefined, root: HTMLDivElement | undefined;
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
  vi.unstubAllGlobals();
});

it('refreshes shared models when a cached assistant becomes active again', async () => {
  pinia = createPinia();
  const refresh = vi.spyOn(useModelsStore(pinia), 'refresh').mockResolvedValue();
  const active = ref(true);
  const page: PluginUiPage = {
    id: 'assistant',
    title: 'Assistant',
    surface: { kind: 'tool', tool: 'assistant' },
    fields: [],
    actions: [],
    initialAction: null,
    log: null,
  };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp({
    render: () =>
      h(PluginFrame, {
        pluginId: 'dev.qa.assistant',
        revision: 'r1',
        hostId: '',
        page,
        active: active.value,
      }),
  }).use(pinia);
  app.mount(root);
  expect(refresh).toHaveBeenCalledOnce();
  active.value = false;
  await nextTick();
  active.value = true;
  await nextTick();
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('keeps nested reactive context cloneable across the frame boundary and rejects an unrelated sender', async () => {
  const messages: Record<string, unknown>[] = [];
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    start: vi.fn(),
    close: vi.fn(),
    postMessage(value: Record<string, unknown>) {
      messages.push(structuredClone(value));
    },
  };
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = port;
      port2 = {};
    },
  );
  const page = reactive<PluginUiPage>({
    id: 'custom',
    title: 'Custom',
    surface: { kind: 'frontend' },
    actions: [],
    fields: [],
    log: null,
    initialAction: null,
  });
  pinia = createPinia();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(PluginFrame, {
    pluginId: 'dev.qa.custom',
    revision: 'revision',
    hostId: '',
    page,
  }).use(pinia);
  app.mount(root);
  const frame = root.querySelector('iframe')!;
  const connect = (source: Window) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        origin: 'null',
        data: { kind: 'serverdeck-sdk-ready', version: 1 },
      }),
    );
  connect(window);
  expect(port.start).not.toHaveBeenCalled();
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  connect(frame.contentWindow!);
  port.onmessage!({ data: { kind: 'connected' } });
  expect(messages.at(-1)).toMatchObject({
    kind: 'context',
    props: { page: { id: 'custom', title: 'Custom' } },
  });
  page.title = 'Updated';
  useModelsStore(pinia).models = [];
  await nextTick();
  expect(messages.at(-1)).toMatchObject({ props: { page: { title: 'Updated' } } });
  expect(root.textContent).not.toContain('could not be cloned');
  expect(port.close).not.toHaveBeenCalled();
});
