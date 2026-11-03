import { defaultSshOptions, type SshOptions } from './connection';
export interface ProductPreferences {
  language: 'zh-CN';
  downloadDirectory: string | null;
  sshDefaults: SshOptions;
  shortcuts: Record<string, string>;
}
export const defaultProductPreferences = (): ProductPreferences => ({
  language: 'zh-CN',
  downloadDirectory: null,
  sshDefaults: defaultSshOptions(),
  shortcuts: { search: 'Ctrl+K', settings: 'Ctrl+,', tasks: 'Ctrl+Shift+J' },
});
// Locale registry: add a complete dictionary before advertising another UI language.
export const messages = {
  'zh-CN': {
    credentials: '安全凭据',
    models: '模型管理',
    settings: '通用',
    settingsTerminal: '终端',
    settingsShortcuts: '快捷键',
    settingsWorkspace: '工作区与连接',
    terminals: 'SSH 终端',
    files: 'SFTP 文件',
    server: '服务器管理',
    network: '网络诊断',
    assistant: 'AI 运维助手',
    batch: '批量运维',
    automation: '自动运维',
    backup: '备份恢复',
    tasks: '任务中心',
    about: '关于',
  },
} as const;
export type WorkspaceView = keyof (typeof messages)['zh-CN'];
export const settingsCategories = [
  { id: 'general', view: 'settings', label: messages['zh-CN'].settings },
  { id: 'terminal', view: 'settingsTerminal', label: messages['zh-CN'].settingsTerminal },
  { id: 'shortcuts', view: 'settingsShortcuts', label: messages['zh-CN'].settingsShortcuts },
  { id: 'workspace', view: 'settingsWorkspace', label: messages['zh-CN'].settingsWorkspace },
] as const;
export type SettingsCategory = (typeof settingsCategories)[number]['id'];
export const hostViews = new Set<WorkspaceView>(['terminals', 'files', 'server']);
export function globalKey(event: KeyboardEvent): string | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.isComposing || event.repeat)
    return null;
  const key =
    event.key === ',' ? ',' : /^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase() : '';
  return key ? `Ctrl+${event.shiftKey ? 'Shift+' : ''}${key}` : null;
}
export interface BackgroundTask {
  id: string;
  kind: 'diagnostic' | 'batch';
  hostIds: string[];
  state: string;
  label: string;
  active: boolean;
}
export interface BackupItem {
  id: string;
  kind: 'host' | 'entry';
  name: string;
  detail: string;
  duplicate: boolean;
  blocked: boolean;
  warnings: string[];
}
export interface BackupPreview {
  version: number;
  items: BackupItem[];
  warnings: string[];
}
export interface RestoreInput {
  text: string;
  selected: string[];
  conflict: 'skip' | 'copy';
  restorePreferences: boolean;
  confirmed: boolean;
}
export interface RestoreResult {
  hosts: number;
  entries: number;
  skipped: number;
  preferencesRestored: boolean;
  warnings: string[];
}

export interface ConnectionStatus {
  hostname: string;
  port: number;
  username: string;
  id: string;
  hostId: string;
  transportId: string;
  routeHostIds: string[];
  kind: 'terminal' | 'files' | 'monitor' | 'operations';
  state: string;
}
export interface BackgroundSnapshot {
  tasks: BackgroundTask[];
  connections: ConnectionStatus[];
}
