import { onBeforeUnmount, onMounted, ref } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, type Window } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { tr } from '../i18n/messages';
import { errorMessage } from '../services/ipc';
import { useNotificationsStore } from '../stores/notifications';

export function useWindowControls() {
  const nativeWindow = isTauri() ? getCurrentWindow() : undefined;
  const maximized = ref(false);
  const notifications = useNotificationsStore();
  let disposed = false;
  let releaseResize: UnlistenFn | undefined;

  async function run(action: (window: Window) => Promise<unknown>): Promise<void> {
    if (!nativeWindow) return;
    try {
      await action(nativeWindow);
    } catch (cause) {
      if (!disposed) notifications.push(tr('窗口操作失败：{0}', errorMessage(cause)), true);
    }
  }

  async function syncMaximized(): Promise<void> {
    await run(async (window) => {
      const value = await window.isMaximized();
      if (!disposed) maximized.value = value;
    });
  }

  onMounted(async () => {
    await run(async (window) => {
      const release = await window.onResized(() => void syncMaximized());
      if (disposed) release();
      else releaseResize = release;
    });
    if (!disposed) await syncMaximized();
  });
  onBeforeUnmount(() => {
    disposed = true;
    releaseResize?.();
  });

  return {
    available: nativeWindow !== undefined,
    maximized,
    minimize: () => run((window) => window.minimize()),
    toggleMaximize: () =>
      run(async (window) => {
        await window.toggleMaximize();
        await syncMaximized();
      }),
    // close() requests CloseRequested; Rust retains exit review and resource cleanup.
    close: () => run((window) => window.close()),
  };
}
