import { createApp, createSSRApp } from 'vue';
import App from './App.vue';
import { pageFromPath } from './pages';
import './style.css';
import './site.css';

const createWebsiteApp = import.meta.env.DEV ? createApp : createSSRApp;
createWebsiteApp(App, { page: pageFromPath(window.location.pathname) }).mount('#app');
