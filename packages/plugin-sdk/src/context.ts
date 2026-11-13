import { readonly, shallowReactive, type DeepReadonly } from 'vue';
import type { PluginLocale } from './types/plugins';
export interface HostMetadata {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  description: string;
  groupId: string | null;
}
export interface ConnectionMetadata {
  hostId: string;
  state: string;
  error: string | null;
}
export interface ModelMetadata {
  id: string;
  name: string;
  revision: string;
  createdAt: string | null;
  hasKey: boolean;
  config: { provider: string; model: string; maxOutputTokens: number; contextWindowTokens: number };
}
export interface PlatformContext {
  language: PluginLocale;
  hostId: string;
  hosts: HostMetadata[];
  groups: { id: string; name: string; parentId: string | null }[];
  connections: Record<string, ConnectionMetadata>;
  models: ModelMetadata[];
  settingsRevision: number;
  visible: boolean;
}
const state = shallowReactive<PlatformContext>({
  language: 'zh-CN',
  hostId: '',
  hosts: [],
  groups: [],
  connections: {},
  models: [],
  settingsRevision: 0,
  visible: true,
});
export function usePlatformContext(): DeepReadonly<PlatformContext> {
  return readonly(state);
}
/** Called only by the SDK's authenticated parent MessageChannel runtime. */
export function updatePlatformContext(value: PlatformContext): void {
  Object.assign(state, value);
}
