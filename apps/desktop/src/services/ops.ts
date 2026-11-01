import { Channel, invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type {
  OpsRequest,
  OpsResponse,
  LogInput,
  LogEvent,
  LogSession,
  ContainerShell,
  Feedback,
} from '../types/ops';
import type { TerminalEvent, TerminalSession, TerminalSize } from '../types/terminal';
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  ensureDesktop();
  return invoke(command, args);
}
export const opsApi = {
  connections: () => call<TerminalSession[]>('ops_connections'),
  open(hostId: string, receive: (event: TerminalEvent) => void): Promise<TerminalSession> {
    const events = new Channel<TerminalEvent>();
    events.onmessage = receive;
    return call('ops_open', { hostId, events });
  },
  query: (id: string, request: OpsRequest) => call<OpsResponse>('ops_query', { id, request }),
  close: (id: string) => call<void>('ops_close', { id }),
  feedback: () => call<Feedback[]>('ops_feedback'),
  logOpen(id: string, input: LogInput, receive: (event: LogEvent) => void): Promise<LogSession> {
    const events = new Channel<LogEvent>();
    events.onmessage = receive;
    return call('ops_log_open', { id, input, events });
  },
  logPause: (id: string, paused: boolean) => call<void>('ops_log_pause', { id, paused }),
  logAck: (id: string, sequence: number) => call<void>('ops_log_ack', { id, sequence }),
  logClose: (id: string) => call<void>('ops_log_close', { id }),
  shell(
    hostId: string,
    size: TerminalSize,
    shell: ContainerShell,
    receive: (event: TerminalEvent) => void,
  ): Promise<TerminalSession> {
    const events = new Channel<TerminalEvent>();
    events.onmessage = receive;
    return call('ops_container_shell', { hostId, size, shell, events });
  },
};
