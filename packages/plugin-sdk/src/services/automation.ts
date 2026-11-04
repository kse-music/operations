import { request } from '../transport';
import type {
  Catalog,
  Entry,
  EntryInput,
  Group,
  RunInput,
  Run,
  RunSummary,
  State,
  Schedule,
  ScheduleInput,
  Status,
  Target,
} from '../types/automation';
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return request(command, args);
}
export const automationApi = {
  catalog: () => call<Catalog>('automation_catalog'),
  prepare: (entryId: string, revision: number, hostIds: string[]) =>
    call<[Entry, Target[]]>('automation_prepare', { entryId, revision, hostIds }),
  save: (id: string | null, revision: number | null, input: EntryInput) =>
    call<Entry>('automation_entry_save', { id, revision, input }),
  remove: (id: string, confirmed: boolean) =>
    call<void>('automation_entry_delete', { id, confirmed }),
  groupSave: (id: string | null, name: string) =>
    call<Group>('automation_group_save', { id, name }),
  groupRemove: (id: string, confirmed: boolean) =>
    call<void>('automation_group_delete', { id, confirmed }),
  start: (input: RunInput) => call<Run>('automation_start', { input }),
  run: (id: string) => call<Run>('automation_run', { id }),
  history: (
    query: {
      scheduleId?: string;
      before?: number;
      beforeId?: string;
      state?: State;
      search?: string;
    } = {},
  ) => call<RunSummary[]>('automation_history', { query }),
  cancel: (id: string, running: boolean) => call<void>('automation_cancel', { id, running }),
  approve: (id: string, confirmed: boolean, dangerConfirmed: boolean) =>
    call<Run>('automation_approve', { id, confirmed, dangerConfirmed }),
  scheduleSave: (id: string | null, revision: number | null, input: ScheduleInput) =>
    call<Schedule>('automation_schedule_save', { id, revision, input }),
  scheduleDisable: (id: string) => call<void>('automation_schedule_disable', { id }),
  scheduleRemove: (id: string, confirmed: boolean) =>
    call<void>('automation_schedule_delete', { id, confirmed }),
  status: () => call<Status>('automation_status'),
  runRemove: (id: string, confirmed: boolean) =>
    call<void>('automation_run_delete', { id, confirmed }),
};
