import type { WorkspaceView } from './product';

export const settingsNavigation = [
  { view: 'settings', label: '通用', icon: 'general' },
  { view: 'settingsTerminal', label: '终端', icon: 'terminal' },
  { view: 'settingsShortcuts', label: '快捷键', icon: 'shortcuts' },
  { view: 'settingsStorage', label: '数据与存储', icon: 'storage' },
  { view: 'models', label: '模型', icon: 'models' },
  { view: 'plugins', label: '插件', icon: 'plugins' },
  { view: 'about', label: '关于', icon: 'about' },
] as const satisfies readonly { view: WorkspaceView; label: string; icon: string }[];
export type SettingsView = (typeof settingsNavigation)[number]['view'];
export function isSettingsView(view: WorkspaceView): view is SettingsView {
  return settingsNavigation.some((item) => item.view === view);
}
