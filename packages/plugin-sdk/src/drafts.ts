import { request } from './transport';
/** Protect this page's in-memory edits when its workspace is closed. No document text is sent. */
export function setDraftDirty(dirty: boolean): Promise<void> {
  return request<void>('workspace.draft', { dirty });
}
