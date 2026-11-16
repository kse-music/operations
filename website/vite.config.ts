import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: '/',
  build: {
    sourcemap: false,
    rollupOptions: { input: ['index.html', 'privacy.html', 'security.html', '404.html'] },
  },
});
