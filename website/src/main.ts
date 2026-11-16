import { createSSRApp } from 'vue';
import App from './App.vue';
import { pageFromPath } from './pages';
import './style.css';
import './site.css';

createSSRApp(App, { page: pageFromPath(window.location.pathname) }).mount('#app');
