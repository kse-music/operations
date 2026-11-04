import { Channel, invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type {
  InstalledPlugin,
  PluginManifest,
  PluginRuntimeStatus,
  PluginReply,
  PluginGrantInput,
  PluginGrant,
  PluginContextInput,
  PluginRequest,
  PluginResponse,
  PluginEvent,
  PluginUi,
  PluginPackagePreview,
} from '../types/plugins';

export const pluginsApi = {
  toolAbortInput(id: string, inputId: string): Promise<void> {
    ensureDesktop();
    return invoke('plugin_tool_abort_input', { id, inputId });
  },
  toolStage(
    id: string,
    input: {
      operation: import('../types/plugins').PluginToolOperation;
      args: Record<string, unknown>;
    },
  ): Promise<import('../types/plugins').PluginToolTicket> {
    ensureDesktop();
    return invoke('plugin_tool_stage', { id, input });
  },
  toolCancelRequest(id: string, request: string): Promise<void> {
    ensureDesktop();
    return invoke('plugin_tool_cancel_request', { id, request });
  },
  terminalOpen(
    id: string,
    ticket: string,
    expectedHost: string,
    expected: import('../types/ops').ContainerShell,
    size: import('../types/terminal').TerminalSize,
    receive: (event: import('../types/terminal').TerminalEvent) => void,
  ): Promise<import('../types/terminal').TerminalSession> {
    ensureDesktop();
    const events = new Channel<import('../types/terminal').TerminalEvent>();
    events.onmessage = receive;
    return invoke('plugin_terminal_open', {
      id,
      ticket,
      expectedHost,
      expected: { id: expected.id, bash: expected.bash, confirmed: true },
      size,
      events,
    });
  },
  previewInfo(path: string): Promise<PluginPackagePreview> {
    ensureDesktop();
    return invoke('plugin_preview_info', { path });
  },
  pick(): Promise<string | null> {
    ensureDesktop();
    return invoke('plugin_pick');
  },
  ui(id: string, revision: string): Promise<PluginUi> {
    ensureDesktop();
    return invoke('plugin_ui', { id, revision });
  },
  grant(id: string, input: PluginGrantInput): Promise<PluginGrant> {
    ensureDesktop();
    return invoke('plugin_grant', { id, input });
  },
  permissions(id: string): Promise<PluginGrant | null> {
    ensureDesktop();
    return invoke('plugin_permissions', { id });
  },
  revoke(id: string): Promise<void> {
    ensureDesktop();
    return invoke('plugin_revoke', { id });
  },
  context(id: string, input: PluginContextInput | null): Promise<void> {
    ensureDesktop();
    return invoke('plugin_context', { id, input });
  },
  approve(id: string, confirmed: boolean): Promise<void> {
    ensureDesktop();
    return invoke('plugin_approve', { id, confirmed });
  },
  events(): Promise<PluginEvent[]> {
    ensureDesktop();
    return invoke('plugin_events');
  },
  capability(id: string, request: PluginRequest): Promise<PluginResponse> {
    ensureDesktop();
    return invoke('plugin_capability', { id, request });
  },
  statuses(): Promise<PluginRuntimeStatus[]> {
    ensureDesktop();
    return invoke('plugin_statuses');
  },
  activate(id: string): Promise<PluginRuntimeStatus> {
    ensureDesktop();
    return invoke('plugin_activate', { id });
  },
  call(id: string, payload: unknown): Promise<PluginReply> {
    ensureDesktop();
    return invoke('plugin_call', { id, payload });
  },
  health(id: string): Promise<PluginReply> {
    ensureDesktop();
    return invoke('plugin_health', { id });
  },
  cancel(id: string): Promise<void> {
    ensureDesktop();
    return invoke('plugin_cancel', { id });
  },
  preview(path: string): Promise<PluginManifest> {
    ensureDesktop();
    return invoke('plugin_preview', { path });
  },
  list(): Promise<InstalledPlugin[]> {
    ensureDesktop();
    return invoke('plugin_list');
  },
  detail(id: string): Promise<InstalledPlugin> {
    ensureDesktop();
    return invoke('plugin_detail', { id });
  },
  install(
    path: string,
    developmentConfirmed: boolean,
    expectedVersion: string | null,
    expectedDigest: string | null = null,
  ): Promise<InstalledPlugin> {
    ensureDesktop();
    return invoke('plugin_install', {
      input: { path, developmentConfirmed, expectedVersion, expectedDigest },
    });
  },
  setEnabled(id: string, enabled: boolean): Promise<InstalledPlugin> {
    ensureDesktop();
    return invoke('plugin_set_enabled', { id, enabled });
  },
  uninstall(id: string, clearData: boolean, confirmed: boolean): Promise<void> {
    ensureDesktop();
    return invoke('plugin_uninstall', { input: { id, clearData, confirmed } });
  },
};
