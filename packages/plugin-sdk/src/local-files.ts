import { request } from './transport';

/** Opens the trusted desktop picker; selecting a path does not start a transfer. */
export function pickLocalFiles(kind: 'files' | 'folder'): Promise<string[]> {
  return request('localFiles.pick', { kind });
}
