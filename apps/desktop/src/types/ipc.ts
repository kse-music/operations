// Keep in sync with serverdeck-core. Contract tests exercise both IPC commands in Rust.
export type Theme = 'dark' | 'light' | 'system';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  product: import('./product').ProductPreferences;
  terminal: import('./preferences').TerminalPreferences;
  version: number;
  theme: Theme;
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
}

export interface IpcError {
  code: string;
  message: string;
}
