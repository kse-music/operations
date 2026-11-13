export * from '@serverdeck/plugin-sdk/types/plugins';
export interface PluginProblem {
  id: string;
  code: string;
  message: string;
  recordDigest: string | null;
  replacement: { name: string; version: string } | null;
}
export interface PluginInventory {
  installed: import('@serverdeck/plugin-sdk/types/plugins').InstalledPlugin[];
  problems: PluginProblem[];
  availableBundled: import('@serverdeck/plugin-sdk/types/plugins').PluginManifest[];
}
