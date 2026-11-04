import type { InjectionKey } from 'vue';
import type { monitorApi } from './monitor';
import type { opsApi } from './ops';

export interface PluginServerServices {
  monitor: Pick<typeof monitorApi, 'snapshot' | 'visible' | 'stop'> & {
    open: (...args: Parameters<typeof monitorApi.open>) => Promise<{ id: string }>;
  };
  operations: Pick<
    typeof opsApi,
    'query' | 'feedback' | 'logOpen' | 'logPause' | 'logAck' | 'logClose'
  >;
}
export const pluginServerServices: InjectionKey<PluginServerServices> = Symbol(
  'public-plugin-server-services',
);
