import { call } from './platform';
import type { PlatformRequest, ProgressPart, StreamingRequest } from './types/platform';

/** Only read/close existing resources while an action occupies the Guest queue. */
export function isStreamControl(request: PlatformRequest): boolean {
  return (
    request.kind === 'streaming' &&
    ['progress_read', 'progress_close', 'model_close'].includes(request.request.kind)
  );
}
export const streaming = <T>(request: StreamingRequest): Promise<T> =>
  call<T>({ kind: 'streaming', request });

export const progress = {
  open: () => streaming<{ id: string }>({ kind: 'progress_open' }),
  read: (id: string, revision: number, offset: number) =>
    streaming<ProgressPart>({ kind: 'progress_read', id, revision, offset }),
  close: (id: string) => streaming<null>({ kind: 'progress_close', id }),
};
