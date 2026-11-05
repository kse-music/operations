import { invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type { DiagnosticInput, Diagnostic } from '../types/tasks';
function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  ensureDesktop();
  return invoke(name, args);
}
export const tasksApi = {
  start: (input: DiagnosticInput) => call<Diagnostic>('diagnostic_start', { input }),
  diagnostics: (versions: Record<string, number> = {}) =>
    call<Diagnostic[]>('diagnostic_list', { versions }),
  stop: (id: string) => call<void>('diagnostic_cancel', { id }),
};
export function downloadResult(name: string, value: unknown): void {
  const url = URL.createObjectURL(
    new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], {
      type: 'text/plain;charset=utf-8',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
