import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ensureDesktop } from './ipc';

export const clipboardApi = {
  readText(): Promise<string> {
    ensureDesktop();
    return readText();
  },
  writeText(text: string): Promise<void> {
    ensureDesktop();
    return writeText(text);
  },
};
