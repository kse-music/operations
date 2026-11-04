import { request } from '../transport';
export const clipboardApi = {
  writeText: (text: string) => request<void>('clipboard.write', { text }),
};
