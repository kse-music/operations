import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import TerminalStatus from './TerminalStatus.vue';
import type { TerminalPaneModel } from '../stores/terminals';
import { hostInput } from '../types/hosts';

let app: App, root: HTMLDivElement, pane: TerminalPaneModel;
beforeEach(() => {
  pane = reactive({
    key: 'pane',
    host: { ...hostInput(), id: 'host', name: 'Test', createdAt: '', updatedAt: '' },
    state: 'connected',
    connectRequested: false,
    cipher: 'aes256-ctr',
    screen: { rows: 53, cols: 142, cursorRow: 17, cursorCol: 10 },
  });
  root = document.createElement('div');
  document.body.append(root);
  app = createApp({ setup: () => () => h(TerminalStatus, { pane }) });
  app.mount(root);
});
afterEach(() => {
  app.unmount();
  root.remove();
});

it('shows the actual cipher, cursor, dimensions and emulation, then follows screen updates', async () => {
  expect(root.textContent).toContain('SSH2 · aes256-ctr');
  expect(root.textContent).toContain('光标 17:10');
  expect(root.textContent).toContain('53 行 × 142 列');
  expect(root.textContent).toContain('xterm-256color');
  pane.cipher = 'chacha20-poly1305@openssh.com';
  pane.screen = { rows: 24, cols: 80, cursorRow: 1, cursorCol: 80 };
  await nextTick();
  expect(root.textContent).toContain('SSH2 · chacha20-poly1305@openssh.com');
  expect(root.textContent).toContain('光标 1:80');
  expect(root.textContent).toContain('24 行 × 80 列');
});

it('shows connection progress and failure without presenting a stale cipher as active', async () => {
  for (const [state, label] of [
    ['opening', '准备连接'],
    ['awaiting_trust', '等待指纹确认'],
    ['failed', '连接失败'],
    ['disconnected', '已断开连接'],
    ['closed', '已关闭'],
  ]) {
    pane.state = state!;
    await nextTick();
    expect(root.textContent).toContain(label);
    expect(root.textContent).not.toContain('aes256-ctr');
  }
  pane.state = 'connected';
  pane.cipher = undefined;
  await nextTick();
  expect(root.textContent).toContain('SSH2 · 加密算法读取中');
});

it('uses the actual local shell instead of SSH connection metadata', async () => {
  pane.host = null;
  pane.shell = 'PowerShell';
  await nextTick();
  expect(root.textContent).toContain('PowerShell');
  expect(root.textContent).not.toContain('SSH2');
  pane.shell = '/bin/zsh';
  await nextTick();
  expect(root.textContent).toContain('/bin/zsh');
});

it('tracks keyboard lock states without consuming keys and invalidates them after focus changes', async () => {
  expect(root.textContent).toContain('CAP ?');
  expect(root.textContent).toContain('NUM ?');
  const down = new KeyboardEvent('keydown', {
    key: 'a',
    modifierCapsLock: true,
    modifierNumLock: false,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(down);
  await nextTick();
  expect(down.defaultPrevented).toBe(false);
  expect(root.querySelector('[aria-label="大写锁定：开启"]')?.classList.contains('locked')).toBe(
    true,
  );
  expect(root.querySelector('[aria-label="数字锁定：关闭"]')?.classList.contains('locked')).toBe(
    false,
  );
  window.dispatchEvent(
    new KeyboardEvent('keyup', { modifierCapsLock: false, modifierNumLock: true }),
  );
  await nextTick();
  expect(root.querySelector('[aria-label="数字锁定：开启"]')?.classList.contains('locked')).toBe(
    true,
  );
  window.dispatchEvent(new Event('blur'));
  await nextTick();
  expect(root.textContent).toContain('CAP ?');
  expect(root.textContent).toContain('NUM ?');
  window.dispatchEvent(new Event('focus'));
  await nextTick();
  expect(root.querySelectorAll('[aria-label$="未知（等待键盘输入）"]')).toHaveLength(2);
});
