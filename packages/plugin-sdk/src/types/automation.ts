export type Risk = 'normal' | 'dangerous';
export type ParameterKind = 'text' | 'integer' | 'port' | 'path' | 'host';
export interface Parameter {
  name: string;
  label: string;
  kind: ParameterKind;
  required: boolean;
  secret: boolean;
  default: string | null;
}
export interface EntryInput {
  kind: 'command' | 'script';
  name: string;
  body: string;
  description: string;
  groupId: string | null;
  favorite: boolean;
  risk: Risk;
  parameters: Parameter[];
  timeoutSecs: number;
  concurrency: number;
  retainOutput: boolean;
}
export interface Entry extends EntryInput {
  id: string;
  revision: number;
  updatedAt: number;
}
export interface Group {
  id: string;
  name: string;
}
export interface Target {
  hostId: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  routeSignature: string;
}
export type State = 'Pending' | 'Running' | 'Success' | 'Failed' | 'Cancelled' | 'Unknown';
export interface RunInput {
  entryId: string;
  expectedRevision: number;
  hostIds: string[];
  expectedProfiles: Record<string, string>;
  parameters: Record<string, string>;
  concurrency: number;
  timeoutSecs: number;
  confirmed: boolean;
  dangerConfirmed: boolean;
}
export interface RunSpec {
  entry: Entry;
  targets: Target[];
  parameters: Record<string, string>;
  hasSecrets: boolean;
  concurrency: number;
  timeoutSecs: number;
}
export interface RunRow {
  hostId: string;
  state: State;
  stdout: string;
  stderr: string;
  droppedBytes: number;
  exitCode: number | null;
  message: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}
export interface Run {
  id: string;
  spec: RunSpec;
  scheduleId: string | null;
  scheduledFor: number | null;
  trigger: string;
  state: State;
  approvalRequired: boolean;
  message: string | null;
  createdAt: number;
  finishedAt: number | null;
  revision: number;
  rows: RunRow[];
}
export interface RunSummary {
  id: string;
  entryName: string;
  state: State;
  approvalRequired: boolean;
  trigger: string;
  scheduleId: string | null;
  createdAt: number;
  finishedAt: number | null;
  targets: number;
  message: string | null;
}
export type Timing =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'cron'; expression: string };
export interface Schedule {
  id: string;
  revision: number;
  name: string;
  spec: RunSpec;
  timing: Timing;
  offsetMinutes: number;
  missedPolicy: 'skip' | 'ask';
  enabled: boolean;
  nextAt: number;
  lastMessage: string | null;
}
export interface ScheduleInput {
  name: string;
  entryId: string;
  expectedEntryRevision: number;
  hostIds: string[];
  expectedProfiles: Record<string, string>;
  parameters: Record<string, string>;
  timing: Timing;
  offsetMinutes: number;
  missedPolicy: 'skip' | 'ask';
  enabled: boolean;
  authorized: boolean;
}
export interface Catalog {
  entries: Entry[];
  groups: Group[];
  schedules: Schedule[];
  templates: EntryInput[];
}
export interface Status {
  active: number;
  awaiting: number;
  latestFailure: RunSummary | null;
  schedules: Pick<Schedule, 'id' | 'revision' | 'enabled' | 'nextAt' | 'lastMessage'>[];
  schedulerError: string | null;
}
export const labels: Record<State, string> = {
  Pending: '待执行',
  Running: '执行中',
  Success: '成功',
  Failed: '失败',
  Cancelled: '已取消',
  Unknown: '结果未知',
};
export const finished = (s: State) => !['Pending', 'Running'].includes(s);
export function entryInput(e?: EntryInput): EntryInput {
  return e
    ? {
        kind: e.kind,
        name: e.name,
        body: e.body,
        description: e.description,
        groupId: e.groupId,
        favorite: e.favorite,
        risk: e.risk,
        parameters: e.parameters.map((p) => ({ ...p })),
        timeoutSecs: e.timeoutSecs,
        concurrency: e.concurrency,
        retainOutput: e.retainOutput,
      }
    : {
        kind: 'command',
        name: '',
        body: '',
        description: '',
        groupId: null,
        favorite: false,
        risk: 'normal',
        parameters: [],
        timeoutSecs: 30,
        concurrency: 3,
        retainOutput: false,
      };
}
export function offsetLabel(minutes: number): string {
  return `UTC${minutes < 0 ? '−' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
}
