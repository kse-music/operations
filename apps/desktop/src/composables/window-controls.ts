import { onBeforeUnmount, onMounted, ref } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, type Window } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { tr } from '../i18n/messages';
import { errorMessage } from '../services/ipc';
import { useNotificationsStore } from '../stores/notifications';

export function useWindowControls() {
  const desktop = isTauri();
  const macosTitlebar = desktop && navigator.platform.startsWith('Mac');
  const nativeWindow = desktop ? getCurrentWindow() : undefined;
  const maximized = ref(false);
  const fullscreen = ref(false);
  const notifications = useNotificationsStore();
  let disposed = false;
  let latestStateQuery = 0;
  let releaseResize: UnlistenFn | undefined;

  async function run(action: (window: Window) => Promise<unknown>): Promise<void> {
    if (!nativeWindow) return;
    try {
      await action(nativeWindow);
    } catch (cause) {
      if (!disposed) notifications.push(tr('窗口操作失败：{0}', errorMessage(cause)), true);
    }
  }

  async function syncWindowState(): Promise<void> {
    const query = ++latestStateQuery;
    await run(async (window) => {
      const value = await (macosTitlebar ? window.isFullscreen() : window.isMaximized());
      if (disposed || query !== latestStateQuery) return;
      if (macosTitlebar) fullscreen.value = value;
      else maximized.value = value;
    });
  }

  onMounted(async () => {
    if (!nativeWindow) return;
    await run(async (window) => {
      const release = await window.onResized(() => void syncWindowState());
      if (disposed) release();
      else releaseResize = release;
    });
    if (!disposed) await syncWindowState();
  });
  onBeforeUnmount(() => {
    disposed = true;
    releaseResize?.();
  });

  return {
    available: desktop && !macosTitlebar,
    macosTitlebar,
    maximized,
    fullscreen,
    minimize: () => run((window) => window.minimize()),
    toggleMaximize: () =>
      run(async (window) => {
        await window.toggleMaximize();
        await syncWindowState();
      }),
    // close() requests CloseRequested; Rust retains exit review and resource cleanup.
    close: () => run((window) => window.close()),
  };
}
