import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import * as ipc from './ipc';
import { resolveTheme } from '../composables/theme';

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  Reflect.deleteProperty(window, 'isTauri');
});

describe('IPC boundary', () => {
  it('browser preview fails explicitly rather than fabricating backend state', () => {
    expect(() => ipc.bootstrap()).toThrow('未连接 Rust 后端');
    expect(() => ipc.saveConfig({} as never)).toThrow('未连接 Rust 后端');
  });

  it('invokes the real command name and preserves backend errors', async () => {
    Reflect.set(window, 'isTauri', true);
    mockIPC((command) => {
      expect(command).toBe('app_bootstrap');
      throw { code: 'STORAGE', message: '本地存储操作失败' };
    });
    await expect(ipc.bootstrap()).rejects.toEqual({ code: 'STORAGE', message: '本地存储操作失败' });
  });

  it('does not stringify arbitrary sensitive error payloads', () => {
    expect(ipc.errorMessage({ password: 'secret' })).not.toContain('secret');
  });
});

describe('theme resolution', () => {
  it('honors an explicit theme and follows system preferences only on request', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
