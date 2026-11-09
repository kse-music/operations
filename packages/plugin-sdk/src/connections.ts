import { request } from './transport';
/** Establish a platform-owned, verified connection; host key consent is rendered by the host. */
export function ensureConnection(
  hostId: string,
  files = false,
): Promise<{ hostId: string; state: 'connected' }> {
  return request('connections.ensure', { hostId, files });
}
