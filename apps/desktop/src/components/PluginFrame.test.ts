import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, reactive, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import PluginFrame from './PluginFrame.vue';
import type { PluginUiPage } from '../types/plugins';

const bridge = vi.hoisted(() => ({
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
  const intent = reactive({ entryId: 'first' });
  pinia = createPinia();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(PluginFrame, {
    pluginId: 'dev.qa.custom',
    revision: 'revision',
    hostId: '',
    page,
    toolIntent: intent,
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
    props: { page: { id: 'custom' }, entryId: 'first' },
  });
  intent.entryId = 'second';
  await nextTick();
  expect(messages.at(-1)).toMatchObject({ props: { entryId: 'second' } });
  expect(root.textContent).not.toContain('could not be cloned');
  expect(port.close).not.toHaveBeenCalled();
});
