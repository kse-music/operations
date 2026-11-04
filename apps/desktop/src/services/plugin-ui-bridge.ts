import { watch } from 'vue';
import { useHostsStore } from '../stores/hosts';
import { useOpsStore } from '../stores/ops';
import { useFilesStore } from '../stores/files';
import { useModelsStore } from '../stores/models';
import { useWorkspaceStore } from '../stores/workspace';
import { useApplicationStore } from '../stores/application';
import { useNotificationsStore } from '../stores/notifications';
import { usePluginsStore } from '../stores/plugins';
import { pluginsApi } from './plugins';
import { pluginInvokeRequest, pluginServerRequest, pluginToolRequest } from './plugin-server';
import { clipboardApi } from './clipboard';
import { filesApi } from './files';
import { terminalApi } from './terminal';
import { downloadResult } from './tasks';
import type {
  PluginUiPage,
  PluginToolOperation,
  PluginCapability,
  PluginPermission,
} from '../types/plugins';
import type { LogInput, LogEvent, OpsRequest } from '../types/ops';

const tools: Record<string, { permission: PluginPermission; operations: readonly string[] }> = {
  assistant: {
    permission: 'assistant.use',
    operations: ['ai_resolve_hosts', 'ai_prepare', 'ai_send', 'ai_execute', 'ai_cancel'],
  },
  batch: {
    permission: 'batch.run',
    operations: ['batch_start', 'batch_list', 'batch_cancel', 'batch_retry_file'],
  },
  automation: {
    permission: 'automation.manage',
    operations: [
      'automation_catalog',
      'automation_prepare',
      'automation_entry_save',
      'automation_entry_delete',
      'automation_group_save',
      'automation_group_delete',
      'automation_start',
      'automation_run',
      'automation_history',
      'automation_cancel',
      'automation_approve',
      'automation_schedule_save',
      'automation_schedule_disable',
      'automation_schedule_delete',
      'automation_status',
      'automation_run_delete',
    ],
  },
  network: {
    permission: 'network.run',
    operations: ['diagnostic_start', 'diagnostic_list', 'diagnostic_cancel'],
  },
};
const denied = () => ({
  code: 'PLUGIN_PERMISSION_DENIED',
  message: '插件没有此公共能力或上下文已失效',
});

export function createPluginUiBridge(input: {
  id: string;
  revision: string;
  page: PluginUiPage;
  hostId: string;
  stream: (id: string, event: unknown) => void;
}) {
  const hosts = useHostsStore(),
    ops = useOpsStore(),
    files = useFilesStore();
  const models = useModelsStore(),
    workspace = useWorkspaceStore(),
    application = useApplicationStore();
  const plugins = usePluginsStore(),
    notifications = useNotificationsStore();
  let disposed = false,
    monitor = '';
  const requests = new Set<AbortController>();
  const streams = new Map<string, { stopped: boolean }>();
  const listeners = new Set<() => void>();
  const leases = new Map<string, string>(),
    originals = new Map<string, string>();
  const ownedConnections = new Set<string>();
  const pickedFiles = new Set<string>();
  const references = new Map<string, string>();
  function opaque(value: string, profile = false): string {
    if (!profile) {
      let token = references.get(value);
      if (!token) {
        token = `sdk-reference-${crypto.randomUUID()}`;
        references.set(value, token);
      }
      return token;
    }
    const key = `profile:${value}`;
    let token = originals.get(key);
    if (!token) {
      token = `sdk-profile-${crypto.randomUUID()}`;
      originals.set(key, token);
      leases.set(token, value);
    }
    return token;
  }
  function publicHost(host: import('../types/hosts').Host): import('../types/hosts').Host {
    const value = JSON.parse(JSON.stringify(host)) as import('../types/hosts').Host;
    if (value.credentialId) value.credentialId = opaque(value.credentialId);
    const proxy = value.ssh.proxy;
    if (proxy?.credentialId) proxy.credentialId = opaque(proxy.credentialId);
    return value;
  }
  function check() {
    const plugin = plugins.installed.find((p) => p.manifest.id === input.id);
    const grant = plugins.grants[input.id];
    if (
      disposed ||
      !plugin?.enabled ||
      plugin.revision !== input.revision ||
      grant?.revision !== input.revision ||
      !grant.permissions.includes('ui.contribute') ||
      !grant.operations.includes('ui.contribute')
    )
      throw denied();
    const surface = input.page.surface;
    if (surface?.kind === 'frontend') return surface;
    const permission =
      surface?.kind === 'tool'
        ? tools[surface.tool]?.permission
        : surface?.kind === 'monitor'
          ? 'metrics.read'
          : surface?.kind === 'operations' && surface.sections.every((s) => s === 'logs')
            ? 'logs.read'
            : 'system.read';
    if (
      !permission ||
      !grant.permissions.includes(permission as PluginPermission) ||
      !grant.operations.includes(permission)
    )
      throw denied();
    return surface;
  }
  function hasAny(...permissions: PluginPermission[]) {
    const grant = plugins.grants[input.id];
    return permissions.some((p) => grant?.permissions.includes(p) && grant.operations.includes(p));
  }
  function knownLeases() {
    const values = new Set<string>();
    for (const connection of Object.values(ops.connections)) {
      if (connection.session) {
        values.add(connection.session.id);
        values.add(connection.session.transportId);
      }
    }
    for (const connection of Object.values(files.connections))
      if (connection.id) values.add(connection.id);
    return values;
  }
  function publicValue(value: unknown, profiles = false): unknown {
    const known = knownLeases();
    const visit = (value: unknown): unknown => {
      if (typeof value === 'string' && known.has(value)) {
        let token = originals.get(value);
        if (!token) {
          token = `sdk-lease-${crypto.randomUUID()}`;
          originals.set(value, token);
          leases.set(token, value);
        }
        return token;
      }
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === 'object') {
        const target = value as Record<string, unknown>;
        const profile =
          profiles &&
          typeof target.hostId === 'string' &&
          typeof target.hostname === 'string' &&
          typeof target.port === 'number' &&
          typeof target.routeSignature === 'string';
        return Object.fromEntries(
          Object.entries(value).map(([key, v]) => [
            key,
            profile && key === 'routeSignature' ? opaque(v as string, true) : visit(v),
          ]),
        );
      }
      return value;
    };
    return visit(JSON.parse(JSON.stringify(value)));
  }
  function restore(value: unknown): unknown {
    if (typeof value === 'string') return leases.get(value) ?? value;
    if (Array.isArray(value)) return value.map(restore);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, restore(v)]));
    return value;
  }
  function snapshot() {
    check();
    const canRead = hasAny(
      'hosts.read',
      'assistant.use',
      'batch.run',
      'automation.manage',
      'network.run',
      'system.read',
      'metrics.read',
      'logs.read',
    );
    return publicValue({
      theme: document.documentElement.dataset.theme ?? 'dark',
      hostId: input.hostId,
      catalog: canRead && hosts.catalog ? snapshotCatalog() : null,
      operations: canRead
        ? Object.fromEntries(
            Object.entries(ops.connections).map(([id, c]) => [
              id,
              { ...c, host: publicHost(c.host) },
            ]),
          )
        : {},
      files: canRead
        ? Object.fromEntries(
            Object.entries(files.connections).map(([id, c]) => [
              id,
              {
                host: publicHost(c.host),
                id: c.id,
                state: c.state,
                error: c.error,
                trust: c.trust,
              },
            ]),
          )
        : {},
      models:
        input.page.surface?.kind === 'tool' && input.page.surface.tool === 'assistant'
          ? models.models
          : [],
      monitorIntervalSecs: application.state?.config.monitorIntervalSecs ?? 3,
    });
  }
  const server = <T>(operation: PluginCapability) => {
    check();
    return pluginServerRequest<T>(input.id, operation, input.page);
  };
  function connectionForSession(id: string) {
    return Object.values(ops.connections).find((c) => c.session?.id === id);
  }
  async function call(method: string, raw: Record<string, unknown>): Promise<unknown> {
    const surface = check();
    const args = restore(raw) as Record<string, unknown>;
    const domain = Object.values(tools).find((tool) => tool.operations.includes(method));
    if (domain) {
      const grant = plugins.grants[input.id];
      if (
        !grant?.permissions.includes(domain.permission) ||
        !grant.operations.includes(domain.permission)
      )
        throw denied();
      if (method === 'ai_cancel') {
        await pluginsApi.toolCancelRequest(input.id, String(args.id));
        return;
      }
      if (method === 'batch_start') {
        const operation = (args.input as { operation?: { kind?: string; source?: string } })
          ?.operation;
        if (operation?.kind === 'file' && (!operation.source || !pickedFiles.has(operation.source)))
          throw denied();
      }
      const controller = new AbortController();
      requests.add(controller);
      try {
        return await pluginToolRequest(
          input.id,
          method as PluginToolOperation,
          args,
          input.page,
          controller.signal,
          true,
        );
      } finally {
        requests.delete(controller);
      }
    }
    switch (method) {
      case 'invoke':
        return pluginInvokeRequest(
          input.id,
          input.page,
          String(args.action),
          args.values as import('../types/plugins').PluginValues,
        );
      case 'capability':
        return server(args.operation as PluginCapability);
      case 'hosts.list':
        if (
          !hasAny(
            'hosts.read',
            'assistant.use',
            'batch.run',
            'automation.manage',
            'network.run',
            'system.read',
            'metrics.read',
            'logs.read',
          )
        )
          throw denied();
        await hosts.load();
        if (hosts.error) throw new Error(hosts.error);
        return snapshotCatalog();
      case 'ai_models':
        if (surface?.kind !== 'tool' || surface.tool !== 'assistant') throw denied();
        await models.refresh();
        if (models.error) throw new Error(models.error);
        return models.models;
      case 'ops_open': {
        if (typeof args.events === 'string' && (args.events.length > 80 || listeners.size >= 32))
          throw { code: 'PLUGIN_LIMIT', message: '插件连接事件流超过限制' };
        if (
          !hasAny(
            'ssh.execute',
            'assistant.use',
            'batch.run',
            'automation.manage',
            'network.run',
            'system.read',
            'metrics.read',
            'logs.read',
          )
        )
          throw denied();
        const host = hosts.catalog?.hosts.find((h) => h.id === args.hostId);
        if (!host) throw denied();
        const existing = ops.connections[host.id]?.session?.id;
        await ops.open(host, false);
        const current = ops.connections[host.id];
        if (!current?.session) throw new Error(current?.error ?? '连接未建立');
        if (existing !== current.session.id) ownedConnections.add(current.session.id);
        if (typeof args.events === 'string') {
          if (listeners.size >= 32)
            throw { code: 'PLUGIN_LIMIT', message: '插件连接事件流超过限制' };
          const stream = args.events;
          const stop = watch(
            () => [current.state, current.trust, current.error],
            () => {
              if (!disposed)
                input.stream(
                  stream,
                  current.trust ?? {
                    type: 'state',
                    state: current.state,
                    code: null,
                    message: current.error,
                  },
                );
              if (['closed', 'failed', 'disconnected', 'cancelled'].includes(current.state))
                queueMicrotask(() => {
                  stop();
                  listeners.delete(stop);
                });
            },
            { deep: true, immediate: true },
          );
          listeners.add(stop);
        }
        return current.session;
      }
      case 'ops_connections':
        if (
          !hasAny(
            'ssh.execute',
            'assistant.use',
            'batch.run',
            'automation.manage',
            'network.run',
            'system.read',
            'metrics.read',
            'logs.read',
          )
        )
          throw denied();
        await ops.sync();
        return Object.values(ops.connections)
          .filter((c) => c.state === 'connected')
          .map((c) => c.session);
      case 'ops_close': {
        if (
          !hasAny(
            'ssh.execute',
            'assistant.use',
            'batch.run',
            'automation.manage',
            'network.run',
            'system.read',
            'metrics.read',
            'logs.read',
          )
        )
          throw denied();
        const c = connectionForSession(String(args.id));
        if (!c) throw denied();
        if (
          !ownedConnections.has(String(args.id)) &&
          !(await plugins.ask(
            '断开共享连接',
            `${c.host.username}@${c.host.hostname}:${c.host.port}\n此连接也可能被其他工作区使用。`,
          ))
        )
          throw denied();
        check();
        await ops.close(c.host.id);
        return;
      }
      case 'connections.fileOpen': {
        if (!hasAny('sftp.read', 'sftp.write', 'batch.run')) throw denied();
        const host = hosts.catalog?.hosts.find((h) => h.id === args.hostId);
        if (!host) throw denied();
        await files.open(host);
        const c = files.connections[host.id];
        if (!c) throw denied();
        return {
          host: publicHost(c.host),
          id: c.id,
          state: c.state,
          error: c.error,
          trust: c.trust,
        };
      }
      case 'connections.trust': {
        const id = String(args.id),
          c = connectionForSession(id),
          file = Object.values(files.connections).find((c) => c.id === id);
        const trust = c?.trust ?? file?.trust;
        if (!trust) throw denied();
        const accepted =
          args.accept === true &&
          (await plugins.ask(
            '核验 SSH 主机指纹',
            `${trust.hostname}:${trust.port} · ${trust.algorithm}\n${trust.fingerprint}\n请通过可信渠道核对此真实指纹。`,
          ));
        check();
        await terminalApi.trust(id, accepted);
        return;
      }
      case 'clipboard.write':
        if (typeof args.text !== 'string' || args.text.length > 1024 * 1024) throw denied();
        return clipboardApi.writeText(args.text);
      case 'files.pick': {
        if (!hasAny('batch.run') || args.kind !== 'files') throw denied();
        const paths = await filesApi.pick('files');
        for (const path of paths) pickedFiles.add(path);
        while (pickedFiles.size > 64) pickedFiles.delete(pickedFiles.values().next().value!);
        return paths;
      }
      case 'workspace.navigate':
        if (args.view !== 'models') throw denied();
        workspace.navigate('models');
        return;
      case 'ui.notify':
        if (typeof args.message !== 'string' || args.message.length > 2048) throw denied();
        notifications.push(args.message, args.error === true);
        return;
      case 'ui.export':
        if (typeof args.name !== 'string' || !/^[\w.-]{1,120}$/.test(args.name)) throw denied();
        downloadResult(args.name, args.value);
        return;
      case 'ops_query': {
        const request = args.request as OpsRequest;
        if (!request || request.kind === 'diagnostic') throw denied();
        const publicRequest = { ...request };
        if ('confirmed' in publicRequest)
          delete (publicRequest as { confirmed?: boolean }).confirmed;
        return server({ kind: 'system_query', request: publicRequest });
      }
      case 'ops_feedback':
        return server({ kind: 'system_feedback' });
      case 'monitor_open': {
        if (args.hostId !== input.hostId) throw denied();
        const value = await server<{ id: string }>({
          kind: 'metrics_open',
          intervalSecs: application.state?.config.monitorIntervalSecs ?? 3,
        });
        monitor = value.id;
        return {
          id: monitor,
          hostId: input.hostId,
          transportId: 'plugin-owned',
          routeHostIds: [input.hostId],
        };
      }
      case 'monitor_snapshot':
        return monitor
          ? server({
              kind: 'metrics_snapshot',
              monitorId: monitor,
              afterRevision: typeof args.after === 'number' ? args.after : null,
            })
          : null;
      case 'monitor_visible':
        if (monitor)
          await server({
            kind: 'metrics_visible',
            monitorId: monitor,
            visible: args.visible === true,
          });
        return;
      case 'monitor_stop':
        if (monitor) {
          await server({ kind: 'metrics_close', monitorId: monitor });
          monitor = '';
        }
        return;
      case 'ops_log_open': {
        const value = args.input as LogInput,
          eventStream = args.events;
        if (!value || typeof eventStream !== 'string') throw denied();
        const result = await server<{ id: string }>({ kind: 'system_log_start', ...value });
        const control = { stopped: false };
        streams.set(result.id, control);
        void (async () => {
          try {
            while (!disposed && !control.stopped) {
              const value = await server<{
                events: (
                  | {
                      type: 'data';
                      dataBase64: string;
                      sequence: number;
                      stream: string;
                      at: number;
                    }
                  | Exclude<LogEvent, { type: 'data' }>
                )[];
              }>({ kind: 'system_log_poll', logId: result.id });
              if (disposed || control.stopped) return;
              for (const event of value.events)
                input.stream(
                  eventStream,
                  event.type === 'data'
                    ? {
                        ...event,
                        data: [...Uint8Array.from(atob(event.dataBase64), (c) => c.charCodeAt(0))],
                      }
                    : event,
                );
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          } catch (error) {
            if (!disposed && !control.stopped)
              input.stream(eventStream, {
                type: 'state',
                state: 'failed',
                code: 'PLUGIN_LOG',
                message:
                  typeof error === 'object' && error && 'message' in error
                    ? String(error.message)
                    : '日志读取失败',
              });
          }
        })();
        return { id: result.id, hostId: input.hostId, sessionId: 'plugin-owned' };
      }
      case 'ops_log_pause':
        if (!streams.has(String(args.id))) throw denied();
        return server({
          kind: 'system_log_pause',
          logId: String(args.id),
          paused: args.paused === true,
        });
      case 'ops_log_ack':
        if (!streams.has(String(args.id))) throw denied();
        return;
      case 'ops_log_close': {
        const id = String(args.id),
          control = streams.get(id);
        if (!control) throw denied();
        control.stopped = true;
        streams.delete(id);
        return server({ kind: 'system_log_stop', logId: id });
      }
      default:
        throw denied();
    }
  }
  function snapshotCatalog() {
    return hosts.catalog
      ? {
          ...hosts.catalog,
          hosts: hosts.catalog.hosts.map(publicHost),
          credentials: [],
          pendingSecretDeletions: 0,
        }
      : null;
  }
  return {
    snapshot,
    async call(method: string, args: Record<string, unknown>) {
      const value = await call(method, args);
      check();
      return value === undefined ? null : publicValue(value, method.startsWith('automation_'));
    },
    async dispose() {
      for (const request of requests) request.abort();
      for (const stop of listeners) stop();
      const cleanup: Promise<unknown>[] = [];
      const close = (operation: PluginCapability) =>
        pluginServerRequest(input.id, operation, input.page).catch((error) => {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['PLUGIN_CANCELLED', 'PLUGIN_PERMISSION_DENIED', 'NOT_FOUND'].includes(
              String(error.code),
            )
          )
            return;
          throw error;
        });
      for (const [id, control] of streams) {
        control.stopped = true;
        cleanup.push(close({ kind: 'system_log_stop', logId: id }));
      }
      if (monitor) cleanup.push(close({ kind: 'metrics_close', monitorId: monitor }));
      disposed = true;
      listeners.clear();
      streams.clear();
      leases.clear();
      originals.clear();
      pickedFiles.clear();
      references.clear();
      const results = await Promise.allSettled(cleanup);
      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason);
      if (failures.length) throw new AggregateError(failures, '插件界面资源释放失败');
    },
  };
}
