import { request } from './transport';
/** Stop this page's current action; other plugin pages keep their work. */
export function cancelCurrent(): Promise<void> {
  return request<void>('actions.cancel');
}
