import { tr } from '../i18n/messages';
import { isStreamControl } from '@serverdeck/plugin-sdk/streaming';
import { watch } from 'vue';
import { useHostsStore } from '../stores/hosts';
import { useOpsStore } from '../stores/ops';
import { useFilesStore } from '../stores/files';
import { useModelsStore } from '../stores/models';
import { useWorkspaceStore } from '../stores/workspace';
import { useNotificationsStore } from '../stores/notifications';
import { usePluginsStore } from '../stores/plugins';
import { pluginsApi } from './plugins';
import { filesApi } from './files';
import { pluginInvokeRequest, pluginPlatformRequest } from './plugin-server';
import { clipboardApi } from './clipboard';
import { terminalApi } from './terminal';
import { downloadResult } from './download';
import { errorMessage } from './ipc';
import type { PluginUiPage, PluginPermission } from '../types/plugins';
import type { PlatformRequest } from '@serverdeck/plugin-sdk/types/platform';
import type { TerminalPresentation } from '@serverdeck/plugin-sdk/terminal';
export function createPluginUiBridge(input: {
  id: string;
  revision: string;
  page: PluginUiPage;
  hostId: string;
  contextKey?: string;
  isActive?: () => boolean;
  canRetain?: () => boolean;
  settingsAction?: (action: 'close' | 'models') => void;
  terminal?: (ticket: string, hostId: string, presentation?: TerminalPresentation) => void;
  stream?: (id: string, event: unknown) => void;
}) {
  const hosts = useHostsStore(),
    ops = useOpsStore(),
    files = useFilesStore(),
    models = useModelsStore(),
    workspace = useWorkspaceStore(),
    plugins = usePluginsStore(),
    notifications = useNotificationsStore();
  const owner = input.contextKey || 'default';
  let disposed = false;
  const cleanup = new Set<() => void>();
  const active = () => !disposed && (input.isActive?.() ?? true);
  function check(requireActive = false) {
    const plugin = plugins.installed.find((p) => p.manifest.id === input.id),
      grant = plugins.grants[input.id];
    if (
      disposed ||
      (requireActive && !active()) ||
      !plugin?.enabled ||
      plugin.revision !== input.revision ||
      grant?.revision !== input.revision ||
      !grant.permissions.includes('ui.contribute') ||
      !grant.operations.includes('ui.contribute')
    )
      throw { code: 'PLUGIN_PERMISSION_DENIED', message: tr('插件权限或页面已失效') };
  }
  function has(permission: PluginPermission) {
    const grant = plugins.grants[input.id];
    return grant?.permissions.includes(permission) && grant.operations.includes(permission);
  }
  function snapshot() {
    check();
    const canRead = has('hosts.read'),
      canConnect = has('ssh.execute') || has('sftp.read') || has('sftp.write');
    return {
      theme: document.documentElement.dataset.theme ?? 'dark',
      language: plugins.locale,
      interfaceFontScale: Number(
        document.documentElement.style.getPropertyValue('--interface-font-scale') || 1,
      ),
      settingsRevision: plugins.settingsRevisions[input.id] ?? 0,
      hostId: input.hostId,
      hosts: canRead
        ? (hosts.catalog?.hosts ?? []).map((h) => ({
            id: h.id,
            name: h.name,
            hostname: h.hostname,
            port: h.port,
            username: h.username,
            description: h.description,
            groupId: h.groupId,
          }))
        : [],
      groups: canRead
        ? (hosts.catalog?.groups ?? []).map((g) => ({
            id: g.id,
            name: g.name,
            parentId: g.parentId,
          }))
        : [],
      connections:
        canRead || canConnect
          ? Object.fromEntries(
              Object.entries(ops.connections)
                .filter(([id]) => canRead || id === input.hostId)
                .map(([id, c]) => [id, { hostId: id, state: c.state, error: c.error }]),
            )
          : {},
      models: has('models.use')
        ? models.models.map((m) => ({
            id: m.id,
            name: m.name,
            revision: m.revision,
            hasKey: m.hasKey,
            config: {
              provider: m.config.provider,
              model: m.config.model,
              maxOutputTokens: m.config.maxOutputTokens,
              contextWindowTokens: m.config.contextWindowTokens,
            },
          }))
        : [],
    };
  }
  async function ensure(hostId: string, file: boolean) {
    check(true);
    if (!has(file ? 'sftp.read' : 'ssh.execute') && !(file && has('sftp.write')))
      throw { code: 'PLUGIN_PERMISSION_DENIED', message: tr('插件没有连接权限') };
    if (!hosts.catalog) await hosts.load();
    check(true);
    const host = hosts.catalog?.hosts.find((h) => h.id === hostId);
    if (!host) throw new Error(tr('目标主机未登记'));
    const checkFileIdentity = () => {
      const connection = files.connections[hostId];
      if (file && (connection?.elevated || connection?.switchingUser))
        throw {
          code: 'PLUGIN_SFTP_IDENTITY',
          message: tr('请先在 SFTP 文件页切回原登录用户，再使用插件文件功能。'),
        };
    };
    checkFileIdentity();
    if (file) await files.open(host);
    else await ops.open(host, false);
    await new Promise<void>((resolve, reject) => {
      let stop = () => {},
        finished = false,
        trusting = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        stop();
        clearTimeout(timer);
        cleanup.delete(cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () =>
        finish({ code: 'PLUGIN_CANCELLED', message: tr('页面已离开，停止等待连接') });
      cleanup.add(cancel);
      const inspect = async () => {
        if (finished) return;
        try {
          check(true);
          checkFileIdentity();
          const c = file ? files.connections[hostId] : ops.connections[hostId];
          if (!c) throw new Error(tr('连接未建立'));
          if (c.state === 'connected') {
            finish();
            return;
          }
          if (['failed', 'closed', 'disconnected'].includes(c.state))
            throw new Error(c.error || tr('连接已结束'));
          if (c.trust && !trusting) {
            trusting = true;
            const trust = c.trust;
            const accepted = await plugins.ask(
              tr('核验 SSH 主机指纹'),
              trust.hostname +
                ':' +
                trust.port +
                ' · ' +
                trust.algorithm +
                '\n' +
                trust.fingerprint +
                tr('\n请通过可信渠道核对此真实指纹。'),
              undefined,
              owner,
            );
            const id = file ? files.connections[hostId]?.id : ops.connections[hostId]?.session?.id;
            if (id) await terminalApi.trust(id, accepted && active());
            if (!accepted || !active()) throw new Error(tr('未确认主机指纹'));
            trusting = false;
          }
        } catch (error) {
          finish(error);
        }
      };
      stop = watch(
        () => {
          const c = file ? files.connections[hostId] : ops.connections[hostId];
          return [c?.state, c?.trust, c?.error];
        },
        () => void inspect(),
        { deep: true },
      );
      const timer = setTimeout(() => finish(new Error(tr('连接超时'))), 120000);
      void inspect();
    });
    check(true);
    return { hostId, state: 'connected' };
  }
  async function call(method: string, args: Record<string, unknown>): Promise<unknown> {
    const primitive =
      method === 'platform.request' ? (args.operation as PlatformRequest | undefined) : undefined;
    const resourceCleanup =
      primitive &&
      ([
        'close_file',
        'stream_stop',
        'result_close',
        'transfer_close',
        'transfer_cancel',
        'transfer_status',
      ].includes(primitive.kind) ||
        (primitive.kind === 'approval_mode' && primitive.mode === 'request') ||
        isStreamControl(primitive));
    check(!resourceCleanup);
    switch (method) {
      case 'invoke': {
        if (typeof args.action !== 'string') throw new Error(tr('插件动作无效'));
        const result = await pluginInvokeRequest(
          input.id,
          input.page,
          args.action,
          args.input,
          active,
          owner,
          args.confirmation,
        );
        check();
        if (!active() && !input.canRetain?.())
          throw { code: 'PLUGIN_CANCELLED', message: tr('页面已隐藏') };
        return result;
      }
      case 'platform.request': {
        if (!primitive || typeof primitive.kind !== 'string') throw new Error(tr('平台请求无效'));
        const result = await pluginPlatformRequest(input.id, primitive, active, owner);
        if (primitive.kind === 'settings_write')
          plugins.settingsRevisions[input.id] = (plugins.settingsRevisions[input.id] ?? 0) + 1;
        return result;
      }
      case 'actions.cancel':
        plugins.cancelPrompt(owner);
        await pluginsApi.cancelScope(input.id, owner);
        return null;
      case 'localFiles.pick': {
        if (!has('sftp.transfer') || !['files', 'folder'].includes(String(args.kind)))
          throw { code: 'PLUGIN_PERMISSION_DENIED', message: tr('插件没有文件传输权限') };
        const paths = await filesApi.pick(args.kind as 'files' | 'folder');
        check(true);
        return paths;
      }
      case 'connections.ensure':
        if (
          typeof args.hostId !== 'string' ||
          (args.files !== undefined && typeof args.files !== 'boolean')
        )
          throw new Error(tr('连接目标无效'));
        return ensure(args.hostId, args.files === true);
      case 'terminal.open': {
        if (
          !input.terminal ||
          typeof args.ticket !== 'string' ||
          typeof args.hostId !== 'string' ||
          !has('ssh.execute')
        )
          throw new Error(tr('终端票据无效'));
        let presentation: TerminalPresentation | undefined;
        if (args.presentation !== undefined) {
          const value = args.presentation;
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.entries(value).some(
              ([key, text]) =>
                !['title', 'description'].includes(key) ||
                typeof text !== 'string' ||
                !text.trim() ||
                text.length > (key === 'title' ? 160 : 240) ||
                /\p{Cc}/u.test(text),
            )
          )
            throw new Error(tr('终端显示信息无效'));
          const display = value as TerminalPresentation;
          presentation = {
            ...(display.title ? { title: display.title.trim() } : {}),
            ...(display.description ? { description: display.description.trim() } : {}),
          };
        }
        input.terminal(args.ticket, args.hostId, presentation);
        return null;
      }
      case 'workspace.draft':
        if (typeof args.dirty !== 'boolean' || !input.contextKey)
          throw new Error(tr('草稿作用域无效'));
        plugins.setDraftDirty(input.contextKey, input.id, args.dirty);
        return null;
      case 'clipboard.write':
        if (typeof args.text !== 'string' || args.text.length > 1024 * 1024)
          throw new Error(tr('复制内容超过限制'));
        await clipboardApi.writeText(args.text);
        return null;
      case 'workspace.navigate':
        if (args.view !== 'models') throw new Error(tr('导航目标无效'));
        if (input.settingsAction) input.settingsAction('models');
        else workspace.navigate('models');
        return null;
      case 'settings.close':
        if (!input.settingsAction) throw new Error(tr('当前页面不是插件设置'));
        input.settingsAction('close');
        return null;
      case 'ui.notify':
        if (typeof args.message !== 'string' || args.message.length > 2048)
          throw new Error(tr('通知超过限制'));
        notifications.push(args.message, args.error === true);
        return null;
      case 'ui.export':
        if (typeof args.name !== 'string' || !/^[\w.-]{1,120}$/.test(args.name))
          throw new Error(tr('导出文件名无效'));
        downloadResult(args.name, args.value);
        return null;
      default:
        throw { code: 'PLUGIN_PERMISSION_DENIED', message: tr('未公开的平台能力') };
    }
  }
  function suspend() {
    plugins.cancelPrompt(owner);
    for (const stop of cleanup) stop();
    void pluginsApi
      .scopeVisibility(input.id, owner, false)
      .catch((error) => notifications.push(errorMessage(error), true));
  }
  async function resume() {
    check();
    await pluginsApi.scopeVisibility(input.id, owner, true);
  }
  async function dispose() {
    if (disposed) return;
    plugins.cancelPrompt(owner);
    disposed = true;
    for (const stop of cleanup) stop();
    await pluginsApi.closeScope(input.id, owner);
  }
  return { snapshot, call, suspend, resume, dispose };
}
