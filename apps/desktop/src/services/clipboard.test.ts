import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ readText: vi.fn(), writeText: vi.fn(), desktop: vi.fn() }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: native.readText,
  writeText: native.writeText,
}));
vi.mock('./ipc', () => ({ ensureDesktop: native.desktop }));
import { clipboardApi } from './clipboard';

beforeEach(() => vi.resetAllMocks());

it('uses native text clipboard functions and preserves Unicode and multiline text', async () => {
  const text = '中文 🙂\r\nsecond line';
  native.readText.mockResolvedValueOnce(text);
  await expect(clipboardApi.readText()).resolves.toBe(text);
  await clipboardApi.writeText(text);
  expect(native.desktop).toHaveBeenCalledTimes(2);
  expect(native.readText).toHaveBeenCalledExactlyOnceWith();
  expect(native.writeText).toHaveBeenCalledExactlyOnceWith(text);
});

it('refuses browser preview instead of falling back to the web clipboard', () => {
  native.desktop.mockImplementation(() => {
    throw new Error('Desktop required');
  });
  expect(() => clipboardApi.readText()).toThrow('Desktop required');
  expect(() => clipboardApi.writeText('text')).toThrow('Desktop required');
  expect(native.readText).not.toHaveBeenCalled();
  expect(native.writeText).not.toHaveBeenCalled();
});

it('treats the native no-text error as an empty clipboard', async () => {
  native.readText.mockRejectedValueOnce(
    'The clipboard contents were not available in the requested format or the clipboard is empty.',
  );
  await expect(clipboardApi.readText()).resolves.toBe('');
});

it('propagates native clipboard failures to the caller', async () => {
  const failure = new Error('Clipboard unavailable');
  const readFailure = 'The native clipboard is not accessible due to being held by another party.';
  native.readText.mockRejectedValueOnce(readFailure);
  native.writeText.mockRejectedValueOnce(failure);
  await expect(clipboardApi.readText()).rejects.toBe(readFailure);
  await expect(clipboardApi.writeText('text')).rejects.toBe(failure);
});
