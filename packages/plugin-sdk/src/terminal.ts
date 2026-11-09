import { request } from './transport';
/** Open a PTY for an opaque, one-use command ticket issued by the platform. */
export function openTerminal(ticket: string, hostId: string): Promise<void> {
  return request('terminal.open', { ticket, hostId });
}
