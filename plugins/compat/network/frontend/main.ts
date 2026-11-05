import { mountPlugin } from '@serverdeck/plugin-sdk/runtime';
import App from '../../../system/services/frontend/network/NetworkView.vue';
import '@serverdeck/plugin-sdk/ui/base.css';
mountPlugin(App);
