export { request } from './transport';
export { errorMessage } from './services/ipc';
export type { Host } from './types/hosts';
export type { PluginCapability, PluginUiPage } from './types/plugins';
import { request } from './transport';
import type { PluginValues } from './types/plugins';
/** Invoke a declared action on this plugin's Wasm backend. */
export function invoke<T>(action: string, values: PluginValues = {}): Promise<T> {
  return request<T>('invoke', { action, values });
}
