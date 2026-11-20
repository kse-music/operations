import { invoke } from '@tauri-apps/api/core';
import type {
  BatchCommand,
  BatchCommandInput,
  BatchPreview,
  BatchRequest,
  BatchRun,
} from '../types/batch';
import { ensureDesktop } from './ipc';

export const batchApi = {
  list(): Promise<BatchCommand[]> {
    ensureDesktop();
    return invoke('batch_list');
  },
  save(input: BatchCommandInput, previous: BatchCommand | null): Promise<BatchCommand> {
    return invoke('batch_save', {
      input,
      id: previous?.id ?? null,
      revision: previous?.revision ?? null,
    });
  },
  remove: ({ id, revision }: BatchCommand): Promise<void> =>
    invoke('batch_delete', { id, revision }),
  prepare: (input: BatchRequest): Promise<BatchPreview> => invoke('batch_prepare', { input }),
  start: (token: string, productionConfirmed: boolean): Promise<BatchRun> =>
    invoke('batch_start', { token, productionConfirmed }),
  status: (known: BatchRun | null): Promise<BatchRun | null> =>
    invoke('batch_status', { id: known?.id ?? null, knownRevision: known?.revision ?? null }),
  cancel: (id: string): Promise<void> => invoke('batch_cancel', { id }),
};
