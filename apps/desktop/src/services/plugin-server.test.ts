import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia';
import { pluginsApi } from './plugins';
import { pluginInvokeRequest, pluginPlatformRequest } from './plugin-server';
import { usePluginsStore } from '../stores/plugins';
import type { PluginUiPage } from '../types/plugins';
const page: PluginUiPage = {
  id: 'custom',
  title: 'Custom',
  surface: { kind: 'frontend' },
  initialAction: null,
  fields: [],
  actions: [{ id: 'run', label: 'Run', discardDirty: false, enabledWhen: null }],
  log: null,
};
const ok = (result: unknown) => ({ protocolVersion: 1, result, error: null });
const review = () => ({
  protocolVersion: 1,
  result: {
    id: 'approval',
    continuation: 'frozen-future',
    hostId: 'host',
    pluginName: 'Third party',
    pluginVersion: '1.0.0',
    description: 'ops@host:22\nexact command',
  },
  error: { code: 'PLUGIN_CONFIRMATION_REQUIRED', message: 'confirm' },
});
beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  vi.spyOn(pluginsApi, 'approve').mockResolvedValue();
});
afterEach(() => {
  disposePinia(getActivePinia()!);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.each([true, false])(
  'resumes the original action once, without replay, approval=%s',
  async (accepted) => {
    const call = vi.spyOn(pluginsApi, 'call').mockResolvedValue(review());
    const resume = vi.spyOn(pluginsApi, 'continue').mockResolvedValue(ok({ cancelled: !accepted }));
    const ask = vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(accepted);
    const job = pluginInvokeRequest(
      'resume-' + accepted,
      page,
      'run',
      { hostId: 'host' },
      () => true,
      'page-owner',
    );
    await vi.runAllTimersAsync();
    expect(await job).toEqual({ cancelled: !accepted });
    expect(call).toHaveBeenCalledExactlyOnceWith(
      'resume-' + accepted,
      { action: 'run', input: { hostId: 'host' } },
      'page-owner',
    );
    expect(ask.mock.calls[0]?.[1]).toContain('exact command');
    expect(pluginsApi.approve).toHaveBeenCalledWith('approval', accepted);
    expect(resume).toHaveBeenCalledExactlyOnceWith(
      'resume-' + accepted,
      'frozen-future',
      'page-owner',
      !accepted,
    );
  },
);
it('freezes structured input before waiting in the queue', async () => {
  const call = vi.spyOn(pluginsApi, 'call').mockResolvedValue(ok(null));
  const input = { target: { id: 'original' } };
  const job = pluginInvokeRequest('frozen', page, 'run', input);
  input.target.id = 'changed';
  await vi.runAllTimersAsync();
  await job;
  expect(call.mock.calls[0]?.[1]).toEqual({ action: 'run', input: { target: { id: 'original' } } });
});
it('declines a late hidden approval and lets the original future clean up', async () => {
  let active = true;
  vi.spyOn(pluginsApi, 'call').mockImplementation(async () => {
    active = false;
    return review();
  });
  const ask = vi.spyOn(usePluginsStore(), 'ask');
  const resume = vi.spyOn(pluginsApi, 'continue').mockResolvedValue(ok({ partial: true }));
  const job = pluginInvokeRequest('hidden', page, 'run', {}, () => active, 'owner');
  await vi.runAllTimersAsync();
  expect(await job).toEqual({ partial: true });
  expect(ask).not.toHaveBeenCalled();
  expect(resume).toHaveBeenCalledWith('hidden', 'frozen-future', 'owner', true);
});
it('rejects queued requests from an invalidated package before native dispatch', async () => {
  const call = vi.spyOn(pluginsApi, 'call').mockResolvedValue(ok(null));
  const cap = vi.spyOn(pluginsApi, 'capability');
  const a = expect(pluginInvokeRequest('stale', page, 'run', {})).rejects.toMatchObject({
    code: 'PLUGIN_CANCELLED',
  });
  const b = expect(
    pluginPlatformRequest('stale', { kind: 'hosts' }, () => true),
  ).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
  usePluginsStore().clearPlugin('stale');
  await vi.runAllTimersAsync();
  await Promise.all([a, b]);
  expect(call).not.toHaveBeenCalled();
  expect(cap).not.toHaveBeenCalled();
});
it('reassembles split UTF-8 and closes only the owned result', async () => {
  const expected = { text: '中文'.repeat(20000) },
    bytes = new TextEncoder().encode(JSON.stringify(expected));
  vi.spyOn(pluginsApi, 'call').mockResolvedValue(
    ok({
      __pluginResult: {
        id: 'result',
        bytes: bytes.length,
        chunks: Math.ceil(bytes.length / 32768),
      },
    }),
  );
  const cap = vi.spyOn(pluginsApi, 'capability').mockImplementation(async (_id, request) => {
    const r = request.operation.request;
    return {
      requestId: request.requestId,
      error: null,
      result:
        r.kind === 'result_read'
          ? {
              chunk: r.chunk,
              dataBase64: btoa(
                String.fromCharCode(...bytes.slice(r.chunk * 32768, (r.chunk + 1) * 32768)),
              ),
            }
          : null,
    };
  });
  const job = pluginInvokeRequest('chunks', page, 'run', {}, () => true, 'owner');
  await vi.runAllTimersAsync();
  expect(await job).toEqual(expected);
  expect(cap.mock.calls.at(-1)?.slice(1)).toEqual([
    expect.objectContaining({
      operation: {
        kind: 'platform',
        bindings: [],
        request: { kind: 'result_close', resultId: 'result' },
      },
    }),
    'owner',
  ]);
});
it('preserves both read and cleanup failures', async () => {
  vi.spyOn(pluginsApi, 'call').mockResolvedValue(
    ok({ __pluginResult: { id: 'broken', bytes: 40000, chunks: 2 } }),
  );
  vi.spyOn(pluginsApi, 'capability').mockImplementation(async (_id, req) => ({
    requestId: req.requestId,
    result: null,
    error: { code: 'FAILED', message: req.operation.request.kind },
  }));
  const checked = expect(pluginInvokeRequest('broken', page, 'run', {})).rejects.toMatchObject({
    errors: [{ message: 'result_read' }, { message: 'result_close' }],
  });
  await vi.runAllTimersAsync();
  await checked;
});
it.each([0, 1048577])('rejects an unbounded result descriptor: %s', async (bytes) => {
  vi.spyOn(pluginsApi, 'call').mockResolvedValue(
    ok({ __pluginResult: { id: 'invalid', bytes, chunks: Math.ceil(bytes / 32768) } }),
  );
  const cap = vi.spyOn(pluginsApi, 'capability');
  const checked = expect(pluginInvokeRequest('invalid-' + bytes, page, 'run', {})).rejects.toThrow(
    '描述无效',
  );
  await vi.runAllTimersAsync();
  await checked;
  expect(cap).not.toHaveBeenCalled();
});
