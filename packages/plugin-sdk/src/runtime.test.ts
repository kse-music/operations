import { afterEach, expect, it, vi } from 'vitest';
import { h, reactive } from 'vue';
import { mountPlugin } from './runtime';
import { request } from './transport';

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('serializes reactive requests and releases failed or closed event streams so they can be reopened', async () => {
  let failOpen = true;
  const calls: Record<string, unknown>[] = [];
  const port = {
    onmessage: null as ((event: { data: Record<string, unknown> }) => void) | null,
    start() {},
    close() {},
    postMessage(message: Record<string, unknown>) {
      // Mirrors the browser boundary: reactive proxies cannot be cloned.
      const cloned = structuredClone(message);
      if (cloned.kind !== 'request') return;
      calls.push(cloned);
      queueMicrotask(() =>
        port.onmessage?.({
          data: {
            kind: 'response',
            id: cloned.id,
            ...(cloned.method === 'ops_log_open' && failOpen
              ? { error: { code: 'UNAVAILABLE', message: 'fixture unavailable' } }
              : { result: cloned.method === 'ops_log_open' ? { id: `log-${cloned.id}` } : null }),
          },
        }),
      );
    },
  };
  document.body.innerHTML = '<div id="app"></div>';
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  mountPlugin({ render: () => h('p', 'SDK fixture') });
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      data: { kind: 'serverdeck-sdk-connect' },
      ports: [port as unknown as MessagePort],
    }),
  );
  port.onmessage!({
    data: {
      kind: 'context',
      props: {},
      state: {
        models: [],
        catalog: null,
        hostId: '',
        operations: {},
        files: {},
        theme: 'dark',
        monitorIntervalSecs: 3,
      },
    },
  });
  const input = reactive({ kind: 'file', path: '/var/log/qa' });
  for (let i = 0; i < 80; i++) {
    await expect(
      request('ops_log_open', { input, events: { onmessage: vi.fn() } }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  }
  failOpen = false;
  for (let i = 0; i < 80; i++) {
    const result = await request<{ id: string }>('ops_log_open', {
      input,
      events: { onmessage: vi.fn() },
    });
    await request('ops_log_close', { id: result.id });
  }
  expect(calls).toHaveLength(240);
  expect(calls[0]).toMatchObject({ args: { input: { path: '/var/log/qa' } } });
});
