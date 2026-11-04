import { request } from '../transport';
import type { Catalog } from '../types/hosts';
export const hostsApi = { list: () => request<Catalog>('hosts.list') };
