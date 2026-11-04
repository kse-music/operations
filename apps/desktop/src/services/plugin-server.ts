import { usePluginsStore } from '../stores/plugins';
import { pluginsApi } from './plugins';
import { actionPayload } from './plugin-ui';
import type { PluginApproval, PluginCapability, PluginUiPage } from '../types/plugins';
import { useHostsStore } from '../stores/hosts';

interface Queue {
  tail: Promise<unknown>;
  count: number;
  last: number;
}
const queues = new Map<string, Queue>();
async function queued<T>(id: string, work: () => Promise<T>): Promise<T> {
  let queue = queues.get(id);
  if (!queue) {
    queue = { tail: Promise.resolve(), count: 0, last: 0 };
    queues.set(id, queue);
  }
  if (queue.count >= 24) throw new Error('插件请求正忙，请稍后重试');
  queue.count++;
  const current = queue;
  const job = current.tail.then(async () => {
    const wait = Math.max(0, 65 - (Date.now() - current.last));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    current.last = Date.now();
    return work();
  });
  current.tail = job.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await job;
  } finally {
    current.last = Date.now();
    if (--current.count === 0)
      setTimeout(() => {
        if (queues.get(id) === current && current.count === 0 && Date.now() - current.last >= 65)
          queues.delete(id);
      }, 70);
  }
}

async function expanded(id: string, value: unknown): Promise<unknown> {
  if (!value || typeof value !== 'object' || !('__pluginResult' in value)) return value;
  const resource = (value as { __pluginResult: { id: string; bytes: number; chunks: number } })
    .__pluginResult;
  if (
    !resource ||
    typeof resource.id !== 'string' ||
    resource.id.length > 80 ||
    !Number.isInteger(resource.bytes) ||
    resource.bytes < 1 ||
    resource.bytes > 4 * 1024 * 1024 ||
    resource.chunks !== Math.ceil(resource.bytes / 32768)
  )
    throw new Error('插件结果描述无效');
  const bytes = new Uint8Array(resource.bytes);
  let position = 0;
  let failure: unknown, result: unknown;
  let failed = false;
  try {
    for (let chunk = 0; chunk < resource.chunks; chunk++) {
      await new Promise((resolve) => setTimeout(resolve, 65));
      const reply = await pluginsApi.capability(id, {
        apiVersion: 1,
        requestId: crypto.randomUUID(),
        operation: { kind: 'result_read', resultId: resource.id, chunk },
      });
      if (reply.error) throw reply.error;
      const data = reply.result as { chunk: number; dataBase64: string };
      if (data.chunk !== chunk || typeof data.dataBase64 !== 'string')
        throw new Error('插件结果分块无效');
      const decoded = Uint8Array.from(atob(data.dataBase64), (c) => c.charCodeAt(0));
      if (position + decoded.length > bytes.length) throw new Error('插件结果超过声明大小');
      bytes.set(decoded, position);
      position += decoded.length;
    }
    if (position !== bytes.length) throw new Error('插件结果不完整');
    result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    failed = true;
    failure = cause;
  }
  try {
    const closed = await pluginsApi.capability(id, {
      apiVersion: 1,
      requestId: crypto.randomUUID(),
      operation: { kind: 'result_close', resultId: resource.id },
    });
    if (
      closed.error &&
      !['PLUGIN_CANCELLED', 'PLUGIN_PERMISSION_DENIED', 'NOT_FOUND'].includes(closed.error.code)
    )
      throw closed.error;
  } catch (cause) {
    if (failed) throw new AggregateError([failure, cause], '插件结果读取与清理失败', { cause });
    throw cause;
  }
  if (failed) throw failure;
  return result;
}

async function surfaceRequest<T>(
  id: string,
  operation: PluginCapability | (() => Promise<PluginCapability>),
  page?: PluginUiPage,
  signal?: AbortSignal,
): Promise<T> {
  const plugins = usePluginsStore();
  const version = plugins.contextVersion(id);
  const verifyContext = () => {
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    if (plugins.contextVersion(id) !== version)
      throw { code: 'PLUGIN_CANCELLED', message: '插件主机或连接已变化，请重新操作' };
  };
  return queued(id, async () => {
    verifyContext();
    const selected = page ?? (await plugins.schema(id)).pages.find((page) => page.surface);
    if (!selected?.surface) throw new Error('插件没有标准视图');
    // Old host UI confirmations are local intent, never part of a guest capability.
    const encoded = JSON.parse(
      JSON.stringify(typeof operation === 'function' ? await operation() : operation),
    );
    if (encoded.kind === 'system_query') delete encoded.request.confirmed;
    const payload = actionPayload(selected, 'bridge', { request: JSON.stringify(encoded) });
    verifyContext();
    let reply = await pluginsApi.call(id, payload);
    if (reply.error?.code === 'PLUGIN_CONFIRMATION_REQUIRED') {
      const approval = reply.result as PluginApproval;
      const target = useHostsStore().catalog?.hosts.find((host) => host.id === approval.hostId);
      const accepted = await plugins.ask(
        '插件操作需要单独确认',
        `${approval.pluginName} ${approval.pluginVersion}\n${target ? `${target.username}@${target.hostname}:${target.port}` : approval.hostId}\n${approval.description}\n\n本次确认 60 秒内有效。`,
      );
      await pluginsApi.approve(approval.id, accepted);
      if (!accepted) throw { code: 'PLUGIN_USER_CANCELLED', message: '操作已取消' };
      verifyContext();
      reply = await pluginsApi.call(id, payload);
    }
    if (reply.error) throw reply.error;
    const result = await expanded(id, reply.result);
    verifyContext();
    return result as T;
  });
}
export function pluginServerRequest<T>(
  id: string,
  operation: PluginCapability,
  page?: PluginUiPage,
): Promise<T> {
  return surfaceRequest<T>(id, operation, page);
}
export function pluginToolRequest<T>(
  id: string,
  operation: import('../types/plugins').PluginToolOperation,
  args: Record<string, unknown>,
  page: PluginUiPage,
  signal?: AbortSignal,
): Promise<T> {
  const frozen = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  let inputId = '',
    cancelError: unknown,
    cancelling: Promise<void> | undefined;
  const abort = () => {
    if (inputId && !cancelling)
      cancelling = pluginsApi.toolAbortInput(id, inputId).catch((error) => {
        if (!(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['NOT_FOUND', 'PLUGIN_PERMISSION_DENIED', 'PLUGIN_CANCELLED'].includes(String(error.code))
        ))
          cancelError = error;
      });
  };
  signal?.addEventListener('abort', abort, { once: true });
  const job = surfaceRequest<T>(
    id,
    async () => {
      const ticket = await pluginsApi.toolStage(id, { operation, args: frozen });
      inputId = ticket.inputId;
      if (signal?.aborted) abort();
      if (ticket.operation !== operation) throw new Error('运维工具请求票据类型不匹配');
      return { kind: 'tool_invoke', inputId: ticket.inputId, operation };
    },
    page,
    signal,
  );
  const cleanup = async () => {
    signal?.removeEventListener('abort', abort);
    await cancelling;
  };
  return job.then(
    async (result) => {
      await cleanup();
      if (cancelError) throw cancelError;
      return result;
    },
    async (cause) => {
      await cleanup();
      if (cancelError)
        throw new AggregateError([cause, cancelError], '插件请求和取消清理失败', { cause });
      throw cause;
    },
  );
}

export async function pluginContainerShell(
  hostId: string,
  size: import('../types/terminal').TerminalSize,
  shell: import('../types/ops').ContainerShell,
  receive: (event: import('../types/terminal').TerminalEvent) => void,
): Promise<import('../types/terminal').TerminalSession> {
  if (!shell.pluginId) throw new Error('缺少插件身份');
  const authorization = await pluginServerRequest<{ shellTicket: string }>(shell.pluginId, {
    kind: 'container_shell',
    id: shell.id,
    bash: shell.bash,
  });
  if (typeof authorization?.shellTicket !== 'string') throw new Error('插件未返回有效终端凭证');
  return pluginsApi.terminalOpen(
    shell.pluginId,
    authorization.shellTicket,
    hostId,
    shell,
    size,
    receive,
  );
}
