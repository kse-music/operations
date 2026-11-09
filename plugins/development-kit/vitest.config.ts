import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['example/frontend/**/*.test.ts', 'packages/plugin-sdk/src/**/*.test.ts'],
  },
});
