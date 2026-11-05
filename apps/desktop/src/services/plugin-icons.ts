import {
  Activity,
  Archive,
  Bot,
  Boxes,
  CalendarClock,
  ChartNoAxesCombined,
  Cloud,
  Code,
  Container,
  Cpu,
  Database,
  FileText,
  Folder,
  Globe,
  HardDrive,
  Layers,
  ListTree,
  Network,
  Radio,
  Rocket,
  ScrollText,
  Search,
  Server,
  Settings2,
  Shield,
  Terminal,
  Wrench,
} from '@lucide/vue';
import type { Component } from 'vue';
import type { InstalledPlugin, PluginManifest } from '../types/plugins';
import docker from '../../../../plugins/system/docker/manifest.json';
import services from '../../../../plugins/system/services/manifest.json';
import assistant from '../../../../plugins/system/assistant/manifest.json';

export const pluginIcons = new Map<string, Component>([
  ['activity', Activity],
  ['archive', Archive],
  ['bot', Bot],
  ['boxes', Boxes],
  ['calendar-clock', CalendarClock],
  ['chart-no-axes-combined', ChartNoAxesCombined],
  ['cloud', Cloud],
  ['code', Code],
  ['container', Container],
  ['cpu', Cpu],
  ['database', Database],
  ['file-text', FileText],
  ['folder', Folder],
  ['globe', Globe],
  ['hard-drive', HardDrive],
  ['layers', Layers],
  ['list-tree', ListTree],
  ['network', Network],
  ['radio', Radio],
  ['rocket', Rocket],
  ['scroll-text', ScrollText],
  ['search', Search],
  ['server', Server],
  ['settings-2', Settings2],
  ['shield', Shield],
  ['terminal', Terminal],
  ['wrench', Wrench],
]);
// Old installed system records keep their original package metadata and grants.
const bundledIcons = new Map(
  [services, docker, assistant].map((manifest) => [manifest.id, manifest.icon]),
);
export function pluginIcon(
  manifest: Pick<PluginManifest, 'id' | 'icon'>,
  source?: InstalledPlugin['source'],
): Component {
  const name = manifest.icon ?? (source === 'system' ? bundledIcons.get(manifest.id) : undefined);
  return pluginIcons.get(name ?? '') ?? Boxes;
}
