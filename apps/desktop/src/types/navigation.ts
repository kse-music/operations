import type { WorkspaceView } from './product';

export type NavigationModule = 'hosts' | 'assets' | 'plugins' | 'system';
export const navigationModules = [
  { id: 'hosts', label: '主机运维' },
  { id: 'assets', label: '资产管理' },
  { id: 'plugins', label: '插件' },
  { id: 'system', label: '设置' },
] as const satisfies readonly { id: NavigationModule; label: string }[];

const viewModules: Record<WorkspaceView, NavigationModule> = {
  terminals: 'hosts',
  files: 'hosts',
  server: 'hosts',
  assistant: 'hosts',
  credentials: 'assets',
  models: 'assets',
  settings: 'system',
  settingsTerminal: 'system',
  settingsShortcuts: 'system',
  settingsStorage: 'system',
  about: 'system',
  plugins: 'plugins',
  extension: 'hosts',
  pluginSettings: 'plugins',
};
export function moduleForView(view: WorkspaceView | null): NavigationModule {
  return view === null ? 'hosts' : viewModules[view];
}
