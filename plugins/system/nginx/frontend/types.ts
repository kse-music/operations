export type ServiceTarget = { kind: 'host' } | { kind: 'container'; id: string };
export type NginxAction = 'info' | 'test' | 'reload';
export interface OpsResponse {
  success: boolean;
  code: string | null;
  message: string | null;
  records: Record<string, unknown>[];
  detail: Record<string, unknown> | null;
}
