import { request } from '../transport';
export function useWorkspaceStore() {
  return { navigate: (view: 'models') => request<void>('workspace.navigate', { view }) };
}
