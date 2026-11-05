import { request } from '../transport';
import type { DiagnosticInput, Diagnostic } from '../types/tasks';
function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return request(name, args);
}
export const tasksApi = {
  start: (input: DiagnosticInput) => call<Diagnostic>('diagnostic_start', { input }),
  diagnostics: (versions: Record<string, number> = {}) =>
    call<Diagnostic[]>('diagnostic_list', { versions }),
  stop: (id: string) => call<void>('diagnostic_cancel', { id }),
};
export function downloadResult(name: string, value: unknown): void {
  void request('ui.export', { name, value });
}
