import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia } from 'pinia';
import PluginLog from './PluginLog.vue';
import { pluginsApi } from '../services/plugins';
let app: App, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('decodes split UTF-8 log bytes, renders inert text, bounds cache and sends pause/stop through capability API', async () => {
  vi.useFakeTimers();
  let events: unknown[] = [];
  const cap = vi.spyOn(pluginsApi, 'capability').mockImplementation(async (_id, request) => {
    const result = request.operation.kind === 'log_poll' ? { events } : null;
    events = [];
    return { requestId: request.requestId, result, error: null };
  });
  const bytes = new TextEncoder().encode('中<img onerror=alert(1)>\n');
  const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
  events = [
    { type: 'data', dataBase64: b64(bytes.slice(0, 2)) },
    { type: 'data', dataBase64: b64(bytes.slice(2)) },
  ];
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(PluginLog, { pluginId: 'dev.example', resource: 'opaque-log' }).use(
    createPinia(),
  );
  app.mount(root);
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
  expect(root.querySelector('pre')!.textContent).toContain('中<img onerror=alert(1)>');
  expect(root.querySelector('img')).toBeNull();
  events = [{ type: 'data', dataBase64: btoa('x'.repeat(65537)) }];
  await vi.advanceTimersByTimeAsync(500);
  await nextTick();
  expect(root.querySelector('pre')!.textContent!.length).toBe(65536);
  const buttons = root.querySelectorAll('button');
  buttons[0]!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(cap).toHaveBeenLastCalledWith(
    'dev.example',
    expect.objectContaining({
      operation: { kind: 'log_pause', logId: 'opaque-log', paused: true },
    }),
  );
  buttons[1]!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(cap).toHaveBeenLastCalledWith(
    'dev.example',
    expect.objectContaining({ operation: { kind: 'log_stop', logId: 'opaque-log' } }),
  );
});
