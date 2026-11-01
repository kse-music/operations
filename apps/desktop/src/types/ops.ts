import type { TerminalEvent, TerminalSession } from './terminal';
import type { Host } from './hosts';
export type Scope = 'system' | 'user';
export type ContainerAction = 'start' | 'stop' | 'restart' | 'remove';
export type ServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable';
export type ProcessSignal = 'TERM' | 'KILL' | 'INT' | 'HUP';
export type OpsRequest =
  | { kind: 'capabilities' | 'containers' | 'images' | 'processes' | 'ports' }
  | { kind: 'container_details'; id: string; revealEnv: boolean; confirmed: boolean }
  | { kind: 'container_stats'; id: string }
  | { kind: 'container_action'; id: string; action: ContainerAction; confirmed: boolean }
  | { kind: 'image_remove'; id: string; confirmed: boolean }
  | { kind: 'process_details'; pid: number }
  | {
      kind: 'signal';
      pid: number;
      startTicks: string;
      bootId: string;
      signal: ProcessSignal;
      confirmed: boolean;
    }
  | { kind: 'services'; scope: Scope }
  | { kind: 'service_details'; scope: Scope; unit: string }
  | {
      kind: 'service_action';
      scope: Scope;
      unit: string;
      action: ServiceAction;
      confirmed: boolean;
    }
  | { kind: 'probe'; location: 'local' | 'remote'; target: string; port: number };
export interface OpsResponse {
  success: boolean;
  code: string | null;
  message: string | null;
  records: Record<string, unknown>[];
  detail: Record<string, unknown> | null;
}
export type LogSource =
  | { kind: 'container'; id: string }
  | { kind: 'file'; path: string }
  | { kind: 'service'; scope: Scope; unit: string };
export interface LogInput {
  source: LogSource;
  lines: number;
  follow: boolean;
}
export interface LogSession {
  id: string;
  sessionId: string;
  hostId: string;
}
export type LogEvent =
  | { type: 'state'; state: string; code: string | null; message: string | null }
  | { type: 'data'; sequence: number; stream: string; data: number[]; at: number };
export interface ContainerShell {
  id: string;
  bash: boolean;
  confirmed: boolean;
}
export interface Feedback {
  at: number;
  hostId: string;
  operation: string;
  target: string;
  outcome: string;
}
export interface OpsConnection {
  host: Host;
  session?: TerminalSession;
  state: string;
  error: string | null;
  trust: Extract<TerminalEvent, { type: 'trust' }> | null;
}
