import type { PluginConfirmation } from '@serverdeck/plugin-sdk/types/plugins';
import type { OpsRequest } from './types';

export function mutationConfirmation(
  request: OpsRequest,
  name?: string,
): PluginConfirmation | undefined {
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
    restart: ['重启', '容器提供的服务将短暂中断，然后重新启动。'],
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
