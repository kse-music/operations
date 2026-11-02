export interface TerminalSize {
  cols: number;
  rows: number;
}
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
  | { type: 'state'; state: string; code: string | null; message: string | null }
  | { type: 'trust'; hostname: string; port: number; algorithm: string; fingerprint: string }
  | { type: 'data'; sequence: number; data: number[] }
  | { type: 'exit'; status: number | null };
export const stateLabels: Record<string, string> = {
  idle: '等待手动连接',
  opening: '准备连接',
  connecting: '连接中',
  awaiting_trust: '等待指纹确认',
  authenticating: '认证中',
  connected: '已连接',
  closed: '已关闭',
  failed: '连接失败',
};
