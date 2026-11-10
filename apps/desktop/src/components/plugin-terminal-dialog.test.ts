import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import PluginTerminalDialog from './PluginTerminalDialog.vue';
import { useTerminalsStore } from '../stores/terminals';
import { hostInput } from '../types/hosts';
import type { TerminalEvent } from '../types/terminal';
const api = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  input: vi.fn(),
  focus: vi.fn(),
  data: vi.fn() as (value: string) => void,
  clear: vi.fn(),
  fit: vi.fn(),
  find: vi.fn<(text: string) => boolean>(() => true),
  receive: vi.fn() as (event: TerminalEvent) => void,
}));
vi.mock('../services/plugins', () => ({ pluginsApi: { platformTerminalOpen: api.open } }));
vi.mock('../services/terminal', () => ({ terminalApi: { input: api.input, close: api.close } }));
vi.mock('../services/clipboard', () => ({
  clipboardApi: { readText: vi.fn(async () => 'clipboard text'), writeText: vi.fn() },
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    buffer = { active: { type: 'normal', baseY: 0, viewportY: 0 } };
    cols = 80;
    rows = 24;
    options = {};
    clear() {
      api.clear();
    }
    clearSelection() {}
    scrollToBottom() {}
    hasSelection() {
      return false;
    }
    parser = { registerOscHandler() {} };
    loadAddon() {}
    open() {}
    dispose() {}
    onResize() {}
    onBinary() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
    focus() {
      api.focus();
    }
    onData(callback: (value: string) => void) {
      api.data = callback;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      api.fit();
    }
  },
}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    clearDecorations() {}
    findNext(text: string) {
      return api.find(text);
    }
  },
}));
let app: App | undefined, pinia: Pinia, root: HTMLElement;
const closed = vi.fn();
const shell = {
  id: 'a'.repeat(64),
  bash: false,
  confirmed: false,
  pluginId: 'cn.hiboot.plugins.docker',
};
const host = {
  ...hostInput(),
  id: 'host',
  name: '测试服务器',
  hostname: '192.0.2.1',
  username: 'ops',
  createdAt: '',
  updatedAt: '',
};
const settle = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
  await nextTick();
};
beforeEach(() => {
  vi.clearAllMocks();
  api.close.mockResolvedValue(undefined);
  api.input.mockResolvedValue(undefined);
  api.open.mockImplementation(
    async (_id, _owner, _ticket, _host, _size, receive: (event: TerminalEvent) => void) => {
      api.receive = receive;
      receive({ type: 'state', state: 'connected', code: null, message: null });
      return {
        id: 'container-pty',
        hostId: 'host',
        transportId: 'transport',
        routeHostIds: ['host'],
      };
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(720);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
});
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await settle();
  if (pinia) disposePinia(pinia);
  root?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function mount() {
  pinia = createPinia();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(PluginTerminalDialog, {
    host,
    pluginId: shell.pluginId,
    owner: 'owner',
    ticket: 'opaque-ticket',
    presentation: { title: 'production-api', description: 'abcdef012345 · /bin/sh' },
    onClose: closed,
  }).use(pinia);
  app.mount(root);
  await settle();
}
it('opens the container PTY immediately inside its dialog, focuses input and keeps workspace terminals untouched', async () => {
  await mount();
  expect(api.open).toHaveBeenCalledWith(
    shell.pluginId,
    'owner',
    'opaque-ticket',
    'host',
    { cols: 80, rows: 24 },
    expect.any(Function),
  );
  expect(document.querySelector('.plugin-terminal [data-state="connected"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="确认运维目标"]')).toBeNull();
  expect(useTerminalsStore(pinia).tabs).toEqual([]);
  expect(api.focus).toHaveBeenCalled();
  api.data('whoami\r');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.input.mock.calls[0]![0]).toBe('container-pty');
  expect(Array.from(api.input.mock.calls[0]![1] as Uint8Array)).toEqual([
    ...new TextEncoder().encode('whoami\r'),
  ]);
  app!.unmount();
  app = undefined;
  await settle();
  expect(api.close).toHaveBeenCalledWith('container-pty');
});
it('closes a PTY which finishes opening after the dialog was dismissed', async () => {
  let finish!: (value: unknown) => void;
  api.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  expect(document.querySelector('.plugin-terminal-loading')?.textContent).toContain('正在建立');
  app!.unmount();
  app = undefined;
  finish({
    id: 'late-container-pty',
    hostId: 'host',
    transportId: 'transport',
    routeHostIds: ['host'],
  });
  await settle();
  expect(api.close).toHaveBeenCalledWith('late-container-pty');
});

async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  button!.click();
  await settle();
}
it('shows container context and trusted SSH identity, resizes and clears only the current display', async () => {
  await mount();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.querySelector('h2')?.textContent).toBe('production-api');
  expect(dialog.textContent).toContain('ops@192.0.2.1:22');
  expect(dialog.textContent).toContain('abcdef012345 · /bin/sh');
  expect(dialog.querySelector('.plugin-terminal-status')?.textContent).toContain('已连接');
  expect(dialog.querySelector('.plugin-terminal-loading')).toBeNull();
  await click('最大化终端窗口');
  expect(dialog.classList.contains('is-expanded')).toBe(true);
  await click('还原终端窗口');
  expect(dialog.classList.contains('is-expanded')).toBe(false);
  await click('放大终端字号');
  expect(dialog.querySelector('.plugin-terminal-font')?.textContent).toContain('17');
  await click('重置终端字号');
  expect(dialog.querySelector('.plugin-terminal-font')?.textContent).toContain('16');
  await click('清空终端显示');
  expect(api.clear).toHaveBeenCalledOnce();
  expect(api.open).toHaveBeenCalledOnce();
  expect(api.input).not.toHaveBeenCalled();
  expect(api.close).not.toHaveBeenCalled();
  expect(api.focus).toHaveBeenCalled();
});
it('supports search, Escape, Ctrl+wheel and the clipboard menu inside its own dialog', async () => {
  await mount();
  document.querySelector<HTMLButtonElement>('.plugin-terminal-find')!.click();
  await settle();
  const input = document.querySelector<HTMLInputElement>('[aria-label="终端查找内容"]')!;
  expect(document.activeElement).toBe(input);
  input.value = 'error';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(api.find).toHaveBeenCalledWith('error');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  expect(document.querySelector('.terminal-find')).toBeNull();
  const area = document.querySelector('.xterm-container')!;
  area.dispatchEvent(
    new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, bubbles: true, cancelable: true }),
  );
  await settle();
  expect(document.querySelector('.plugin-terminal-font')?.textContent).toContain('17');
  area.dispatchEvent(
    new MouseEvent('contextmenu', { button: 2, clientX: 80, clientY: 120, bubbles: true }),
  );
  await settle();
  expect(document.querySelector('dialog [role="menu"]')).not.toBeNull();
  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
  await click('关闭终端菜单');
  const nested = document.createElement('dialog');
  nested.open = true;
  document.body.append(nested);
  area.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, bubbles: true }));
  area.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true }));
  await settle();
  expect(document.querySelector('.plugin-terminal-font')?.textContent).toContain('17');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  nested.remove();
});
it('shows an ended session without consuming its one-use ticket again', async () => {
  await mount();
  api.receive({ type: 'state', state: 'disconnected', code: null, message: 'SSH 连接中断' });
  await settle();
  expect(document.querySelector('.plugin-terminal-status')?.textContent).toContain('已断开');
  expect(document.querySelector('.plugin-terminal-ended')?.textContent).toContain('SSH 连接中断');
  expect(api.open).toHaveBeenCalledOnce();
  await click('关闭终端');
  expect(closed).toHaveBeenCalledOnce();
});
it('reports opening failure and keeps a close action available', async () => {
  api.open.mockRejectedValueOnce(new Error('容器未运行'));
  await mount();
  expect(document.querySelector('.plugin-terminal-status')?.textContent).toContain('连接失败');
  expect(document.querySelector('.plugin-terminal-ended')?.textContent).toContain('容器未运行');
  expect(document.querySelector('.plugin-terminal-loading')).toBeNull();
  await click('关闭终端');
  expect(closed).toHaveBeenCalledOnce();
});
it('bounds local font scaling to 10–32 without changing the PTY', async () => {
  await mount();
  for (let i = 0; i < 30; i++) await click('缩小终端字号');
  expect(document.querySelector('.plugin-terminal-font')?.textContent).toContain('10');
  expect(document.querySelector<HTMLButtonElement>('[aria-label="缩小终端字号"]')?.disabled).toBe(
    true,
  );
  for (let i = 0; i < 30; i++) await click('放大终端字号');
  expect(document.querySelector('.plugin-terminal-font')?.textContent).toContain('32');
  expect(document.querySelector<HTMLButtonElement>('[aria-label="放大终端字号"]')?.disabled).toBe(
    true,
  );
  expect(api.open).toHaveBeenCalledOnce();
  expect(api.input).not.toHaveBeenCalled();
});
