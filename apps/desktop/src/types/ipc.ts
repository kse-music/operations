// Keep in sync with serverdeck-core. Contract tests exercise both IPC commands in Rust.
export type Theme = 'dark' | 'light' | 'system';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  product: import('./product').ProductPreferences;
  terminal: import('./preferences').TerminalPreferences;
  version: number;
  theme: Theme;
  interfaceFontSize: import('./preferences').InterfaceFontSize;
  sidebarWidth: number;
  terminalFontSize: number;
  connectTimeoutSecs: number;
  monitorIntervalSecs: number;
  transferConcurrency: number;
  logLevel: LogLevel;
}

export interface Bootstrap {
  appVersion: string;
  databaseVersion: number;
  dataDirectory: string;
  logDirectory: string;
  config: AppConfig;
  storage?: StorageInfo;
}

export interface StorageInfo {
  rootDirectory: string;
  databasePath: string;
  pluginDirectory: string;
  logDirectory: string;
  webviewDirectory: string;
  notice: string | null;
}

export interface StoragePreview {
  targetDirectory: string;
  bytes: number;
  availableBytes: number;
  unfinishedTasks: number;
  dirtyDocuments: number;
}

export interface IpcError {
  code: string;
  message: string;
}
