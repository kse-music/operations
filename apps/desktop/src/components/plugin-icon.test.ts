import { afterEach, expect, it } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import PluginIcon from './PluginIcon.vue';
import { pluginIcons, pluginIcon } from '../services/plugin-icons';
import { systemPluginFixtures, toolPluginState } from '../services/system-plugins.fixture';
import type { PluginManifest } from '../types/plugins';

let app: App | undefined, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  app = undefined;
  root?.remove();
});
function mount(manifest: Pick<PluginManifest, 'id' | 'icon'>, source?: 'system' | 'user') {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(PluginIcon, { manifest, source, size: 21 });
  app.mount(root);
}
it('uses two distinct configured icons and restores icons for legacy system records only', () => {
  const plugins = [
    ...new Map(
      [...systemPluginFixtures(), ...toolPluginState().installed].map((plugin) => [
        plugin.manifest.id,
        plugin,
      ]),
    ).values(),
  ];
  const configured = plugins.map((plugin) => plugin.manifest.icon);
  expect(configured).toHaveLength(2);
  expect(new Set(configured).size).toBe(2);
  for (const plugin of plugins) {
    expect(pluginIcons.has(plugin.manifest.icon!)).toBe(true);
    const old = { ...plugin.manifest, icon: undefined };
    expect(pluginIcon(old, 'system')).toBe(pluginIcons.get(plugin.manifest.icon!));
    expect(pluginIcon(old, 'user')).toBe(pluginIcons.get('boxes'));
    expect(pluginIcon(old)).toBe(pluginIcons.get('boxes'));
  }
});
it.each([undefined, null, '', 'future-icon', '__proto__', 'constructor', '<svg>'])(
  'falls back to the default icon for missing or unrecognized name %s',
  (icon) => {
    mount({ id: 'dev.uploaded', icon }, 'user');
    expect(root.querySelector('svg.lucide-boxes')).not.toBeNull();
    expect(root.querySelector('img, script')).toBeNull();
  },
);
it('renders an uploaded icon with the requested size and updates when the manifest changes', async () => {
  const { reactive } = await import('vue');
  const manifest = reactive({ id: 'dev.uploaded', icon: 'rocket' });
  mount(manifest, 'user');
  const svg = root.querySelector('svg.lucide-rocket')!;
  expect(svg.getAttribute('width')).toBe('21');
  expect(svg.getAttribute('aria-hidden')).toBe('true');
  manifest.icon = 'database';
  await nextTick();
  expect(root.querySelector('svg.lucide-database')).not.toBeNull();
  expect(root.querySelector('svg.lucide-rocket')).toBeNull();
});
