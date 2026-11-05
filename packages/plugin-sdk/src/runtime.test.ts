import { afterEach, expect, it, vi } from 'vitest';
import { h, nextTick, reactive } from 'vue';
import { mountPlugin } from './runtime';
import { request } from './transport';
import ResourceView from './ui/ResourceView.vue';
import { hostInput } from './types/hosts';
import { useModelsStore } from './stores/models';

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('preserves a selected model on unchanged context but clears a removed model instead of showing a blank invalid selection', async () => {
  const port = {
    onmessage: null as ((event: { data: Record<string, unknown> }) => void) | null,
    start() {},
    close() {},
    postMessage() {},
  };
  let models!: ReturnType<typeof useModelsStore>;
  document.body.innerHTML = '<div id="app"></div>';
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  mountPlugin({
    setup() {
      models = useModelsStore();
      return () => h('p', models.selectedId || 'none');
    },
  });
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      data: { kind: 'serverdeck-sdk-connect' },
      ports: [port as unknown as MessagePort],
    }),
  );
  const context = (ids: string[]) =>
    port.onmessage!({
      data: {
        kind: 'context',
        props: {},
        state: {
          models: ids.map((id) => ({ id })),
          catalog: null,
          hostId: '',
          operations: {},
          files: {},
          theme: 'dark',
          monitorIntervalSecs: 3,
        },
      },
    });
  context(['a']);
  await nextTick();
  expect(models.selectedId).toBe('a');
  context(['a', 'b']);
  models.selectedId = 'b';
  context(['a', 'b']);
  await nextTick();
  expect(models.selectedId).toBe('b');
  context(['a']);
  await nextTick();
  expect(models.selectedId).toBe('');
  expect(document.querySelector('#app')?.textContent).toBe('none');
});

it('does not turn unchanged host snapshots into a repeating server request loop', async () => {
  const calls: string[] = [];
  const host = {
    ...hostInput(),
    id: 'a',
    name: 'Host A',
    hostname: 'a.example',
    createdAt: '',
    updatedAt: '',
  };
  const context = {
    kind: 'context',
    visible: true,
    props: { hostId: 'a' },
    state: {
      models: [],
      catalog: { hosts: [host], groups: [], credentials: [], pendingSecretDeletions: 0 },
      hostId: 'a',
      operations: {
        a: {
          host,
          state: 'connected',
          error: null,
          trust: null,
          session: { id: 'ops-a', hostId: 'a', transportId: 'transport-a', routeHostIds: ['a'] },
        },
      },
      files: {},
      theme: 'dark',
      monitorIntervalSecs: 3,
    },
  };
  const port = {
    onmessage: null as ((event: { data: Record<string, unknown> }) => void) | null,
    start() {},
    close() {},
    postMessage(message: Record<string, unknown>) {
      if (message.kind !== 'request') return;
      const args = message.args as { request?: { kind?: string } };
      calls.push(`${message.method}:${args.request?.kind ?? ''}`);
      queueMicrotask(() => {
        port.onmessage?.({
          data: {
            kind: 'response',
            id: message.id,
            result:
              message.method === 'ops_query'
                ? {
                    success: true,
                    records: [],
                    detail: { dockerInstalled: true, dockerState: 'running' },
                  }
                : [],
          },
        });
        if (calls.length < 40) port.onmessage?.({ data: structuredClone(context) });
      });
    },
  };
  document.body.innerHTML = '<div id="app"></div>';
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  mountPlugin({
    render: () =>
      h(ResourceView, {
        hostId: 'a',
        listRequest: { kind: 'containers' },
        columns: [],
        rowKey: 'ID',
      }),
  });
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      data: { kind: 'serverdeck-sdk-connect' },
      ports: [port as unknown as MessagePort],
    }),
  );
  port.onmessage!({ data: structuredClone(context) });
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
    await nextTick();
  }
  expect(calls.filter((method) => method === 'ops_query:capabilities')).toHaveLength(1);
  expect(calls.filter((method) => method === 'ops_query:containers')).toHaveLength(1);
  expect(calls.length).toBeLessThanOrEqual(3);
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
