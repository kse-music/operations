import { tr } from '../i18n/messages';
import { defaultSshOptions, type SshOptions } from './connection';
export interface ProductPreferences {
  language: 'zh-CN' | 'en-US';
  downloadDirectory: string | null;
  sshDefaults: SshOptions;
  shortcuts: Record<string, string>;
}
export const defaultProductPreferences = (): ProductPreferences => ({
  language: 'zh-CN',
  downloadDirectory: null,
  sshDefaults: defaultSshOptions(),
  shortcuts: { search: 'Ctrl+K', settings: 'Ctrl+,' },
});
export const viewLabels = {
  get models() {
    return tr('模型');
  },
  get settings() {
    return tr('通用');
  },
  get settingsTerminal() {
    return tr('终端');
  },
  get settingsShortcuts() {
    return tr('快捷键');
  },
  get settingsStorage() {
    return tr('数据与存储');
  },
  get terminals() {
    return tr('SSH 终端');
  },
  get files() {
    return tr('SFTP 文件');
  },
  get server() {
    return tr('服务器管理');
  },
  get about() {
    return tr('关于');
  },
  get plugins() {
    return tr('插件管理');
  },
  get extension() {
    return tr('插件工作区');
  },
} as const;
export type WorkspaceView = keyof typeof viewLabels;
export const settingsCategories = [
  {
    id: 'general',
    view: 'settings',
    get label() {
      return viewLabels.settings;
    },
  },
  {
    id: 'terminal',
    view: 'settingsTerminal',
    get label() {
      return viewLabels.settingsTerminal;
    },
  },
  {
    id: 'shortcuts',
    view: 'settingsShortcuts',
    get label() {
      return viewLabels.settingsShortcuts;
    },
  },
  {
    id: 'storage',
    view: 'settingsStorage',
    get label() {
      return viewLabels.settingsStorage;
    },
  },
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
  connections: ConnectionStatus[];
}
