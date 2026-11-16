import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import App from './App.vue';
import type { Page } from './pages';

export function render(page: Page): Promise<string> {
  return renderToString(createSSRApp(App, { page }));
}
