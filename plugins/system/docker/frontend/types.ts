export type ServerSection = 'containers' | 'images';
export const serverSections = [
  { key: 'containers', label: '容器' },
  { key: 'images', label: '镜像' },
];
export type ContainerShell = { id: string; bash: boolean; confirmed: boolean };
export type OpsRequest =
  | { kind: 'capabilities' | 'containers' | 'images' }
  | { kind: 'container_details'; id: string; revealEnv: boolean; confirmed: boolean }
  | { kind: 'container_stats'; id: string }
  | {
      kind: 'container_action';
      id: string;
      action: 'start' | 'stop' | 'restart' | 'remove';
      confirmed: boolean;
    }
  | { kind: 'image_remove'; id: string; confirmed: boolean }
  | { kind: 'probe'; location: 'local' | 'remote'; target: string; port: number };
export interface OpsResponse {
  success: boolean;
  code: string | null;
  message: string | null;
  records: Record<string, unknown>[];
  detail: Record<string, unknown> | null;
}
export interface Feedback {
  at: number;
  hostId: string;
  operation: string;
  target: string;
  outcome: string;
}
export interface LogInput {
  source: { kind: 'container'; id: string };
  lines: number;
  follow: boolean;
}
