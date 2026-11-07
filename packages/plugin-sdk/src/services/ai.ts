import { request } from '../transport';
import type {
  AiAnswer,
  AiModel,
  AiExecution,
  AiPrepare,
  AiPreview,
  AiHostRoute,
  AiResolveHosts,
  LocalCodexStatus,
  LocalClaudeCodeStatus,
} from '../types/ai';
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return request(command, args);
}
export const aiApi = {
  localToolInstall: (modelId: string, requestId: string) =>
    call<void>('ai_local_tool_install', { modelId, requestId }),
  localToolInstallCancel: (requestId: string) =>
    call<void>('ai_local_tool_install_cancel', { requestId }),
  begin: () => call<void>('ai_begin'),
  end: () => call<void>('ai_end'),
  models: () => call<AiModel[]>('ai_models'),
  localCodexStatus: () => call<LocalCodexStatus>('ai_local_codex_status'),
  localCodexAuthorize: (authorized: boolean) =>
    call<void>('ai_local_codex_authorize', { authorized }),
  localClaudeCodeStatus: () => call<LocalClaudeCodeStatus>('ai_local_claude_code_status'),
  localClaudeCodeAuthorize: (authorized: boolean) =>
    call<void>('ai_local_claude_code_authorize', { authorized }),
  prepare: (input: AiPrepare) => call<AiPreview>('ai_prepare', { input }),
  resolveHosts: (input: AiResolveHosts) => call<AiHostRoute>('ai_resolve_hosts', { input }),
  send: (id: string, confirmed: boolean) => call<AiAnswer>('ai_send', { id, confirmed }),
  execute: (proposalId: string, confirmed: boolean, changeConfirmation: string | null) =>
    call<AiExecution>('ai_execute', { input: { proposalId, confirmed, changeConfirmation } }),
  cancel: (id: string) => call<void>('ai_cancel', { id }),
};
