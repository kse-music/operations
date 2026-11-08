import { request } from '../transport';
import type { PluginCapability } from '../types/plugins';

export function requestCapability<T>(operation: PluginCapability): Promise<T> {
  return request<T>('capability', { operation });
}
