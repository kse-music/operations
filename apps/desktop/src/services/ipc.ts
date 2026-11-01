import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AppConfig, Bootstrap } from '../types/ipc';

export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = error.message;
    if (typeof message === 'string') return message;
  }
  return '操作未完成，请重试并检查本地应用日志。';
}

export function ensureDesktop(): void {
  if (!isTauri()) {
    throw new Error(
      '当前为浏览器预览，未连接 Rust 后端。请使用 npm run tauri -- dev 启动桌面应用。',
    );
  }
}

export function bootstrap(): Promise<Bootstrap> {
  ensureDesktop();
  return invoke<Bootstrap>('app_bootstrap');
}

export function saveConfig(config: AppConfig): Promise<AppConfig> {
  ensureDesktop();
  return invoke<AppConfig>('config_save', { config });
}
