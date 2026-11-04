import { request } from '../transport';
export const terminalApi = {
  trust: (id: string, accept: boolean) => request<void>('connections.trust', { id, accept }),
};
