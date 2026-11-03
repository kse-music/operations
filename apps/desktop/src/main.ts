import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { useApplicationStore } from './stores/application';
import './styles/main.css';
import './styles/hosts.css';
import './styles/terminal.css';
import './styles/files.css';

const pinia = createPinia();
const app = createApp(App);
app.use(pinia);
const store = useApplicationStore(pinia);
app.config.errorHandler = () => store.reportUnexpectedError();
window.addEventListener('unhandledrejection', () => store.reportUnexpectedError());
app.mount('#app');

import './styles/monitor.css';

import './styles/operations.css';

import './styles/product.css';
import './styles/controls.css';
import './styles/server.css';
