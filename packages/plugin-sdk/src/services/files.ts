import { request } from '../transport';
export const filesApi = {
  pick: (kind: 'files') => request<string[]>('files.pick', { kind }),
};
