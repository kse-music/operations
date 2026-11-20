import type { EnvironmentTag } from './hosts';

export interface BatchCommandInput {
  name: string;
  command: string;
  hostIds: string[];
  concurrency: number;
}

export interface BatchCommand extends BatchCommandInput {
  id: string;
  revision: number;
}

export interface BatchRequest {
  commandId: string;
  revision: number;
  retryHostIds?: string[];
}

export interface BatchTarget {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  environment: EnvironmentTag | null;
}

export interface BatchPreview {
  token: string;
  command: BatchCommand;
  concurrency: number;
  targets: BatchTarget[];
}

export type BatchStatus =
  | 'queued'
  | 'connecting'
  | 'running'
  | 'succeeded'
  | 'connectionFailed'
  | 'commandFailed'
  | 'unknown'
  | 'notSent';

export interface BatchResult {
  target: BatchTarget;
  status: BatchStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  message: string | null;
}

export interface BatchRun {
  id: string;
  revision: number;
  command: BatchCommand;
  finished: boolean;
  stopping: boolean;
  results: BatchResult[];
}
