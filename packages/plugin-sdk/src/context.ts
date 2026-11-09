import { readonly, shallowReactive, type DeepReadonly } from 'vue';
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
  hasKey: boolean;
  config: { provider: string; model: string; maxOutputTokens: number; contextWindowTokens: number };
}
export interface PlatformContext {
  hostId: string;
  hosts: HostMetadata[];
  groups: { id: string; name: string; parentId: string | null }[];
  connections: Record<string, ConnectionMetadata>;
  models: ModelMetadata[];
  settingsRevision: number;
  visible: boolean;
}
const state = shallowReactive<PlatformContext>({
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
