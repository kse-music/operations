import { invoke } from '@serverdeck/plugin-sdk';
import { call } from '@serverdeck/plugin-sdk/platform';
import { ensureConnection } from '@serverdeck/plugin-sdk/connections';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { TransferPreview, TransferState } from '@serverdeck/plugin-sdk/types/platform';
import { tr } from './i18n/messages';

export type ImageArchiveRequest =
  | { kind: 'import'; fileName: string; confirmed: boolean }
  | { kind: 'export'; id: string; reference: string; fileName: string; confirmed: boolean };
export interface ArchiveProgress {
  stage: 'preparing' | 'uploading' | 'loading' | 'saving' | 'downloading';
  transfer?: TransferState;
  output: string;
  remotePath?: string;
}
interface ArchiveStream {
  streamId: string;
  directory: string;
  path: string;
  nonce: string;
}
interface StreamEvent {
  type: string;
  state?: string;
  message?: string;
  stream?: string;
  dataBase64?: string;
}
const cancelled = () => ({
  code: 'USER_CANCELLED',
  message: tr('操作已取消；已导入的镜像不会回滚，请刷新核对。'),
});
export const localFileName = (path: string) => path.split(/[\\/]/).at(-1) ?? '';
export function archiveFileName(row: Record<string, unknown>): string {
  const label = [row.Repository, row.Tag].filter((v) => v && v !== '<none>').join('-');
  return `${(label || 'image').replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 120)}-${String(row.ID)
    .replace(/^sha256:/, '')
    .slice(0, 12)}.tar`;
}
export function imageReference(row: Record<string, unknown>): string {
  return row.Repository && row.Repository !== '<none>' && row.Tag && row.Tag !== '<none>'
    ? `${row.Repository}:${row.Tag}`
    : String(row.ID);
}
export function validArchiveName(name: string): boolean {
  return (
    !!name &&
    !['.', '..'].includes(name) &&
    !/[\\/\p{Cc}]/u.test(name) &&
    new TextEncoder().encode(name).length <= 240
  );
}

export async function runImageArchive(
  hostId: string,
  request: ImageArchiveRequest,
  localPath: string,
  signal: AbortSignal,
  update: (value: ArchiveProgress) => void,
): Promise<void> {
  let stream: ArchiveStream | undefined, transferId: string | undefined;
  let output = '',
    partial = '',
    prepared = false,
    ready = false;
  let stage: ArchiveProgress['stage'] = 'preparing';
  const decoders = new Map<string, TextDecoder>();
  const check = () => {
    if (signal.aborted) throw cancelled();
  };
  const report = (transfer?: TransferState) =>
    update({ stage, output, remotePath: stream?.path, ...(transfer && { transfer }) });
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
  async function poll() {
    check();
    const value = await call<{ events: StreamEvent[] }>({
      kind: 'stream_poll',
      streamId: stream!.streamId,
    });
    check();
    for (const event of value.events) {
      if (event.type === 'state') {
        if (['closed', 'failed'].includes(event.state ?? ''))
          throw new Error(event.message || tr('镜像任务提前结束，未确认成功，请核对实际状态。'));
        continue;
      }
      const channel = event.stream ?? 'stdout';
      let decoder = decoders.get(channel);
      if (!decoder) {
        decoder = new TextDecoder();
        decoders.set(channel, decoder);
      }
      const text = decoder.decode(
        Uint8Array.from(atob(event.dataBase64 ?? ''), (c) => c.charCodeAt(0)),
        { stream: true },
      );
      if (channel === 'stdout') {
        partial += text;
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        if (partial.length > 16384) partial = partial.slice(-16384);
        for (const line of lines) {
          if (line === `SD_ARCHIVE_PREPARED:${stream!.nonce}`) prepared = true;
          else if (line === `SD_ARCHIVE_READY:${stream!.nonce}`) ready = true;
          else output = (output + line + '\n').slice(-65536);
        }
      } else output = (output + text).slice(-65536);
    }
    report();
  }
  async function transfer(preview: { id: string }) {
    transferId = preview.id;
    check();
    let state = await call<TransferState>({ kind: 'transfer_start', id: preview.id });
    while (true) {
      check();
      report(state);
      if (state.state === 'completed') {
        if (!state.sha256 || state.transferredBytes !== state.totalBytes)
          throw new Error(tr('文件传输未完成校验，请核对目标文件。'));
        return;
      }
      if (['failed', 'cancelled', 'expired', 'unverified'].includes(state.state))
        throw new Error(
          [state.message || tr('文件传输未完成，请核对实际状态。'), ...state.recoveryPaths].join(
            '\n',
          ),
        );
      await pause();
      check();
      state = await call<TransferState>({ kind: 'transfer_status', id: preview.id });
    }
  }
  let failure: unknown;
  try {
    report();
    check();
    await ensureConnection(hostId, true);
    check();
    stream = await invoke<ArchiveStream>('image_archive', { hostId, request });
    check();
    report();
    while (!prepared) {
      await poll();
      if (!prepared) await pause();
    }
    if (request.kind === 'import') {
      stage = 'uploading';
      report();
      const preview = await call<TransferPreview>({
        kind: 'transfer_prepare',
        source: { kind: 'local', path: localPath },
        destination: { hostId, path: stream.directory },
        overwrite: false,
      });
      transferId = preview.id;
      check();
      await transfer(preview);
      stage = 'loading';
      report();
      while (!ready) {
        await poll();
        if (!ready) await pause();
      }
    } else {
      stage = 'saving';
      report();
      while (!ready) {
        await poll();
        if (!ready) await pause();
      }
      stage = 'downloading';
      report();
      const preview = await call<TransferPreview<{ localPath: string }>>({
        kind: 'transfer_download_prepare',
        source: { hostId, path: stream.path },
        destination: localPath,
      });
      transferId = preview.id;
      check();
      await transfer(preview);
    }
  } catch (cause) {
    failure = cause;
  }
  const cleanup: string[] = [];
  // Stop and drain the native transfer before releasing its remote staging file.
  if (transferId) {
    try {
      await call({ kind: 'transfer_close', id: transferId });
    } catch (cause) {
      cleanup.push(errorMessage(cause));
    }
  }
  if (stream) {
    try {
      await call({ kind: 'stream_stop', streamId: stream.streamId });
    } catch (cause) {
      cleanup.push(errorMessage(cause));
    }
  }
  if (failure || cleanup.length) {
    const message = [failure ? errorMessage(failure) : '', ...cleanup].filter(Boolean).join('\n');
    throw new Error(
      message +
        (stream
          ? tr(
              '\n远程暂存位置：{0}。断线或异常关闭后可能需要手动清理；请先核对任务状态。',
              stream.directory,
            )
          : ''),
    );
  }
}
