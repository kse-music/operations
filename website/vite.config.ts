import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { searchIndexPlugin } from './scripts/search-index.mjs';

export default defineConfig({
  plugins: [vue(), searchIndexPlugin(fileURLToPath(new URL('./documentation/', import.meta.url)))],
  base: '/',
  build: {
    sourcemap: false,
    rollupOptions: {
      input: ['index.html', 'marketplace.html', 'privacy.html', 'security.html', '404.html'],
    },
  },
});
