import { inject, type InjectionKey } from 'vue';
import { invoke } from '@serverdeck/plugin-sdk';
import { cancelCurrent } from '@serverdeck/plugin-sdk/actions';
import { call } from '@serverdeck/plugin-sdk/platform';
import type { JsonValue, TransferState } from '@serverdeck/plugin-sdk/types/platform';
import type {
  AiPrepare,
  AiPreview,
  AiResolveHosts,
  AiHostRoute,
  AiAnswer,
  AiExecution,
  AiTask,
} from './types';
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const api = {
  prepare: (input: AiPrepare) => invoke<AiPreview>('prepare', json(input)),
  resolveHosts: (input: AiResolveHosts) => invoke<AiHostRoute>('resolve_hosts', json(input)),
  send: (id: string, confirmed: boolean) => invoke<AiAnswer>('send', { id, confirmed }),
  execute: (proposalId: string, confirmed: boolean, changeConfirmation: string | null) =>
    invoke<AiExecution>('execute', { proposalId, confirmed, changeConfirmation }),
  task: (id: string) => invoke<AiTask>('task', { id }),
  poll: (id: string) => invoke<AiExecution>('poll', { id }),
  cancelTransfer: (id: string) => call<TransferState>({ kind: 'transfer_cancel', id }),
  async cancel(id: string) {
    await cancelCurrent();
    await invoke('cancel', { id });
  },
};
export type AssistantApi = typeof api & { begin?: () => Promise<void>; end?: () => Promise<void> };
export const assistantApiKey: InjectionKey<AssistantApi> = Symbol('assistant-api');
export const useAssistantApi = (): AssistantApi => inject(assistantApiKey, api);
