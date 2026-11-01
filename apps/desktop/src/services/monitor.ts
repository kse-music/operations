import { Channel, invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type { TerminalEvent, TerminalSession } from '../types/terminal';
import type { MonitorSnapshot } from '../types/monitor';
function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  ensureDesktop();
  return invoke(command, args);
}
export const monitorApi = {
  open(hostId: string, receive: (event: TerminalEvent) => void): Promise<TerminalSession> {
    const events = new Channel<TerminalEvent>();
    events.onmessage = receive;
    return call('monitor_open', { hostId, events });
  },
  snapshot: (hostId: string, after: number | null = null) =>
    call<MonitorSnapshot | null>('monitor_snapshot', { hostId, after }),
  visible: (hostId: string, visible: boolean) => call<void>('monitor_visible', { hostId, visible }),
  stop: (hostId: string) => call<void>('monitor_stop', { hostId }),
};
