import { Channel, invoke } from '@tauri-apps/api/core';
import type { ForwardInfo, LocalForwardInput } from '../types/connection';
import type { TerminalEvent, TerminalSession } from '../types/terminal';
import { ensureDesktop } from './ipc';

export const forwardingApi = {
  savedRules(hostId: string): Promise<LocalForwardInput[]> {
    ensureDesktop();
    return invoke('forward_rules', { hostId });
  },
  addRule: (hostId: string, rule: LocalForwardInput): Promise<LocalForwardInput> =>
    invoke('forward_add_rule', { hostId, rule }),
  removeRule: (hostId: string, listenPort: number): Promise<void> =>
    invoke('forward_remove_rule', { hostId, listenPort }),
  open(hostId: string, receive: (event: TerminalEvent) => void): Promise<TerminalSession> {
    ensureDesktop();
    const events = new Channel<TerminalEvent>();
    events.onmessage = receive;
    return invoke('forward_open', { hostId, events });
  },
  start: (id: string, input: LocalForwardInput): Promise<ForwardInfo> =>
    invoke('forward_start', { id, input }),
  list: (id: string): Promise<ForwardInfo[]> => invoke('forward_list', { id }),
  stop: (id: string): Promise<void> => invoke('forward_stop', { id }),
};
