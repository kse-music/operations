import { usePluginsStore } from '../stores/plugins';
import type { InstalledPlugin } from '../types/plugins';
import { pluginsApi } from './plugins';

export async function togglePlugin(plugin: InstalledPlugin): Promise<boolean> {
  const plugins = usePluginsStore();
  if (
    plugin.enabled &&
    !(await plugins.ask(
      '禁用插件？',
      '将停止插件调用并放弃未保存的插件编辑。已打开的终端不受影响。',
    ))
  )
    return false;
  const ok = await plugins.mutate(() => pluginsApi.setEnabled(plugin.manifest.id, !plugin.enabled));
  if (ok) plugins.clearPlugin(plugin.manifest.id);
  return ok;
}
