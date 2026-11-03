import type { WorkspaceView } from './product';

export type NavigationModule = 'hosts' | 'tools' | 'assets' | 'system';
export const navigationModules = [
  { id: 'hosts', label: '主机运维' },
  { id: 'tools', label: '运维工具' },
  { id: 'assets', label: '资产管理' },
  { id: 'system', label: '系统设置' },
] as const satisfies readonly { id: NavigationModule; label: string }[];

const viewModules: Record<WorkspaceView, NavigationModule> = {
  terminals: 'hosts',
  files: 'hosts',
  monitor: 'hosts',
  operations: 'hosts',
  batch: 'tools',
  automation: 'tools',
  network: 'tools',
  tasks: 'tools',
  credentials: 'assets',
  backup: 'assets',
  settings: 'system',
  overview: 'system',
  about: 'system',
};
export function moduleForView(view: WorkspaceView | null): NavigationModule {
  return view === null ? 'hosts' : viewModules[view];
}
