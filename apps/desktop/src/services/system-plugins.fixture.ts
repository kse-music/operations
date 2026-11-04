// Test fixtures use the distributed manifests; production reads the host repository.
import resources from '../../../../plugins/system/resources/manifest.json';
import docker from '../../../../plugins/system/docker/manifest.json';
import processes from '../../../../plugins/system/processes/manifest.json';
import services from '../../../../plugins/system/services/manifest.json';
import logs from '../../../../plugins/system/logs/manifest.json';
import assistant from '../../../../plugins/system/assistant/manifest.json';
import batch from '../../../../plugins/system/batch/manifest.json';
import automation from '../../../../plugins/system/automation/manifest.json';
import network from '../../../../plugins/system/network/manifest.json';
import assistantUi from '../../../../plugins/system/assistant/ui.json';
import batchUi from '../../../../plugins/system/batch/ui.json';
import automationUi from '../../../../plugins/system/automation/ui.json';
import networkUi from '../../../../plugins/system/network/ui.json';
import type { InstalledPlugin, PluginManifest, PluginGrant, PluginUi } from '../types/plugins';
export const systemPluginFixtures = (): InstalledPlugin[] =>
  [resources, docker, processes, services, logs].map((manifest) => ({
    source: 'system',
    manifest: manifest as PluginManifest,
    enabled: false,
    revision: `fixture-${manifest.id}`,
    packageDigest: 'fixture',
    trust: 'local_development_unverified',
    previousVersion: null,
  }));
export function toolPluginState() {
  const definitions = [assistant, batch, automation, network];
  const ui = [assistantUi, batchUi, automationUi, networkUi];
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
