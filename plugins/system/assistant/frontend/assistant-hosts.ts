import { tr } from './i18n/messages';
import { ref } from 'vue';
import { useAssistantApi } from './api';
import { useHostCatalog, hostDisplayName, type Host } from './platform-state';
import { ensureConnection } from '@serverdeck/plugin-sdk/connections';
import { cancelCurrent } from '@serverdeck/plugin-sdk/actions';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { AiPrepare } from './types';
export function useAssistantHosts() {
  const api = useAssistantApi(),
    catalog = useHostCatalog();
  const matched = ref<Host[]>([]),
    phase = ref(''),
    cleanupError = ref('');
  function clear() {
    matched.value = [];
    phase.value = '';
    cleanupError.value = '';
  }
  async function resolve(
    input: AiPrepare,
    previousHostIds: string[],
    requestId: string,
    signal: AbortSignal,
    onMatch: (ids: string[]) => void,
  ) {
    phase.value = tr('正在匹配相关主机…');
    cleanupError.value = '';
    const check = () => {
      if (signal.aborted) throw new DOMException(tr('已停止'), 'AbortError');
    };
    await catalog.load();
    check();
    const abort = () => {
      void cancelCurrent().catch((cause) => {
        cleanupError.value = errorMessage(cause);
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const route = await api.resolveHosts({
        modelId: input.modelId,
        entryHostId: input.entryHostId ?? null,
        requestId,
        question: input.question,
        previousHostIds,
        history: input.history ?? [],
        maskAddresses: input.maskAddresses,
        redactValues: input.redactValues,
      });
      check();
      matched.value = route.hostIds.map((id) => {
        const host = catalog.catalog.hosts.find((host) => host.id === id);
        if (!host) throw new Error(tr('命中主机已发生变化'));
        return { ...host };
      });
      onMatch(route.hostIds);
      const failures: string[] = [];
      for (const host of matched.value) {
        check();
        phase.value = tr('正在连接 ') + hostDisplayName(host) + '…';
        try {
          await ensureConnection(host.id);
        } catch (cause) {
          check();
          failures.push(hostDisplayName(host) + '：' + errorMessage(cause));
        }
      }
      if (failures.length) throw new Error(failures.join('\n'));
      check();
      phase.value = tr('正在读取主机上下文…');
      return { route, sessionIds: route.hostIds };
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  return { matched, phase, cleanupError, resolve, clear };
}
