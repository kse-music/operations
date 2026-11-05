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
