import { request } from '../transport';
import type {
  AiAnswer,
  AiModel,
  AiExecution,
  AiPrepare,
  AiPreview,
  AiHostRoute,
  AiResolveHosts,
} from '../types/ai';
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return request(command, args);
}
export const aiApi = {
  models: () => call<AiModel[]>('ai_models'),
  prepare: (input: AiPrepare) => call<AiPreview>('ai_prepare', { input }),
  resolveHosts: (input: AiResolveHosts) => call<AiHostRoute>('ai_resolve_hosts', { input }),
  send: (id: string, confirmed: boolean) => call<AiAnswer>('ai_send', { id, confirmed }),
  execute: (proposalId: string, confirmed: boolean, changeConfirmation: string | null) =>
    call<AiExecution>('ai_execute', { input: { proposalId, confirmed, changeConfirmation } }),
  cancel: (id: string) => call<void>('ai_cancel', { id }),
};
