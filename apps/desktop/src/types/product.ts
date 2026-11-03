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
    overview: '本地环境',
    settings: '全局设置',
    terminals: 'SSH 终端',
    files: 'SFTP 文件',
    monitor: '服务器监控',
    operations: 'Linux 运维',
    network: '网络诊断',
    batch: '批量运维',
    automation: '自动运维',
    backup: '备份恢复',
    tasks: '任务中心',
    about: '关于 ServerDeck',
  },
} as const;
export type WorkspaceView = keyof (typeof messages)['zh-CN'];
export const hostViews = new Set<WorkspaceView>(['terminals', 'files', 'monitor', 'operations']);
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
