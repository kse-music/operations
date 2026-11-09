import { mountPlugin } from '@serverdeck/plugin-sdk/runtime';
import App from './App.vue';
import '@serverdeck/plugin-sdk/ui/base.css';
import './nginx.css';
mountPlugin(App);
