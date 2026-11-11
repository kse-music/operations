import { tr } from './i18n/messages';
import type { PluginConfirmation } from '@serverdeck/plugin-sdk/types/plugins';
import type { OpsRequest } from './types';

export function mutationConfirmation(
  request: OpsRequest,
  name?: string,
): PluginConfirmation | undefined {
  if (request.kind === 'container_maintenance') {
    const actions = {
      restart_exited: [
        tr('重启已退出容器'),
        tr(
          '仅重启当前主机状态为 exited 的容器，使其服务重新启动；不处理 created、paused 等其他状态。',
        ),
      ],
      clear_logs: [
        tr('清空容器日志'),
        tr(
          '将清空当前主机全部容器的 json-file 当前日志，清空后无法恢复；其他日志驱动和历史轮转文件保留。需要当前 SSH 账号有日志文件写权限，不自动提权。',
        ),
      ],
    } as const;
    const [label, impact] = actions[request.action];
    return {
      title: `${label}？`,
      message: tr('范围：当前主机全部容器，不受列表搜索条件影响。\n\n{0}', impact),
      confirmLabel: label,
    };
  }
  if (request.kind === 'compose_action') {
    const actions = {
      start: [tr('启动'), tr('将启动项目中已创建的服务容器，不拉取镜像或重新部署。')],
      stop: [tr('停止'), tr('项目中的服务将暂时不可用，可以稍后重新启动。不删除容器或数据卷。')],
      restart: [tr('重启'), tr('项目中的服务将短暂中断，然后重新启动。不应用配置或镜像更新。')],
    } as const;
    const [label, impact] = actions[request.action];
    return {
      title: tr('{0} Compose 项目？', label),
      message: tr('项目：{0}\n\n{1}', request.project, impact),
      confirmLabel: label,
    };
  }
  if (request.kind !== 'container_action' && request.kind !== 'image_remove') return undefined;
  const shortId = request.id.replace(/^sha256:/, '').slice(0, 12);
  const target = name && name !== request.id ? `${name}（${shortId}）` : shortId;
  if (request.kind === 'image_remove')
    return {
      title: tr('删除镜像？'),
      message: tr(
        '镜像：{0}\n\n删除后，创建新容器时可能需要重新拉取此镜像。不会删除容器或数据卷。',
        target,
      ),
      confirmLabel: tr('删除'),
    };
  const actions = {
    start: [tr('启动'), tr('将启动此容器及其服务。')],
    stop: [tr('停止'), tr('停止后，该容器提供的服务将暂时不可用，可稍后重新启动。')],
    restart: [tr('重启'), tr('将重启此容器；若容器已停止，将启动它。运行中的服务将短暂中断。')],
    remove: [
      tr('删除'),
      tr(
        '删除后无法恢复此容器，容器内未持久化的数据会丢失。不会删除数据卷。运行中的容器需要先停止。',
      ),
    ],
  } as const;
  const [label, impact] = actions[request.action];
  return {
    title: tr('{0}容器？', label),
    message: tr('容器：{0}\n\n{1}', target, impact),
    confirmLabel: label,
  };
}
