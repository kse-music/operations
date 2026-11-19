import { tr } from '../i18n/messages';

export const minInterfaceFontSize = 95;
export const defaultInterfaceFontSize = 100;
export const maxInterfaceFontSize = 145;

export const interfaceFontSizes = [
  {
    percent: minInterfaceFontSize,
    get label() {
      return tr('小');
    },
  },
  {
    percent: defaultInterfaceFontSize,
    get label() {
      return tr('标准');
    },
  },
  {
    percent: 115,
    get label() {
      return tr('大');
    },
  },
  {
    percent: 130,
    get label() {
      return tr('特大');
    },
  },
  {
    percent: maxInterfaceFontSize,
    get label() {
      return tr('超大');
    },
  },
] as const;

export interface TerminalPreferences {
  fontFamily: string;
  lineHeight: number;
  scrollback: number;
  theme: 'deck' | 'light' | 'nord' | 'solarized';
  cursorStyle: 'block' | 'bar' | 'underline';
  quickCopyPaste: boolean;
  autoRunSavedCommand: boolean;
  pasteConfirmChars: number;
  shortcuts: Record<string, string>;
}
export const defaultTerminalPreferences = (): TerminalPreferences => ({
  fontFamily: 'Cascadia Mono, Consolas, monospace',
  lineHeight: 100,
  scrollback: 5000,
  theme: 'deck',
  cursorStyle: 'block',
  quickCopyPaste: false,
  autoRunSavedCommand: false,
  pasteConfirmChars: 4096,
  shortcuts: {
    copy: 'Ctrl+Shift+C',
    paste: 'Ctrl+Shift+V',
    find: 'Ctrl+Shift+F',
    splitRows: 'Ctrl+Shift+H',
    splitColumns: 'Ctrl+Shift+L',
    newTab: 'Ctrl+Shift+T',
    closePane: 'Ctrl+Shift+W',
    nextTab: 'Ctrl+Shift+Right',
    previousTab: 'Ctrl+Shift+Left',
    zoomIn: 'Ctrl+Shift+=',
    zoomOut: 'Ctrl+Shift+-',
  },
});
export const shortcutLabels: Record<string, string> = {
  get copy() {
    return tr('复制');
  },
  get paste() {
    return tr('粘贴');
  },
  get find() {
    return tr('查找');
  },
  get splitRows() {
    return tr('水平分屏（上下）');
  },
  get splitColumns() {
    return tr('垂直分屏（左右）');
  },
  get newTab() {
    return tr('新建终端会话');
  },
  get closePane() {
    return tr('关闭窗格');
  },
  get nextTab() {
    return tr('下一个会话');
  },
  get previousTab() {
    return tr('上一个会话');
  },
  get zoomIn() {
    return tr('放大字体');
  },
  get zoomOut() {
    return tr('缩小字体');
  },
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
