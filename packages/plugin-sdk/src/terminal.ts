import { request } from './transport';
/** Display-only context. It never changes the ticket's command or permissions. */
export interface TerminalPresentation {
  title?: string;
  description?: string;
}
/** Open a PTY for an opaque, one-use command ticket issued by the platform. */
export function openTerminal(
  ticket: string,
  hostId: string,
  presentation?: TerminalPresentation,
): Promise<void> {
  return request('terminal.open', { ticket, hostId, ...(presentation ? { presentation } : {}) });
}
