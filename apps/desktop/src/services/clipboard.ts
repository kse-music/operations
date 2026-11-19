import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ensureDesktop } from './ipc';

// The native plugin serializes arboard's ContentNotAvailable as a string without an error code.
const noTextError =
  'The clipboard contents were not available in the requested format or the clipboard is empty.';

export const clipboardApi = {
  readText(): Promise<string> {
    ensureDesktop();
    return readText().catch((cause: unknown) => {
      if (cause === noTextError) return '';
      throw cause;
    });
  },
  writeText(text: string): Promise<void> {
    ensureDesktop();
    return writeText(text);
  },
};
