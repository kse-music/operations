import type { InstalledPlugin } from '../types/plugins';
export function isBuiltinAssistant(plugin: InstalledPlugin | undefined): boolean {
  return plugin?.source === 'system' && plugin.manifest.id === 'cn.hiboot.plugins.assistant';
}
export function primaryPluginPage(plugin: InstalledPlugin): string {
  return (
    plugin.manifest.contributions.find((entry) =>
      ['navigation', 'server', 'workspace', 'tool'].includes(entry.kind),
    )?.id ??
    plugin.manifest.contributions.find((entry) => entry.kind !== 'settings')?.id ??
    plugin.manifest.contributions[0]?.id ??
    '__details'
  );
}

export function hasPluginFunction(plugin: InstalledPlugin): boolean {
  return plugin.manifest.contributions.some((entry) => entry.kind !== 'settings');
}
