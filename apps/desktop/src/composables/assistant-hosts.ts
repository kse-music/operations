import { ref, watch } from 'vue';
import { useHostsStore } from '../stores/hosts';
import { useOpsStore } from '../stores/ops';
import { aiApi } from '../services/ai';
import { errorMessage } from '../services/ipc';
import { hostDisplayName, type Host } from '../types/hosts';
import type { AiPrepare } from '../types/ai';

const cancelled = () => new DOMException('已停止', 'AbortError');
export function useAssistantHosts() {
  const hosts = useHostsStore(),
    ops = useOpsStore();
  const matched = ref<Host[]>([]),
    phase = ref(''),
    cleanupError = ref('');
  function clear() {
    matched.value = [];
    phase.value = '';
    cleanupError.value = '';
  }
  async function connected(host: Host, signal: AbortSignal): Promise<string> {
    const previous = ops.connections[host.id];
    if (
      previous?.session &&
      previous.state === 'connected' &&
      (previous.host.hostname !== host.hostname ||
        previous.host.port !== host.port ||
        previous.host.username !== host.username ||
        previous.host.credentialId !== host.credentialId ||
        JSON.stringify(previous.host.ssh) !== JSON.stringify(host.ssh))
    ) {
      throw new Error('现有连接使用旧配置，请先在服务器管理中重新连接');
    }
    const oldSession = previous?.session?.id;
    await ops.open(host, false);
    const created = ops.connections[host.id]?.session?.id !== oldSession;
    try {
      if (signal.aborted) throw cancelled();
      return await new Promise<string>((resolve, reject) => {
        const finish = (id?: string, failure?: Error) => {
          stop();
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          if (failure) reject(failure);
          else resolve(id!);
        };
        const abort = () => finish(undefined, cancelled());
        const check = () => {
          const c = ops.connections[host.id];
          if (c?.state === 'connected' && c.session) finish(c.session.id);
          else if (c?.trust || c?.state === 'awaiting_trust')
            finish(undefined, new Error('需要先核对 SSH 主机密钥指纹，核对后重新发送'));
          else if (c && ['failed', 'closed', 'disconnected'].includes(c.state))
            finish(undefined, new Error(c.error || 'SSH 运维连接已结束'));
        };
        const stop = watch(
          () => {
            const c = ops.connections[host.id];
            return [c?.state, c?.session?.id, c?.error, c?.trust];
          },
          check,
          { flush: 'post' },
        );
        const timer = setTimeout(() => finish(undefined, new Error('连接超时')), 120_000);
        signal.addEventListener('abort', abort, { once: true });
        check();
      });
    } catch (e) {
      if (created && (signal.aborted || !ops.connections[host.id]?.trust)) {
        try {
          await ops.close(host.id);
        } catch (closeError) {
          cleanupError.value = `命中主机「${hostDisplayName(host)}」的未完成连接关闭失败：${errorMessage(closeError)}`;
          throw new AggregateError(
            [e],
            `${errorMessage(e)}；关闭未完成连接失败：${errorMessage(closeError)}`,
            { cause: closeError },
          );
        }
      }
      throw e;
    }
  }
  async function resolve(
    input: AiPrepare,
    previousHostIds: string[],
    requestId: string,
    signal: AbortSignal,
    onMatch: (ids: string[]) => void,
  ) {
    phase.value = '正在匹配相关主机…';
    cleanupError.value = '';
    await hosts.load();
    if (hosts.error || !hosts.catalog) throw new Error(hosts.error || '资产列表读取失败');
    if (signal.aborted) throw cancelled();
    const route = await aiApi.resolveHosts({
      modelId: input.modelId,
      requestId,
      question: input.question,
      previousHostIds,
      maskAddresses: input.maskAddresses,
      redactValues: input.redactValues,
    });
    if (signal.aborted) throw cancelled();
    matched.value = route.hostIds.map((id) => {
      const host = hosts.catalog?.hosts.find((h) => h.id === id);
      if (!host) throw new Error('命中资产已发生变化，请刷新资产列表后重试');
      return host;
    });
    onMatch(route.hostIds);
    if (route.message && !route.hostIds.length) return { route, sessionIds: [] };
    const sessionIds: string[] = [],
      failures: string[] = [];
    for (const host of matched.value) {
      if (signal.aborted) throw cancelled();
      phase.value = `正在连接 ${hostDisplayName(host)}…`;
      try {
        sessionIds.push(await connected(host, signal));
      } catch (e) {
        if (signal.aborted) throw e;
        failures.push(
          `命中主机「${hostDisplayName(host)}」（${host.hostname}:${host.port}）连接不上：${errorMessage(e)}`,
        );
      }
    }
    if (failures.length) throw new Error(failures.join('\n'));
    phase.value = '正在读取授权上下文…';
    return { route, sessionIds };
  }
  return { matched, phase, cleanupError, resolve, clear };
}
