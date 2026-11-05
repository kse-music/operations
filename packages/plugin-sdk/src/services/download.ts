import { request } from '../transport';
export function downloadResult(name: string, value: unknown): void {
  void request('ui.export', { name, value });
}
