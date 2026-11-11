export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Command {
  program: string;
  args: string[];
  timeoutSecs: number;
}
export interface CommandResult {
  state: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  message: string | null;
}
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export type TransferSource =
  { kind: 'local'; path: string } | { kind: 'remote'; hostId: string; path: string };
export interface RemotePath {
  hostId: string;
  path: string;
}
export interface TransferPreview {
  id: string;
  source: TransferSource;
  destination: RemotePath;
  bytes: number;
  overwrite: boolean;
  targetExists: boolean;
}
export interface TransferState {
  id: string;
  state: string;
  totalBytes: number;
  transferredBytes: number;
  bytesPerSecond: number;
  sha256: string | null;
  message: string | null;
  recoveryPaths: string[];
}
export type StreamingRequest =
  | { kind: 'model_start'; modelId: string; expectedRevision: string | null; messages: Message[] }
  | { kind: 'model_poll' | 'model_close' | 'progress_close'; id: string }
  | { kind: 'progress_open' }
  | { kind: 'progress_publish'; id: string; text: string; reset: boolean }
  | { kind: 'progress_read'; id: string; revision: number; offset: number };
export interface ProgressPart {
  revision: number;
  text: string;
  offset: number;
}
export type PlatformRequest =
  | { kind: 'streaming'; request: StreamingRequest }
  | { kind: 'approval_mode'; mode: 'request' | 'assist' | 'full' }
  | { kind: 'confirm_operations'; operations: { request: PlatformRequest; count: number }[] }
  | { kind: 'tcp_connect'; target: string; port: number }
  | { kind: 'info' | 'hosts' | 'models' }
  | { kind: 'model'; modelId: string }
  | { kind: 'host'; hostId: string }
  | { kind: 'execute' | 'stream_open' | 'terminal'; hostId: string; command: Command }
  | { kind: 'stream_poll' | 'stream_stop'; streamId: string }
  | { kind: 'stream_pause'; streamId: string; paused: boolean }
  | {
      kind: 'model_complete';
      modelId: string;
      expectedRevision: string | null;
      messages: Message[];
    }
  | { kind: 'read_file'; hostId: string; path: string }
  | { kind: 'save_file'; documentId: string; content: string }
  | { kind: 'close_file'; documentId: string; discard: boolean }
  | { kind: 'file_dirty'; documentId: string; dirty: boolean }
  | {
      kind: 'transfer_prepare';
      source: TransferSource;
      destination: RemotePath;
      overwrite: boolean;
    }
  | {
      kind: 'transfer_start' | 'transfer_status' | 'transfer_cancel' | 'transfer_close';
      id: string;
    }
  | { kind: 'settings_read' }
  | { kind: 'settings_write'; value: JsonValue }
  | { kind: 'notify'; message: string }
  | { kind: 'result_read'; resultId: string; chunk: number }
  | { kind: 'result_close'; resultId: string }
  | { kind: 'output_open'; bytes: number }
  | { kind: 'output_part'; resultId: string; offset: number; dataBase64: string }
  | { kind: 'output_finish'; resultId: string };
