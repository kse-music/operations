import type { PluginConfirmation } from '@serverdeck/plugin-sdk/types/plugins';
import type { OpsRequest } from './types';

export function mutationConfirmation(
  request: OpsRequest,
  name?: string,
): PluginConfirmation | undefined {
  if (request.kind === 'container_maintenance') {
    const actions = {
      restart_exited: [
        '重启已退出容器',
        '仅重启当前主机状态为 exited 的容器，使其服务重新启动；不处理 created、paused 等其他状态。',
      ],
      clear_logs: [
        '清空容器日志',
        '将清空当前主机全部容器的 json-file 当前日志，清空后无法恢复；其他日志驱动和历史轮转文件保留。需要当前 SSH 账号有日志文件写权限，不自动提权。',
      ],
    } as const;
    const [label, impact] = actions[request.action];
    return {
      title: `${label}？`,
      message: `范围：当前主机全部容器，不受列表搜索条件影响。\n\n${impact}`,
      confirmLabel: label,
    };
  }
  if (request.kind === 'compose_action') {
    const actions = {
      start: ['启动', '将启动项目中已创建的服务容器，不拉取镜像或重新部署。'],
      stop: ['停止', '项目中的服务将暂时不可用，可以稍后重新启动。不删除容器或数据卷。'],
      restart: ['重启', '项目中的服务将短暂中断，然后重新启动。不应用配置或镜像更新。'],
    } as const;
    const [label, impact] = actions[request.action];
    return {
      title: `${label} Compose 项目？`,
      message: `项目：${request.project}\n\n${impact}`,
      confirmLabel: label,
    };
  }
  if (request.kind !== 'container_action' && request.kind !== 'image_remove') return undefined;
  const shortId = request.id.replace(/^sha256:/, '').slice(0, 12);
  const target = name && name !== request.id ? `${name}（${shortId}）` : shortId;
  if (request.kind === 'image_remove')
    return {
      title: '删除镜像？',
      message: `镜像：${target}\n\n删除后，创建新容器时可能需要重新拉取此镜像。不会删除容器或数据卷。`,
      confirmLabel: '删除',
    };
  const actions = {
    start: ['启动', '将启动此容器及其服务。'],
    stop: ['停止', '停止后，该容器提供的服务将暂时不可用，可稍后重新启动。'],
    restart: ['重启', '将重启此容器；若容器已停止，将启动它。运行中的服务将短暂中断。'],
    remove: [
      '删除',
      '删除后无法恢复此容器，容器内未持久化的数据会丢失。不会删除数据卷。运行中的容器需要先停止。',
    ],
  } as const;
  const [label, impact] = actions[request.action];
  return {
    title: `${label}容器？`,
    message: `容器：${target}\n\n${impact}`,
    confirmLabel: label,
  };
}
