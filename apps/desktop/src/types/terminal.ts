import { tr } from '../i18n/messages';
export interface TerminalSize {
  cols: number;
  rows: number;
}
export interface TerminalScreen extends TerminalSize {
  cursorRow: number;
  cursorCol: number;
}
export interface TerminalUploadSelection {
  token: string;
  files: { name: string; size: number }[];
}
export interface TerminalDropSelection {
  token: string;
  names: string[];
}
export interface TerminalDropPrepared {
  size: number;
  sha256: string;
  command: string;
  nonce: string;
}
export type TerminalFileDrag =
  | { type: 'leave' }
  | { type: 'over'; x: number; y: number }
  | { type: 'drop'; x: number; y: number; grant: string; names: string[] }
  | { type: 'error'; x: number; y: number; message: string };
export interface TerminalSession {
  routeHostIds: string[];
  id: string;
  transportId: string;
  hostId: string;
}
export interface LocalTerminalSession {
  id: string;
  shell: string;
}
export type TerminalEvent =
  | { type: 'connection'; cipher: string }
  | { type: 'state'; state: string; code: string | null; message: string | null }
  | { type: 'trust'; hostname: string; port: number; algorithm: string; fingerprint: string }
  | { type: 'data'; sequence: number; data: number[] }
  | { type: 'exit'; status: number | null };
export const stateLabels: Record<string, string> = {
  get idle() {
    return tr('未连接');
  },
  get opening() {
    return tr('准备连接');
  },
  get connecting() {
    return tr('连接中');
  },
  get awaiting_trust() {
    return tr('等待指纹确认');
  },
  get authenticating() {
    return tr('认证中');
  },
  get connected() {
    return tr('已连接');
  },
  get closing() {
    return tr('正在关闭');
  },
  get closed() {
    return tr('已关闭');
  },
  get disconnected() {
    return tr('已断开连接');
  },
  get failed() {
    return tr('连接失败');
  },
};
