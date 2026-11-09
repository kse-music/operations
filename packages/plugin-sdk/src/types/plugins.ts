export type PluginPermission =
  | 'network.connect'
  | 'models.use'
  | 'hosts.read'
  | 'ssh.execute'
  | 'ssh.execute.preapproved'
  | 'sftp.read'
  | 'sftp.write'
  | 'ui.contribute'
  | 'settings.read'
  | 'settings.write';
export interface PluginManifest {
  schemaVersion: number;
  id: string;
  name: string;
  icon?: string | null;
  version: string;
  author: string;
  description: string;
  apiVersion: string;
  entry: { backend: string | null; ui: string | null };
  permissions: PluginPermission[];
  preapprovedCommands?: import('./platform').Command[];
  contributions: {
    id: string;
    label: string;
    kind: 'workspace' | 'navigation' | 'host_menu' | 'command' | 'settings' | 'server';
    routes?: string[];
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

export type PluginCapability = {
  kind: 'platform';
  request: import('./platform').PlatformRequest;
  bindings: string[];
};
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
  uiVersion: 4;
  title: PluginLabel;
  pages: PluginUiPage[];
  frontend: { script: string; style: string };
}
export interface PluginUiPage {
  surface: { kind: 'frontend' };
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
}
export type PluginValues = Record<string, string | boolean | null>;
export interface PluginUiResult {
  values?: PluginValues;
  output?: unknown;
  saved?: boolean;
}
