import type { ConflictPolicy, TransferInfo } from './files';
export type Tool =
  'ping' | 'tcp' | 'dns' | 'traceroute' | 'mtr' | 'interfaces' | 'connections' | 'ssh_latency';
export type Origin = { kind: 'local' } | { kind: 'remote'; hostId: string; sessionId: string };
export interface DiagnosticInput {
  tool: Tool;
  origin: Origin;
  target: string;
  port: number;
  count: number;
  timeoutSecs: number;
}
export interface Diagnostic {
  id: string;
  input: DiagnosticInput;
  state: string;
  output: string;
  droppedBytes: number;
  exitCode: number | null;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
  revision: number;
}
export interface Target {
  hostId: string;
  sessionId: string | null;
}
export type BatchOperation =
  | { kind: 'command'; command: string }
  | {
      kind: 'file';
      source: string;
      destination: string;
      conflict: ConflictPolicy;
      confirmOverwrite: boolean;
    };
export interface BatchInput {
  targets: Target[];
  operation: BatchOperation;
  concurrency: number;
  timeoutSecs: number;
  confirmed: boolean;
}
export interface BatchRow {
  hostId: string;
  sessionId: string | null;
  state: string;
  stdout: string;
  stderr: string;
  droppedBytes: number;
  exitCode: number | null;
  message: string | null;
  transfer: TransferInfo | null;
  startedAt: number | null;
  finishedAt: number | null;
}
export interface Batch {
  id: string;
  input: BatchInput;
  rows: BatchRow[];
  finished: boolean;
  createdAt: number;
  revision: number;
}
export const taskLabels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  uncertain: '结果未确认',
  cancelled: '已取消',
  timed_out: '超时',
};
export const active = (state: string): boolean => state === 'queued' || state === 'running';
