import { afterEach, expect, it, vi } from 'vitest';
import { h, nextTick, reactive } from 'vue';
import { mountPlugin } from './runtime';
import { request } from './transport';
import { usePlatformContext } from './context';
import { usePluginVisibility } from './visibility';
import { createTranslator, setLocale, locale } from './i18n';
afterEach(() => {
  setLocale('zh-CN');
  window.dispatchEvent(new Event('pagehide'));
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--interface-font-scale');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('applies the authenticated host language without remounting or sending requests', async () => {
  const fixture = mount();
  fixture.connect();
  const translate = createTranslator({ 设置: 'Settings' });
  for (const language of ['en-US', 'zh-CN', 'en-US']) {
    fixture.context({ language });
    await nextTick();
    expect(locale.value).toBe(language);
    expect(usePlatformContext().language).toBe(language);
    expect(document.documentElement.lang).toBe(language);
    expect(translate('设置')).toBe(language === 'en-US' ? 'Settings' : '设置');
  }
  expect(fixture.rendered).toHaveBeenCalledOnce();
  expect(fixture.sent.filter((packet) => packet.kind === 'request')).toHaveLength(0);
});
function mount() {
  const sent: Record<string, unknown>[] = [];
  const rendered = vi.fn();
  const announce = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const port = {
    onmessage: null as ((event: { data: Record<string, unknown> }) => void) | null,
    start: vi.fn(),
    close: vi.fn(),
    postMessage: (value: Record<string, unknown>) => sent.push(structuredClone(value)),
  };
  document.body.innerHTML = '<div id="app"></div>';
  mountPlugin({
    setup() {
      const state = usePlatformContext(),
        visible = usePluginVisibility();
      rendered();
      return () => h('p', state.hostId + ':' + state.hosts.length + ':' + visible.value);
    },
  });
  const connect = (source: MessageEventSource = window) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        data: { kind: 'serverdeck-sdk-connect' },
        ports: [port as unknown as MessagePort],
      }),
    );
  const context = (state: Record<string, unknown> = {}, visible = true) =>
    port.onmessage!({
      data: {
        kind: 'context',
        props: { hostId: 'h' },
        visible,
        state: {
          theme: 'dark',
          hosts: [],
          groups: [],
          connections: {},
          models: [],
          settingsRevision: 0,
          ...state,
        },
      },
    });
  return { port, sent, connect, context, rendered, announce };
}
it('announces readiness after registering its listener and acknowledges the parent connection', () => {
  const fixture = mount();
  expect(fixture.announce).toHaveBeenCalledExactlyOnceWith(
    { kind: 'serverdeck-sdk-ready', version: 1 },
    '*',
  );
  fixture.connect();
  expect(fixture.sent[0]).toEqual({ kind: 'connected' });
  expect(fixture.rendered).not.toHaveBeenCalled();
  fixture.context();
  expect(fixture.rendered).toHaveBeenCalledOnce();
});
it('authenticates its parent channel and updates public context and font scale without remounting', async () => {
  const fixture = mount();
  fixture.connect({} as MessageEventSource);
  expect(fixture.port.start).not.toHaveBeenCalled();
  fixture.connect();
  for (const scale of [1, 1.45, 0.95, undefined, -1]) {
    fixture.context({ interfaceFontScale: scale, hosts: [{ id: 'h', name: 'host' }] });
    await nextTick();
    expect(document.documentElement.style.getPropertyValue('--interface-font-scale')).toBe(
      String(scale && scale > 0 ? scale : 1),
    );
    expect(document.querySelector('#app')?.textContent).toBe('h:1:true');
  }
  fixture.context({}, false);
  await nextTick();
  expect(document.querySelector('#app')?.textContent).toBe('h:0:false');
  expect(fixture.rendered).toHaveBeenCalledOnce();
});

it('updates the settings revision without hiding or remounting the plugin', async () => {
  const fixture = mount();
  fixture.connect();
  fixture.context({ settingsRevision: 0 });
  fixture.context({ settingsRevision: 1 });
  await nextTick();
  expect(usePlatformContext().settingsRevision).toBe(1);
  expect(usePluginVisibility().value).toBe(true);
  expect(fixture.rendered).toHaveBeenCalledOnce();
});
it('does not generate business queries from unchanged metadata snapshots', async () => {
  const fixture = mount();
  fixture.connect();
  for (let i = 0; i < 4; i++) {
    fixture.context({
      hosts: [{ id: 'h', name: 'host' }],
      connections: { h: { hostId: 'h', state: 'connected', error: null } },
    });
    await nextTick();
  }
  expect(fixture.sent.filter((packet) => packet.kind === 'request')).toHaveLength(0);
});
it('serializes reactive nested JSON and resolves only the matching response', async () => {
  const fixture = mount();
  fixture.connect();
  fixture.context();
  const input = reactive({ target: { kind: 'host' }, sections: ['one', 'two'] });
  const pending = request<{ value: number }>('invoke', { action: 'inspect', input });
  const packet = fixture.sent.at(-1)!;
  expect(packet.args).toEqual({
    action: 'inspect',
    input: { target: { kind: 'host' }, sections: ['one', 'two'] },
  });
  fixture.port.onmessage!({ data: { kind: 'response', id: 999, result: 'forged' } });
  fixture.port.onmessage!({ data: { kind: 'response', id: packet.id, result: { value: 42 } } });
  await expect(pending).resolves.toEqual({ value: 42 });
});
it('rejects cycles and oversized messages before the channel and bounds outstanding requests', async () => {
  const fixture = mount();
  fixture.connect();
  fixture.context();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await expect(request('invoke', cycle)).rejects.toBeDefined();
  await expect(request('invoke', { text: 'x'.repeat(1024 * 1024) })).rejects.toThrow('超过');
  const tasks = Array.from({ length: 32 }, () => request('invoke', { action: 'held' }));
  const settled = Promise.allSettled(tasks);
  await expect(request('invoke', { action: 'overflow' })).rejects.toThrow('请求过多');
  window.dispatchEvent(new Event('pagehide'));
  expect((await settled).every((value) => value.status === 'rejected')).toBe(true);
  expect(fixture.port.close).toHaveBeenCalledOnce();
});
it('does not provide a native IPC fallback and times out a missing parent response', async () => {
  vi.useFakeTimers();
  const fixture = mount();
  fixture.connect();
  fixture.context();
  const native = vi.fn();
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: native });
  const pending = request('ai_execute', { input: { command: 'untrusted' } });
  const outcome = expect(pending).rejects.toThrow('平台请求超时');
  await vi.advanceTimersByTimeAsync(180000);
  await outcome;
  expect(native).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
