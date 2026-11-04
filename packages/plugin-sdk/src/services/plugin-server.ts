import { request } from '../transport';
import type { PluginCapability, PluginUiPage } from '../types/plugins';
/** Compatibility client for UI v2/v3. Identity is always bound by the transport. */
export function pluginServerRequest<T>(
  _id: string,
  operation: PluginCapability,
  _page?: PluginUiPage,
): Promise<T> {
  void _page;
  return request<T>('capability', { operation });
}
