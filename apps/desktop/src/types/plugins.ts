export type PluginPermission =
  | 'assistant.use'
  | 'batch.run'
  | 'automation.manage'
  | 'network.run'
  | 'metrics.read'
  | 'system.read'
  | 'system.manage'
  | 'logs.read'
  | 'hosts.read'
  | 'ssh.execute'
  | 'sftp.read'
  | 'sftp.write'
  | 'ui.contribute'
  | 'settings.read'
  | 'settings.write'
  | 'tasks.create';
export interface PluginManifest {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  apiVersion: string;
  entry: { backend: string | null; ui: string | null };
  permissions: PluginPermission[];
  contributions: {
    id: string;
    label: string;
    kind: 'workspace' | 'navigation' | 'host_menu' | 'command' | 'settings' | 'server' | 'tool';
    tool?: PluginTool;
  }[];
  platforms: string[];
  files: { path: string; size: number; sha256: string }[];
  publisher: string | null;
}
export interface InstalledPlugin {
  source?: 'system' | 'user';
  manifest: PluginManifest;
  enabled: boolean;
  trust: 'local_development_unverified';
  packageDigest: string;
  revision: string;
  previousVersion: string | null;
}
export interface PluginRuntimeStatus {
  id: string;
  revision: string;
  state: 'starting' | 'active' | 'stopping' | 'stopped' | 'crashed';
  errorCode: string | null;
  diagnostic: unknown;
}
export interface PluginReply {
  protocolVersion: number;
  result: unknown;
  error: { code: string; message: string } | null;
}
export interface PluginGrantInput {
  expectedRevision: string;
  permissions: PluginPermission[];
  operations: string[];
  readRoots: string[];
  writeRoots: string[];
  confirmed: boolean;
}
export interface PluginGrant extends Omit<PluginGrantInput, 'expectedRevision' | 'confirmed'> {
  version: number;
  pluginId: string;
  pluginVersion: string;
  publisher: string | null;
  packageDigest: string;
  revision: string;
}
export interface PluginContextInput {
  hostId: string;
  opsSession: string | null;
  fileSession: string | null;
}
type PublicQuery<T> = T extends { kind: 'diagnostic' }
  ? never
  : T extends object
    ? Omit<T, 'confirmed'>
    : never;
export type PluginSystemQuery = PublicQuery<import('./ops').OpsRequest>;
export type PluginCapability =
  | { kind: 'tool_invoke'; inputId: string; operation: PluginToolOperation }
  | { kind: 'system_query'; request: PluginSystemQuery }
  | { kind: 'system_feedback' }
  | { kind: 'metrics_open'; intervalSecs: number }
  | { kind: 'metrics_snapshot'; monitorId: string; afterRevision: number | null }
  | { kind: 'metrics_visible'; monitorId: string; visible: boolean }
  | { kind: 'metrics_close'; monitorId: string }
  | { kind: 'system_log_start'; source: import('./ops').LogSource; lines: number; follow: boolean }
  | { kind: 'system_log_poll' | 'system_log_stop'; logId: string }
  | { kind: 'system_log_pause'; logId: string; paused: boolean }
  | { kind: 'container_shell'; id: string; bash: boolean }
  | { kind: 'result_read'; resultId: string; chunk: number }
  | { kind: 'result_close'; resultId: string }
  | { kind: 'hosts_read' }
  | { kind: 'execute' | 'task_create'; command: string; timeoutSecs: number }
  | { kind: 'read_file'; path: string }
  | { kind: 'save_file'; documentId: string; content: string }
  | { kind: 'close_file'; documentId: string; discard: boolean }
  | { kind: 'file_dirty'; documentId: string; dirty: boolean }
  | { kind: 'settings_read' }
  | { kind: 'settings_write'; value: unknown }
  | { kind: 'notify'; message: string }
  | { kind: 'task_read' | 'task_cancel'; taskId: string }
  | { kind: 'log_start'; path: string; lines: number }
  | { kind: 'log_poll' | 'log_stop'; logId: string }
  | { kind: 'log_pause'; logId: string; paused: boolean };
export interface PluginRequest {
  apiVersion: number;
  requestId: string;
  operation: PluginCapability;
}
export interface PluginResponse {
  requestId: string;
  result: unknown;
  error: { code: string; message: string } | null;
}
export interface PluginApproval {
  id: string;
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  hostId: string;
  operation: string;
  description: string;
}
export interface PluginEvent {
  pluginId: string;
  kind: string;
  operation: string;
  message: string;
}
export type PluginLocale = 'zh-CN' | 'en-US';
export type PluginLabel = string | Record<PluginLocale, string>;
export interface PluginUi {
  uiVersion: number;
  title: PluginLabel;
  pages: PluginUiPage[];
}
export interface PluginUiPage {
  surface?:
    | { kind: 'monitor' | 'operations'; sections: import('./server').ServerSection[] }
    | { kind: 'tool'; tool: PluginTool }
    | null;
  id: string;
  title: PluginLabel;
  initialAction: string | null;
  fields: {
    id: string;
    label: PluginLabel;
    kind: 'text' | 'textarea' | 'checkbox';
    default: string | boolean | null;
    readonly: boolean;
    documentField: string | null;
  }[];
  actions: { id: string; label: PluginLabel; discardDirty: boolean; enabledWhen: string | null }[];
  log: { resourceField: string; title: PluginLabel } | null;
}
export interface PluginPackagePreview {
  manifest: PluginManifest;
  packageDigest: string;
  trust: 'local_development_unverified';
  compatible: boolean;
}
export type PluginValues = Record<string, string | boolean | null>;
export interface PluginUiResult {
  values?: PluginValues;
  output?: unknown;
  saved?: boolean;
}
export type PluginTool = 'assistant' | 'batch' | 'automation' | 'network';
export type PluginToolOperation =
  | 'ai_resolve_hosts'
  | 'ai_prepare'
  | 'ai_send'
  | 'ai_execute'
  | 'diagnostic_start'
  | 'diagnostic_list'
  | 'diagnostic_cancel'
  | 'batch_start'
  | 'batch_list'
  | 'batch_cancel'
  | 'batch_retry_file'
  | 'automation_catalog'
  | 'automation_prepare'
  | 'automation_entry_save'
  | 'automation_entry_delete'
  | 'automation_group_save'
  | 'automation_group_delete'
  | 'automation_start'
  | 'automation_run'
  | 'automation_history'
  | 'automation_cancel'
  | 'automation_approve'
  | 'automation_schedule_save'
  | 'automation_schedule_disable'
  | 'automation_schedule_delete'
  | 'automation_status'
  | 'automation_run_delete';
export interface PluginToolIntent {
  automationHost: string;
  entryId: string;
  networkHost: string;
  networkRequest: number;
}
