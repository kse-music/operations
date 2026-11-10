import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import { editorApi, type EditorBootstrap } from './services/editor';
const mock = vi.hoisted(() => ({
  close: vi.fn(),
  unlisten: vi.fn(),
  listener: undefined as (() => void) | undefined,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, listener: () => void) => {
    mock.listener = listener;
    return mock.unlisten;
  }),
}));
vi.mock('./components/RemoteEditorHost.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      setup(_props, { expose }) {
        expose({ requestClose: mock.close });
        return () => h('div', { class: 'fixture-editor' });
      },
    }),
  };
});
import EditorWindow from './EditorWindow.vue';
let app: App, pinia: Pinia, root: HTMLElement;
const loaded: EditorBootstrap = {
  document: {
    token: 'doc',
    sessionId: 'bound',
    path: '/config.ini',
    content: 'test',
    sha256: 'hash',
    permissions: null,
    uid: null,
    gid: null,
    atomicSave: true,
  },
  theme: 'light',
  interfaceFontSize: 'ultraLarge',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.spyOn(editorApi, 'load').mockResolvedValue(loaded);
  vi.spyOn(editorApi, 'close').mockResolvedValue(undefined);
  pinia = createPinia();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(EditorWindow).use(pinia);
});
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root.remove();
  vi.unstubAllGlobals();
});
it('routes native close requests to the editor draft review and applies saved theme and font size', async () => {
  app.mount(root);
  await vi.waitFor(() => expect(root.querySelector('.fixture-editor')).not.toBeNull());
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(document.documentElement.style.getPropertyValue('--interface-font-scale')).toBe('1.45');
  mock.listener!();
  expect(mock.close).toHaveBeenCalledOnce();
  expect(editorApi.close).not.toHaveBeenCalled();
  app.unmount();
  app = undefined!;
  expect(mock.unlisten).toHaveBeenCalledOnce();
});
it('keeps retry and close available when document loading fails', async () => {
  vi.mocked(editorApi.load).mockRejectedValueOnce({ message: '文档读取失败' });
  app.mount(root);
  await vi.waitFor(() => expect(root.textContent).toContain('文档读取失败'));
  expect(mock.listener).toBeDefined();
  mock.listener!();
  await vi.waitFor(() => expect(editorApi.close).toHaveBeenCalledExactlyOnceWith(false));
  [...root.querySelectorAll('button')].find((button) => button.textContent === '重试')!.click();
  await vi.waitFor(() => expect(root.querySelector('.fixture-editor')).not.toBeNull());
  await nextTick();
  expect(editorApi.load).toHaveBeenCalledTimes(2);
});
