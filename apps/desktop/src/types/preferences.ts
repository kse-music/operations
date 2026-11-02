export interface TerminalPreferences {
  fontFamily: string;
  lineHeight: number;
  scrollback: number;
  theme: 'deck' | 'light' | 'nord' | 'solarized';
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  quickCopyPaste: boolean;
  pasteConfirmChars: number;
  shortcuts: Record<string, string>;
}
export const defaultTerminalPreferences = (): TerminalPreferences => ({
  fontFamily: 'Cascadia Mono, Consolas, monospace',
  lineHeight: 100,
  scrollback: 5000,
  theme: 'deck',
  cursorStyle: 'block',
  cursorBlink: true,
  quickCopyPaste: false,
  pasteConfirmChars: 4096,
  shortcuts: {
    copy: 'Ctrl+Shift+C',
    paste: 'Ctrl+Shift+V',
    find: 'Ctrl+Shift+F',
    splitRows: 'Ctrl+Shift+H',
    splitColumns: 'Ctrl+Shift+E',
    newTab: 'Ctrl+Shift+T',
    closePane: 'Ctrl+Shift+W',
    nextTab: 'Ctrl+Shift+Right',
    previousTab: 'Ctrl+Shift+Left',
    zoomIn: 'Ctrl+Shift+=',
    zoomOut: 'Ctrl+Shift+-',
  },
});
export const shortcutLabels: Record<string, string> = {
  copy: '复制',
  paste: '粘贴',
  find: '查找',
  splitRows: '水平分屏（上下）',
  splitColumns: '垂直分屏（左右）',
  newTab: '新建同主机标签',
  closePane: '关闭窗格',
  nextTab: '下一个标签',
  previousTab: '上一个标签',
  zoomIn: '放大字体',
  zoomOut: '缩小字体',
};
const keyNames: Record<string, string> = {
  Equal: '=',
  Minus: '-',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
};
export function shortcutKey(event: KeyboardEvent): string | null {
  const key = event.code.startsWith('Key')
    ? event.code.slice(3)
    : event.code.startsWith('Digit')
      ? event.code.slice(5)
      : keyNames[event.code];
  if (!key) return null;
  const mods = [
    event.ctrlKey ? 'Ctrl' : null,
    event.metaKey ? 'Meta' : null,
    event.altKey ? 'Alt' : null,
    event.shiftKey ? 'Shift' : null,
  ].filter(Boolean);
  return [...mods, key].join('+');
}
export const terminalThemes = {
  deck: {
    background: '#10141c',
    foreground: '#dbe4f0',
    cursor: '#8baeff',
    selectionBackground: '#385078',
  },
  light: {
    background: '#fafafa',
    foreground: '#222b38',
    cursor: '#1558ad',
    selectionBackground: '#bfd3ef',
  },
  nord: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#88c0d0',
    selectionBackground: '#4c566a',
  },
  solarized: {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#b58900',
    selectionBackground: '#073642',
  },
};
