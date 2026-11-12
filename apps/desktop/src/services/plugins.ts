import { Channel, invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type {
  InstalledPlugin,
  PluginManifest,
  PluginRuntimeStatus,
  PluginReply,
  PluginGrantInput,
  PluginGrant,
  PluginRequest,
  PluginResponse,
  PluginEvent,
  PluginUi,
  PluginPackagePreview,
} from '../types/plugins';

export const pluginsApi = {
  inventory(): Promise<import('../types/plugins').PluginInventory> {
    ensureDesktop();
    return invoke('plugin_inventory');
  },
  reinstallBundled(
    id: string,
    expectedRecordDigest: string,
    confirmed: boolean,
  ): Promise<InstalledPlugin> {
    ensureDesktop();
    return invoke('plugin_reinstall_bundled', { id, expectedRecordDigest, confirmed });
  },
  platformTerminalOpen(
    id: string,
    owner: string,
    ticket: string,
    expectedHost: string,
    size: import('../types/terminal').TerminalSize,
    receive: (event: import('../types/terminal').TerminalEvent) => void,
  ): Promise<import('../types/terminal').TerminalSession> {
    ensureDesktop();
    const events = new Channel<import('../types/terminal').TerminalEvent>();
    events.onmessage = receive;
    return invoke('plugin_platform_terminal_open', {
      id,
      owner,
      ticket,
      expectedHost,
      size,
      events,
    });
  },
  continue(
    id: string,
    continuation: string,
    owner = 'default',
    cancelled = false,
  ): Promise<PluginReply> {
    ensureDesktop();
    return invoke('plugin_continue', { id, owner, continuation, cancelled });
  },
  cancelScope(id: string, owner: string): Promise<void> {
    ensureDesktop();
    return invoke('plugin_cancel_scope', { id, owner });
  },
  closeScope(id: string, owner: string): Promise<void> {
    ensureDesktop();
    return invoke('plugin_close_scope', { id, owner });
  },
  scopeVisibility(id: string, owner: string, visible: boolean, retain = false): Promise<void> {
    ensureDesktop();
    return invoke('plugin_scope_visibility', { id, owner, visible, retain });
  },
  previewInfo(path: string): Promise<PluginPackagePreview> {
    ensureDesktop();
    return invoke('plugin_preview_info', { path });
  },
  pick(): Promise<string | null> {
    ensureDesktop();
    return invoke('plugin_pick');
  },
  saveDevelopmentKit(): Promise<string | null> {
    ensureDesktop();
    return invoke('plugin_save_development_kit');
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
  reset(id: string): Promise<void> {
    ensureDesktop();
    return invoke('plugin_reset', { id });
  },
  approve(id: string, confirmed: boolean): Promise<void> {
    ensureDesktop();
    return invoke('plugin_approve', { id, confirmed });
  },
  events(): Promise<PluginEvent[]> {
    ensureDesktop();
    return invoke('plugin_events');
  },
  capability(id: string, request: PluginRequest, owner = 'default'): Promise<PluginResponse> {
    ensureDesktop();
    return invoke('plugin_capability', { id, owner, request });
  },
  statuses(): Promise<PluginRuntimeStatus[]> {
    ensureDesktop();
    return invoke('plugin_statuses');
  },
  activate(id: string): Promise<PluginRuntimeStatus> {
    ensureDesktop();
    return invoke('plugin_activate', { id });
  },
  call(id: string, payload: unknown, owner = 'default'): Promise<PluginReply> {
    ensureDesktop();
    return invoke('plugin_call', { id, owner, payload });
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
