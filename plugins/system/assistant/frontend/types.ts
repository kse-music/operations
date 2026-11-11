import { tr } from './i18n/messages';
import type { LogSource } from './ops-types';
import type { TransferPreview, TransferState } from '@serverdeck/plugin-sdk/types/platform';
export interface AiConfig {
  provider: 'openai_compatible' | 'local_codex' | 'local_claude_code';
  baseUrl: string;
  model: string;
  allowInsecureHttp: boolean;
  maxOutputTokens: number;
  contextWindowTokens: number;
}
export interface AiModel {
  id: string;
  name: string;
  revision: string;
  config: AiConfig;
  hasKey: boolean;
}
export const LOCAL_CODEX_MODEL_ID = 'local-codex';
export const LOCAL_CLAUDE_CODE_MODEL_ID = 'local-claude-code';
export const isLocalModel = (id: string) =>
  id === LOCAL_CODEX_MODEL_ID || id === LOCAL_CLAUDE_CODE_MODEL_ID;
export interface LocalCodexStatus {
  installed?: boolean;
  installSupported?: boolean;
  authorized: boolean;
  model: AiModel | null;
  message: string;
}
export type LocalClaudeCodeStatus = LocalCodexStatus;
export interface AiModelInput {
  id: string | null;
  expectedRevision: string | null;
  name: string;
  config: AiConfig;
  apiKey: string | null;
  clearKey: boolean;
  testId?: string | null;
}
export interface AiModelTest {
  id: string;
  elapsedMs: number;
  expiresInSeconds: number;
}
export const defaultAiConfig = (): AiConfig => ({
  provider: 'openai_compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  allowInsecureHttp: false,
  maxOutputTokens: 2048,
  contextWindowTokens: 131072,
});
export interface AiSelection {
  server: boolean;
  metrics: boolean;
  processes: boolean;
  docker: boolean;
  log: LogSource | null;
  logLines: number;
}
export interface AiPrepare {
  progressId?: string;
  approvalMode?: 'request' | 'assist' | 'full';
  modelId: string;
  sessionId: string | null;
  question: string;
  selection: AiSelection;
  maskAddresses: boolean;
  redactValues: string[];
  history?: { role: 'user' | 'assistant'; content: string }[];
  sessionIds?: string[];
  autoHosts?: boolean;
  expectedModelRevision?: string | null;
}
export interface AiHostRoute {
  hostIds: string[];
  message: string;
  modelRevision: string;
}
export interface AiResolveHosts {
  modelId: string;
  requestId: string;
  question: string;
  previousHostIds: string[];
  maskAddresses: boolean;
  redactValues: string[];
}
export interface AiTurn {
  streamText?: string;
  approvalMode?: 'request' | 'assist' | 'full';
  id: string;
  question: string;
  state: 'pending' | 'complete' | 'failed' | 'cancelled';
  answer: AiAnswer | null;
  error: string;
  requestId: string;
  hostIds: string[];
  task: AiTask | null;
}
export type AiTaskStatus =
  | 'prepared'
  | 'running'
  | 'awaiting_approval'
  | 'executing'
  | 'transferring'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unverified'
  | 'expired';
export interface AiTask {
  id: string;
  status: AiTaskStatus;
  modelId: string;
  hostIds: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}
export const taskStatusLabels: Record<AiTaskStatus, string> = {
  get prepared() {
    return tr('已准备');
  },
  get running() {
    return tr('正在查询与分析');
  },
  get awaiting_approval() {
    return tr('等待审核');
  },
  get executing() {
    return tr('正在执行');
  },
  get transferring() {
    return tr('正在传输');
  },
  get verifying() {
    return tr('正在复查');
  },
  get succeeded() {
    return tr('已完成');
  },
  get failed() {
    return tr('失败');
  },
  get cancelled() {
    return tr('已停止');
  },
  get unverified() {
    return tr('结果未确认，请核对实际状态');
  },
  get expired() {
    return tr('已过期，请重新提问');
  },
};
export type AiToolId =
  | 'diagnostic'
  | 'capabilities'
  | 'images'
  | 'containers'
  | 'container_details'
  | 'container_stats'
  | 'processes'
  | 'process_details'
  | 'ports'
  | 'services'
  | 'service_details'
  | 'remove_untagged_images'
  | 'container'
  | 'service'
  | 'file_read'
  | 'file_edit'
  | 'transfer_prepare'
  | 'transfer';
export interface AiToolResult {
  tool: AiToolId;
  status: 'running' | 'succeeded' | 'verified' | 'failed' | 'unverified' | 'skipped';
  message: string | null;
}
export interface AiPreview {
  task?: AiTask;
  id: string;
  modelId: string;
  destination: string;
  model: string;
  body: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  warnings: string[];
}
export interface AiProposal {
  id: string;
  command: string;
  risk: 'read_only' | 'change' | 'manual_only';
  reason: string;
  target: string | null;
  changeConfirmation: string | null;
}
export interface AiAnswer {
  task?: AiTask;
  text: string;
  proposals: AiProposal[];
  usage: { inputTokens: number; outputTokens: number } | null;
  warnings: string[];
  agent?: AiAgentReport;
}
export interface AiExecution {
  pending?: boolean;
  transfer?: TransferState;
  task?: AiTask;
  success: boolean;
  output: string;
  agent?: { steps: AiAgentStepResult[] };
}
export interface AiAgentStep {
  action: string;
  target: string;
  preview?:
    | { kind: 'edit'; path: string; baseSha256: string; diff: string }
    | { kind: 'transfer'; preview: TransferPreview };
}
export interface AiAgentStepResult extends AiAgentStep, AiToolResult {}
export interface AiAgentReport {
  observations: (AiToolResult & { query: string; records: number })[];
  steps: AiAgentStep[];
}
