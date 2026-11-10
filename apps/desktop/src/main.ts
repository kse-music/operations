import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { useApplicationStore } from './stores/application';
import './styles/main.css';
import './styles/hosts.css';
import './styles/terminal.css';
import './styles/files.css';

const pinia = createPinia();
const editorWindow = new URLSearchParams(window.location.search).has('remote-editor');
const Root = editorWindow
  ? (await import('./EditorWindow.vue')).default
  : (await import('./App.vue')).default;
const app = createApp(Root);
app.use(pinia);
const store = useApplicationStore(pinia);
app.config.errorHandler = () => store.reportUnexpectedError();
window.addEventListener('unhandledrejection', () => store.reportUnexpectedError());
app.mount('#app');

import './styles/operations.css';

import './styles/product.css';
import './styles/controls.css';
import './styles/server.css';
import './styles/settings.css';
import './styles/assets.css';
