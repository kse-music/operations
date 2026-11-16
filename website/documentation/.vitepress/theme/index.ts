import DefaultTheme from 'vitepress/theme-without-fonts';
import { inBrowser } from 'vitepress';
import type { Theme } from 'vitepress';
import Layout from './Layout.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ router }) {
    if (!inBrowser) return;
    router.onBeforeRouteChange = (to) => {
      const url = new URL(to, window.location.href);
      const isDocumentation = /^\/(docs|developers)(\/|$)/.test(url.pathname);
      if (url.origin === window.location.origin && !isDocumentation) {
        const origin = import.meta.env.DEV ? 'http://127.0.0.1:4180' : window.location.origin;
        window.location.assign(origin + url.pathname + url.search + url.hash);
        return false;
      }
    };
  },
} satisfies Theme;
