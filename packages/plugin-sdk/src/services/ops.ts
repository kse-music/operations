import { request } from '../transport';
import type {
  OpsRequest,
  OpsResponse,
  LogInput,
  LogEvent,
  LogSession,
  Feedback,
} from '../types/ops';
import type { TerminalEvent, TerminalSession } from '../types/terminal';
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return request(command, args);
}
export const opsApi = {
  connections: () => call<TerminalSession[]>('ops_connections'),
  open(hostId: string, receive: (event: TerminalEvent) => void): Promise<TerminalSession> {
    const events = { onmessage: receive };
    return call('ops_open', { hostId, events });
  },
  query: (id: string, request: OpsRequest) => call<OpsResponse>('ops_query', { id, request }),
  close: (id: string) => call<void>('ops_close', { id }),
  feedback: () => call<Feedback[]>('ops_feedback'),
  logOpen(id: string, input: LogInput, receive: (event: LogEvent) => void): Promise<LogSession> {
    const events = { onmessage: receive };
    return call('ops_log_open', { id, input, events });
  },
  logPause: (id: string, paused: boolean) => call<void>('ops_log_pause', { id, paused }),
  logAck: (id: string, sequence: number) => call<void>('ops_log_ack', { id, sequence }),
  logClose: (id: string) => call<void>('ops_log_close', { id }),
};
