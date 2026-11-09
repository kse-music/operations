import { inject, type InjectionKey } from 'vue';
import { invoke } from '@serverdeck/plugin-sdk';
import { cancelCurrent } from '@serverdeck/plugin-sdk/actions';
import type { JsonValue } from '@serverdeck/plugin-sdk/types/platform';
import type {
  AiPrepare,
  AiPreview,
  AiResolveHosts,
  AiHostRoute,
  AiAnswer,
  AiExecution,
} from './types';
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const api = {
  prepare: (input: AiPrepare) => invoke<AiPreview>('prepare', json(input)),
  resolveHosts: (input: AiResolveHosts) => invoke<AiHostRoute>('resolve_hosts', json(input)),
  send: (id: string, confirmed: boolean) => invoke<AiAnswer>('send', { id, confirmed }),
  execute: (proposalId: string, confirmed: boolean, changeConfirmation: string | null) =>
    invoke<AiExecution>('execute', { proposalId, confirmed, changeConfirmation }),
  async cancel(id: string) {
    await cancelCurrent();
    await invoke('cancel', { id });
  },
};
export type AssistantApi = typeof api & { begin?: () => Promise<void>; end?: () => Promise<void> };
export const assistantApiKey: InjectionKey<AssistantApi> = Symbol('assistant-api');
export const useAssistantApi = (): AssistantApi => inject(assistantApiKey, api);
