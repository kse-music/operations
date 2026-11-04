import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = path.join(root, 'packages/plugin-sdk/src');

export async function buildPluginUi(source, output, dependencies = []) {
  const owner = path.resolve(source, 'frontend');
  const within = (parent, file) => file === parent || file.startsWith(parent + path.sep);
  await build({
    configFile: false,
    root: source,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: { alias: { '@serverdeck/plugin-sdk': sdk }, dedupe: ['vue', 'pinia'] },
    plugins: [
      vue(),
      {
        name: 'public-plugin-sdk-boundary',
        enforce: 'pre',
        transform(_code, id) {
          if (id.startsWith('\0') || !path.isAbsolute(id)) return;
          const file = path.normalize(id.split('?')[0]);
          if (
            !within(owner, file) &&
            !within(sdk, file) &&
            !dependencies.some((parent) => within(parent, file)) &&
            !file.includes(`${path.sep}node_modules${path.sep}`)
          )
            throw new Error(
              `Plugin UI imports a source outside its package or public SDK: ${file}`,
            );
          if (file.includes(`${path.sep}@tauri-apps${path.sep}`))
            throw new Error('Plugin UI must use the public SDK instead of native IPC');
        },
      },
    ],
    build: {
      outDir: output,
      emptyOutDir: false,
      lib: {
        entry: path.join(owner, 'main.ts'),
        name: 'ServerDeckPlugin',
        formats: ['iife'],
        fileName: () => 'frontend.js',
        cssFileName: 'frontend',
      },
      sourcemap: false,
    },
  });
}
