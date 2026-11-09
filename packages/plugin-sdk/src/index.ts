export { request } from './transport';
export { errorMessage } from './services/ipc';
export type { HostMetadata, ModelMetadata, PlatformContext } from './context';
export type { PluginCapability, PluginUiPage } from './types/plugins';
import { request } from './transport';
import type { JsonValue } from './types/platform';
import type { PluginConfirmation } from './types/plugins';
/** Invoke a declared action on this plugin's Wasm backend. */
export function invoke<T>(
  action: string,
  input: JsonValue = null,
  options?: { confirmation?: PluginConfirmation },
): Promise<T> {
  return request<T>('invoke', {
    action,
    input,
    ...(options && { confirmation: options.confirmation }),
  });
}
