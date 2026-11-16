// @vitest-environment node
import { posix } from 'node:path';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { pluginDevelopmentKit } from '../plugin-development-kit';

function archive() {
  let source: string | Uint8Array | undefined;
  const generate = pluginDevelopmentKit().generateBundle;
  if (typeof generate !== 'function') throw new Error('Missing development kit builder');
  generate.call(
    {
      emitFile(asset: { source: string | Uint8Array }) {
        source = asset.source;
      },
    } as never,
    {} as never,
    {} as never,
    false,
  );
  if (!source) throw new Error('Missing development kit archive');
  return unzipSync(typeof source === 'string' ? strToU8(source) : source);
}

describe('downloadable plugin development kit', () => {
  it('ships matching SDK dependency, lockfile, Rust package and public manual versions', () => {
    const files = archive();
    const read = (name: string) => strFromU8(files[name]);
    const sdk = JSON.parse(read('packages/plugin-sdk/package.json')) as { version: string };
    const project = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    expect(project.dependencies['@serverdeck/plugin-sdk']).toBe(sdk.version);
    expect(lock.packages[''].dependencies?.['@serverdeck/plugin-sdk']).toBe(sdk.version);
    expect(lock.packages['packages/plugin-sdk'].version).toBe(sdk.version);
    expect(read('crates/plugin-sdk/Cargo.toml')).toContain(`version = "${sdk.version}"`);
    expect(read('docs/plugins/PLUGIN_SDK.md')).toContain(`# Plugin SDK ${sdk.version}`);
  });

  it('includes the architecture and resolves every relative manual link within the archive', () => {
    const files = archive();
    expect(files['docs/plugins/PLUGIN_ARCHITECTURE.md']).toBeDefined();
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.endsWith('.md')) continue;
      for (const match of strFromU8(bytes).matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
        const target = match[1].split('#')[0];
        if (!target || /^[a-z]+:/iu.test(target)) continue;
        const resolved = posix.normalize(posix.join(posix.dirname(name), target));
        expect(files[resolved], `${name}: ${target}`).toBeDefined();
      }
    }
  });

  it('ships offline contracts and links to the single maintained tutorial without website sources', () => {
    const files = archive();
    const readme = strFromU8(files['README.md']);
    expect(files['docs/plugins/PLUGIN_BUILD_CONTRACT.md']).toBeDefined();
    expect(files['docs/plugins/PLUGIN_DEVELOPMENT.md']).toBeUndefined();
    expect(readme).toContain('https://ops.hiboot.cn/developers/quickstart.html');
    expect(readme).not.toContain('npm run package');
    expect(Object.keys(files).some((name) => name.startsWith('website/'))).toBe(false);
    expect(strFromU8(files['docs/plugins/PLUGIN_BUILD_CONTRACT.md'])).toContain(
      '[官网开发者中心](https://ops.hiboot.cn/developers/)',
    );
  });
});
