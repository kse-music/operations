import { usePluginsStore } from '../stores/plugins';
import type { ServerSection } from '../types/server';

export async function serverPluginFor(hostId: string, section: ServerSection) {
  const plugins = usePluginsStore();
  for (const entry of plugins.extensions.filter((entry) => entry.kind === 'server')) {
    if (!hostId) continue;
    if (entry.routes?.includes(section)) return entry;
  }
}
