import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { pluginsApi } from './plugins';
import { pluginContainerShell, pluginServerRequest, pluginToolRequest } from './plugin-server';
import { usePluginsStore } from '../stores/plugins';
import type { PluginUi, PluginUiPage } from '../types/plugins';
import schema from '../../../../plugins/system/docker/ui.json';
let pinia: Pinia;
const page = schema.pages[0] as PluginUiPage;
beforeEach(() => {
  vi.useFakeTimers();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  disposePinia(pinia);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('requires the frozen native review even when a package sends its own confirmed flag and cancels unused tickets', async () => {
  const toolPage = { ...page, surface: { kind: 'tool', tool: 'assistant' } } as PluginUiPage;
  vi.spyOn(pluginsApi, 'toolStage').mockResolvedValue({
    inputId: 'reviewed',
    operation: 'ai_execute',
    review: {
      title: 'Actual target',
      message: 'Actual command',
      confirmationText: 'approve target',
    },
  });
  const ask = vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(false);
  const abort = vi.spyOn(pluginsApi, 'toolAbortInput').mockResolvedValue();
  const call = vi.spyOn(pluginsApi, 'call');
  const check = expect(
    pluginToolRequest(
      'review-test',
      'ai_execute',
      { input: { confirmed: true } },
      toolPage,
      undefined,
      true,
    ),
  ).rejects.toMatchObject({ code: 'PLUGIN_USER_CANCELLED' });
  await vi.runAllTimersAsync();
  await check;
  expect(ask).toHaveBeenCalledWith('Actual target', 'Actual command', 'approve target');
  expect(abort).toHaveBeenCalledWith('review-test', 'reviewed');
  expect(call).not.toHaveBeenCalled();
});
it('passes typed requests through WASM and requires host approval before retrying a mutation', async () => {
  const call = vi
    .spyOn(pluginsApi, 'call')
    .mockResolvedValueOnce({
      protocolVersion: 1,
      result: {
        id: 'approval',
        hostId: 'host',
        pluginName: 'Docker',
        pluginVersion: '1.0.0',
        description: 'stop exact container',
      },
      error: { code: 'PLUGIN_CONFIRMATION_REQUIRED', message: 'confirm' },
    })
    .mockResolvedValueOnce({ protocolVersion: 1, result: { success: true }, error: null });
  const approve = vi.spyOn(pluginsApi, 'approve').mockResolvedValue();
  const ask = vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(true);
  const request = {
    kind: 'container_action' as const,
    id: 'abc123',
    action: 'stop' as const,
    confirmed: true,
  };
  const job = pluginServerRequest('mutation-test', { kind: 'system_query', request }, page);
  await vi.runAllTimersAsync();
  expect(await job).toEqual({ success: true });
  expect(ask).toHaveBeenCalledOnce();
  expect(approve).toHaveBeenCalledWith('approval', true);
  expect(call).toHaveBeenCalledTimes(2);
  const payload = call.mock.calls[0]![1] as { action: string; values: { request: string } };
  expect(payload.action).toBe('bridge');
  expect(JSON.parse(payload.values.request).request).toEqual({
    kind: 'container_action',
    id: 'abc123',
    action: 'stop',
  });
});
it('reassembles UTF-8 result chunks without truncation and releases the host resource', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ text: '中文'.repeat(20_000) }));
  vi.spyOn(pluginsApi, 'call').mockResolvedValue({
    protocolVersion: 1,
    result: {
      __pluginResult: {
        id: 'result',
        bytes: bytes.length,
        chunks: Math.ceil(bytes.length / 32768),
      },
    },
    error: null,
  });
  const capability = vi.spyOn(pluginsApi, 'capability').mockImplementation(async (_id, request) => {
    const operation = request.operation;
    return {
      requestId: request.requestId,
      error: null,
      result:
        operation.kind === 'result_read'
          ? {
              chunk: operation.chunk,
              dataBase64: btoa(
                String.fromCharCode(
                  ...bytes.slice(operation.chunk * 32768, (operation.chunk + 1) * 32768),
                ),
              ),
            }
          : null,
    };
  });
  const job = pluginServerRequest('chunks-test', { kind: 'system_feedback' }, page);
  await vi.runAllTimersAsync();
  expect(await job).toEqual({ text: '中文'.repeat(20_000) });
  expect(capability.mock.calls.at(-1)?.[1].operation).toEqual({
    kind: 'result_close',
    resultId: 'result',
  });
});
it('keeps read and cleanup failure causes together', async () => {
  vi.spyOn(pluginsApi, 'call').mockResolvedValue({
    protocolVersion: 1,
    result: { __pluginResult: { id: 'broken', bytes: 40000, chunks: 2 } },
    error: null,
  });
  vi.spyOn(pluginsApi, 'capability').mockResolvedValue({
    requestId: 'test',
    result: null,
    error: { code: 'BROKEN', message: 'failed chunk or cleanup' },
  });
  const check = expect(
    pluginServerRequest('failed-chunks', { kind: 'system_feedback' }, page),
  ).rejects.toBeInstanceOf(AggregateError);
  await vi.runAllTimersAsync();
  await check;
});
it('never executes a queued old-context request after a connection or plugin change', async () => {
  let release!: (reply: { protocolVersion: number; result: null; error: null }) => void;
  const call = vi.spyOn(pluginsApi, 'call').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = pluginServerRequest('context-test', { kind: 'system_feedback' }, page);
  const firstCheck = expect(first).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
  await Promise.resolve();
  await Promise.resolve();
  const second = expect(
    pluginServerRequest('context-test', { kind: 'system_feedback' }, page),
  ).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
  usePluginsStore().clearPlugin('context-test');
  release({ protocolVersion: 1, result: null, error: null });
  await vi.runAllTimersAsync();
  await firstCheck;
  await second;
  expect(call).toHaveBeenCalledOnce();
});
it('freezes confirmed tool inputs before queuing and gives WASM only an opaque typed ticket', async () => {
  const toolPage = { ...page, surface: { kind: 'tool', tool: 'assistant' } } as PluginUiPage;
  const stage = vi
    .spyOn(pluginsApi, 'toolStage')
    .mockResolvedValue({ inputId: 'immutable', operation: 'ai_execute' });
  const call = vi
    .spyOn(pluginsApi, 'call')
    .mockResolvedValue({ protocolVersion: 1, result: { id: 'job' }, error: null });
  const args = { input: { confirmed: true, command: 'exact approved command' } };
  const job = pluginToolRequest('upload-any-id', 'ai_execute', args, toolPage);
  args.input.command = 'changed after confirmation';
  await vi.runAllTimersAsync();
  expect(await job).toEqual({ id: 'job' });
  expect(stage).toHaveBeenCalledWith('upload-any-id', {
    operation: 'ai_execute',
    args: { input: { confirmed: true, command: 'exact approved command' } },
  });
  const payload = call.mock.calls[0]![1] as { values: { request: string } };
  expect(JSON.parse(payload.values.request)).toEqual({
    kind: 'tool_invoke',
    inputId: 'immutable',
    operation: 'ai_execute',
  });
  expect(payload.values.request).not.toContain('approved command');
});
it('aborts exactly the staged AI input and allows the next request without cancelling the VM', async () => {
  const toolPage = { ...page, surface: { kind: 'tool', tool: 'assistant' } } as PluginUiPage;
  let staged!: (ticket: { inputId: string; operation: 'ai_prepare' }) => void;
  vi.spyOn(pluginsApi, 'toolStage')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          staged = resolve;
        }),
    )
    .mockResolvedValue({ inputId: 'next', operation: 'ai_prepare' });
  const abort = vi.spyOn(pluginsApi, 'toolAbortInput').mockResolvedValue();
  const cancel = vi.spyOn(pluginsApi, 'cancel');
  const call = vi
    .spyOn(pluginsApi, 'call')
    .mockResolvedValue({ protocolVersion: 1, result: { id: 'next-preview' }, error: null });
  const controller = new AbortController();
  const check = expect(
    pluginToolRequest('cancel-ai', 'ai_prepare', { input: {} }, toolPage, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(65);
  controller.abort();
  staged({ inputId: 'cancelled-ticket', operation: 'ai_prepare' });
  await vi.runAllTimersAsync();
  await check;
  expect(abort).toHaveBeenCalledExactlyOnceWith('cancel-ai', 'cancelled-ticket');
  expect(call).not.toHaveBeenCalled();
  const next = pluginToolRequest('cancel-ai', 'ai_prepare', { input: {} }, toolPage);
  await vi.runAllTimersAsync();
  expect(await next).toEqual({ id: 'next-preview' });
  expect(cancel).not.toHaveBeenCalled();
});
it('revokes an active AI ticket and rejects a late answer after cancellation', async () => {
  const toolPage = { ...page, surface: { kind: 'tool', tool: 'assistant' } } as PluginUiPage;
  vi.spyOn(pluginsApi, 'toolStage').mockResolvedValue({
    inputId: 'in-flight',
    operation: 'ai_send',
  });
  let finish!: (reply: { protocolVersion: number; result: unknown; error: null }) => void;
  vi.spyOn(pluginsApi, 'call').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const abort = vi.spyOn(pluginsApi, 'toolAbortInput').mockResolvedValue();
  const controller = new AbortController();
  const check = expect(
    pluginToolRequest(
      'late-ai',
      'ai_send',
      { id: 'preview', confirmed: true },
      toolPage,
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(65);
  controller.abort();
  expect(abort).toHaveBeenCalledWith('late-ai', 'in-flight');
  finish({ protocolVersion: 1, result: { answer: 'late' }, error: null });
  await vi.runAllTimersAsync();
  await check;
});
it('retains the request failure and an unexpected abort cleanup failure together', async () => {
  const toolPage = { ...page, surface: { kind: 'tool', tool: 'assistant' } } as PluginUiPage;
  vi.spyOn(pluginsApi, 'toolStage').mockResolvedValue({
    inputId: 'cleanup-failure',
    operation: 'ai_send',
  });
  let reject!: (cause: unknown) => void;
  vi.spyOn(pluginsApi, 'call').mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const failure = { code: 'MODEL_ERROR', message: 'request failed' },
    cleanup = { code: 'IO', message: 'cleanup failed' };
  vi.spyOn(pluginsApi, 'toolAbortInput').mockRejectedValue(cleanup);
  const controller = new AbortController();
  const check = expect(
    pluginToolRequest(
      'cleanup-ai',
      'ai_send',
      { id: 'preview', confirmed: true },
      toolPage,
      controller.signal,
    ),
  ).rejects.toMatchObject({ errors: [failure, cleanup], cause: failure });
  await vi.advanceTimersByTimeAsync(65);
  controller.abort();
  reject(failure);
  await vi.runAllTimersAsync();
  await check;
});
it('obtains a fresh WASM shell ticket and binds the trusted terminal launch to its exact host and target', async () => {
  vi.spyOn(usePluginsStore(), 'schema').mockResolvedValue(schema as PluginUi);
  const call = vi
    .spyOn(pluginsApi, 'call')
    .mockResolvedValue({ protocolVersion: 1, result: { shellTicket: 'one-use' }, error: null });
  const terminal = vi.spyOn(pluginsApi, 'terminalOpen').mockResolvedValue({
    id: 'terminal',
    hostId: 'host',
    transportId: 'transport',
    routeHostIds: ['host'],
  });
  const shell = { id: 'abc123', bash: false, confirmed: true, pluginId: 'shell-test' };
  const receive = vi.fn();
  const size = { cols: 80, rows: 24 };
  const job = pluginContainerShell('host', size, shell, receive);
  await vi.runAllTimersAsync();
  await job;
  expect(call).toHaveBeenCalledOnce();
  expect(terminal).toHaveBeenCalledWith('shell-test', 'one-use', 'host', shell, size, receive);
});
