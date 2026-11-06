import { invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type { BackgroundSnapshot } from '../types/product';

export const productApi = {
  tasks: () => {
    ensureDesktop();
    return invoke<BackgroundSnapshot>('background_tasks');
  },
};
