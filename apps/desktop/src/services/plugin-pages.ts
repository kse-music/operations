import type { InstalledPlugin } from '../types/plugins';
export function primaryPluginPage(plugin: InstalledPlugin): string {
  return (
    plugin.manifest.contributions.find((entry) =>
      ['navigation', 'server', 'workspace', 'tool'].includes(entry.kind),
    )?.id ??
    plugin.manifest.contributions[0]?.id ??
    '__details'
  );
}
