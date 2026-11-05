// Test fixtures use the distributed manifests; production reads the host repository.
import docker from '../../../../plugins/system/docker/manifest.json';
import assistant from '../../../../plugins/system/assistant/manifest.json';
import dockerUi from '../../../../plugins/system/docker/ui.json';
import assistantUi from '../../../../plugins/system/assistant/ui.json';
import type { InstalledPlugin, PluginManifest, PluginGrant, PluginUi } from '../types/plugins';
export const systemPluginFixtures = (): InstalledPlugin[] =>
  [docker, assistant].map((manifest) => ({
    source: 'system',
    manifest: manifest as PluginManifest,
    enabled: false,
    revision: `fixture-${manifest.id}`,
    packageDigest: 'fixture',
    trust: 'local_development_unverified',
    previousVersion: null,
  }));
export function toolPluginState() {
  const definitions = [assistant, docker];
  const ui = [assistantUi, dockerUi];
  const installed = definitions.map((manifest) => ({
    source: 'system',
    manifest: manifest as PluginManifest,
    enabled: true,
    revision: `fixture-${manifest.id}`,
    packageDigest: 'fixture',
    trust: 'local_development_unverified',
    previousVersion: null,
  })) as InstalledPlugin[];
  const grants = Object.fromEntries(
    installed.map((plugin) => [
      plugin.manifest.id,
      {
        version: 1,
        pluginId: plugin.manifest.id,
        pluginVersion: plugin.manifest.version,
        publisher: null,
        packageDigest: plugin.packageDigest,
        revision: plugin.revision,
        permissions: plugin.manifest.permissions,
        operations: [...plugin.manifest.permissions],
        readRoots: [],
        writeRoots: [],
      } as PluginGrant,
    ]),
  );
  const schemas = Object.fromEntries(
    installed.map((plugin, i) => [
      plugin.manifest.id,
      { revision: plugin.revision, ui: ui[i] as PluginUi },
    ]),
  );
  return { installed, grants, schemas, loaded: true };
}
