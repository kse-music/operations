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
  createdAt: string | null;
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
