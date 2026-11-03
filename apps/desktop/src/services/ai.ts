import { invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type {
  AiAnswer,
  AiModel,
  AiModelInput,
  AiModelTest,
  AiExecution,
  AiPrepare,
  AiPreview,
  AiHostRoute,
  AiResolveHosts,
} from '../types/ai';
import type { Mutation } from '../types/hosts';
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  ensureDesktop();
  return invoke(command, args);
}
export const aiApi = {
  models: () => call<AiModel[]>('ai_models'),
  modelSave: (input: AiModelInput) => call<Mutation<AiModel>>('ai_model_save', { input }),
  modelTest: (input: AiModelInput) => call<AiModelTest>('ai_model_test', { input }),
  modelDelete: (id: string, expectedRevision: string, confirmed: boolean) =>
    call<Mutation<null>>('ai_model_delete', { input: { id, expectedRevision, confirmed } }),
  prepare: (input: AiPrepare) => call<AiPreview>('ai_prepare', { input }),
  resolveHosts: (input: AiResolveHosts) => call<AiHostRoute>('ai_resolve_hosts', { input }),
  send: (id: string, confirmed: boolean) => call<AiAnswer>('ai_send', { id, confirmed }),
  execute: (proposalId: string, confirmed: boolean, changeConfirmation: string | null) =>
    call<AiExecution>('ai_execute', { input: { proposalId, confirmed, changeConfirmation } }),
  cancel: (id: string) => call<void>('ai_cancel', { id }),
};
