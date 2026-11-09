import { usePluginsStore } from '../stores/plugins';
import { pluginsApi } from './plugins';
import { actionPayload } from './plugin-ui';
import type { PluginApproval, PluginUiPage } from '../types/plugins';

interface Queue {
  tail: Promise<unknown>;
  count: number;
  last: number;
}
const queues = new Map<string, Queue>();
export async function pluginPlatformRequest<T>(
  id: string,
  request: import('@serverdeck/plugin-sdk/types/platform').PlatformRequest,
  isActive: () => boolean,
  owner = 'default',
): Promise<T> {
  const plugins = usePluginsStore();
  const version = plugins.contextVersion(id);
  return queued(id, async () => {
    if (plugins.contextVersion(id) !== version)
      throw { code: 'PLUGIN_CANCELLED', message: '插件上下文已变化' };
    if (!isActive() && !['stream_stop', 'close_file', 'result_close'].includes(request.kind))
      throw { code: 'PLUGIN_CANCELLED', message: '插件页面已隐藏' };
    const operation = { kind: 'platform' as const, request, bindings: [] };
    const run = () =>
      pluginsApi.capability(
        id,
        { apiVersion: 1, requestId: crypto.randomUUID(), operation },
        owner,
      );
    let reply = await run();
    if (reply.error?.code === 'PLUGIN_CONFIRMATION_REQUIRED') {
      const approval = (reply.result as { confirmationRequired: PluginApproval })
        .confirmationRequired;
      if (!isActive() || plugins.contextVersion(id) !== version)
        throw { code: 'PLUGIN_CANCELLED', message: '页面已隐藏或上下文已变化' };
      const accepted = await plugins.ask(
        '插件操作需要单独确认',
        `${approval.pluginName} ${approval.pluginVersion}\n${approval.hostId}\n${approval.description}`,
        undefined,
        owner,
      );
      const confirmed = accepted && isActive() && plugins.contextVersion(id) === version;
      await pluginsApi.approve(approval.id, confirmed);
      if (!confirmed) throw { code: 'PLUGIN_USER_CANCELLED', message: '操作已取消' };
      reply = await run();
    }
    if (reply.error) throw reply.error;
    if (plugins.contextVersion(id) !== version)
      throw { code: 'PLUGIN_CANCELLED', message: '插件上下文已变化' };
    return (await expanded(id, reply.result, owner)) as T;
  });
}
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

async function expanded(id: string, value: unknown, owner = 'default'): Promise<unknown> {
  if (!value || typeof value !== 'object' || !('__pluginResult' in value)) return value;
  const resource = (value as { __pluginResult: { id: string; bytes: number; chunks: number } })
    .__pluginResult;
  if (
    !resource ||
    typeof resource.id !== 'string' ||
    resource.id.length > 80 ||
    !Number.isInteger(resource.bytes) ||
    resource.bytes < 1 ||
    resource.bytes > 1024 * 1024 ||
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
      const reply = await pluginsApi.capability(
        id,
        {
          apiVersion: 1,
          requestId: crypto.randomUUID(),
          operation: {
            kind: 'platform',
            bindings: [],
            request: { kind: 'result_read', resultId: resource.id, chunk },
          },
        },
        owner,
      );
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
    const closed = await pluginsApi.capability(
      id,
      {
        apiVersion: 1,
        requestId: crypto.randomUUID(),
        operation: {
          kind: 'platform',
          bindings: [],
          request: { kind: 'result_close', resultId: resource.id },
        },
      },
      owner,
    );
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

/** The same bounded Wasm and approval path for a package-owned custom UI. */
export async function pluginInvokeRequest<T>(
  id: string,
  page: PluginUiPage,
  action: string,
  values: unknown,
  isActive: () => boolean = () => true,
  owner = 'default',
): Promise<T> {
  const plugins = usePluginsStore();
  const version = plugins.contextVersion(id);
  const payload = actionPayload(page, action, values);
  const verify = () => {
    if (plugins.contextVersion(id) !== version)
      throw { code: 'PLUGIN_CANCELLED', message: '插件上下文已变化' };
  };
  return queued(id, async () => {
    verify();
    if (!isActive()) throw { code: 'PLUGIN_CANCELLED', message: '插件页面已隐藏或关闭' };
    let reply = await pluginsApi.call(id, payload, owner);
    while (reply.error?.code === 'PLUGIN_CONFIRMATION_REQUIRED') {
      const approval = reply.result as PluginApproval & { continuation: string };
      if (!isActive() || typeof approval.continuation !== 'string') {
        if (typeof approval.continuation !== 'string')
          throw { code: 'PLUGIN_CANCELLED', message: '审批续接无效' };
        await pluginsApi.approve(approval.id, false);
        reply = await pluginsApi.continue(id, approval.continuation, owner, true);
        continue;
      }
      const accepted = await plugins.ask(
        '插件操作需要单独确认',
        `${approval.pluginName} ${approval.pluginVersion}\n${approval.hostId}\n${approval.description}`,
        undefined,
        owner,
      );
      const confirmed = accepted && isActive();
      await pluginsApi.approve(approval.id, confirmed);
      verify();
      reply = await pluginsApi.continue(id, approval.continuation, owner, !confirmed);
    }
    if (reply.error) throw reply.error;
    const value = await expanded(id, reply.result, owner);
    verify();
    return value as T;
  });
}
