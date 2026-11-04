import { request } from '../transport';
import type { DiagnosticInput, Diagnostic, BatchInput, Batch } from '../types/tasks';
function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return request(name, args);
}
export const tasksApi = {
  start: (input: DiagnosticInput) => call<Diagnostic>('diagnostic_start', { input }),
  diagnostics: (versions: Record<string, number> = {}) =>
    call<Diagnostic[]>('diagnostic_list', { versions }),
  stop: (id: string) => call<void>('diagnostic_cancel', { id }),
  batch: (input: BatchInput) => call<Batch>('batch_start', { input }),
  batches: (versions: Record<string, number> = {}) => call<Batch[]>('batch_list', { versions }),
  cancel: (id: string, running = false) => call<void>('batch_cancel', { id, running }),
  retryFile: (id: string, hostId: string, sessionId: string, confirmed: boolean) =>
    call<Batch>('batch_retry_file', { id, hostId, sessionId, confirmed }),
};
export function downloadResult(name: string, value: unknown): void {
  void request('ui.export', { name, value });
}
