import { usePluginsStore } from '../stores/plugins';
import type { ServerSection } from '../types/server';

export async function serverPluginFor(hostId: string, section: ServerSection) {
  const plugins = usePluginsStore();
  for (const entry of plugins.extensions.filter((entry) => entry.kind === 'server')) {
    if (!hostId) continue;
    const ui = await plugins.schema(entry.pluginId);
    const surface = ui.pages.find((page) => page.id === entry.id)?.surface;
    if (surface && surface.kind !== 'tool' && surface.sections.includes(section)) return entry;
  }
}
