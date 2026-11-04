import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  resolve: {
    alias: {
      '@serverdeck/plugin-sdk': decodeURIComponent(
        new URL('../../packages/plugin-sdk/src', import.meta.url).pathname,
      ).replace(/^\/(?=[A-Za-z]:)/, ''),
    },
    dedupe: ['vue', 'pinia'],
  },
  plugins: [vue()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  test: {
    environment: 'jsdom',
    include: [
      'src/**/*.test.ts',
      '../../plugins/system/**/*.test.ts',
      '../../plugins/compat/**/*.test.ts',
      '../../packages/plugin-sdk/src/**/*.test.ts',
    ],
    restoreMocks: true,
  },
});
