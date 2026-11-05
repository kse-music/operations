import type { WorkspaceView } from './product';

export type NavigationModule = 'hosts' | 'assets' | 'system';
export const navigationModules = [
  { id: 'hosts', label: '主机运维' },
  { id: 'assets', label: '资产管理' },
  { id: 'system', label: '设置' },
] as const satisfies readonly { id: NavigationModule; label: string }[];

const viewModules: Record<WorkspaceView, NavigationModule> = {
  terminals: 'hosts',
  files: 'hosts',
  server: 'hosts',
  network: 'hosts',
  assistant: 'hosts',
  credentials: 'assets',
  models: 'assets',
  backup: 'assets',
  settings: 'system',
  settingsTerminal: 'system',
  settingsShortcuts: 'system',
  settingsWorkspace: 'system',
  about: 'system',
  plugins: 'system',
  extension: 'hosts',
  pluginSettings: 'system',
};
export function moduleForView(view: WorkspaceView | null): NavigationModule {
  return view === null ? 'hosts' : viewModules[view];
}
