import { tr } from './i18n/messages';
export type ServerSection = 'containers' | 'images' | 'compose';
export const serverSections = [
  {
    key: 'containers',
    get label() {
      return tr('容器');
    },
  },
  {
    key: 'images',
    get label() {
      return tr('镜像');
    },
  },
  {
    key: 'compose',
    get label() {
      return tr('Compose 项目');
    },
  },
];
export type OpsRequest =
  | { kind: 'capabilities' | 'containers' | 'images' | 'compose_projects' }
  | { kind: 'compose_services'; project: string }
  | {
      kind: 'compose_action';
      project: string;
      action: 'start' | 'stop' | 'restart';
      confirmed: boolean;
    }
  | { kind: 'container_details'; id: string; revealEnv: boolean }
  | { kind: 'container_stats'; id: string }
  | { kind: 'container_startup'; id: string; revealEnv: boolean; inspectOnly: boolean }
  | {
      kind: 'container_maintenance';
      action: 'restart_exited' | 'clear_logs';
      confirmed: boolean;
    }
  | {
      kind: 'container_action';
      id: string;
      action: 'start' | 'stop' | 'restart' | 'remove';
      confirmed: boolean;
    }
  | { kind: 'image_remove'; id: string; confirmed: boolean };
export interface OpsResponse {
  success: boolean;
  code: string | null;
  message: string | null;
  records: Record<string, unknown>[];
  detail: Record<string, unknown> | null;
}
export interface LogInput {
  source: { kind: 'container'; id: string } | { kind: 'compose'; project: string };
  lines: number;
  follow: boolean;
}
