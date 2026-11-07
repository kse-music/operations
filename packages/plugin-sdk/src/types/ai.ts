import type { LogSource } from './ops';
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
  id: string;
  question: string;
  state: 'pending' | 'complete' | 'failed' | 'cancelled';
  answer: AiAnswer | null;
  error: string;
  requestId: string;
  hostIds: string[];
}
export interface AiPreview {
  id: string;
  modelId: string;
  destination: string;
  model: string;
  body: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  estimatedMaxCost: number | null;
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
  text: string;
  proposals: AiProposal[];
  usage: { inputTokens: number; outputTokens: number } | null;
  estimatedCost: number | null;
  warnings: string[];
  agent?: AiAgentReport;
}
export interface AiExecution {
  success: boolean;
  output: string;
  agent?: { steps: AiAgentStepResult[] };
}
export interface AiAgentStep {
  action: string;
  target: string;
}
export interface AiAgentStepResult extends AiAgentStep {
  status: 'verified' | 'failed' | 'unverified' | 'skipped';
  message: string;
}
export interface AiAgentReport {
  observations: { query: string; success: boolean; records: number; message: string | null }[];
  steps: AiAgentStep[];
}
