import { invoke } from '@serverdeck/plugin-sdk';
import { call } from '@serverdeck/plugin-sdk/platform';
import { ensureConnection } from '@serverdeck/plugin-sdk/connections';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { TransferPreview, TransferState } from '@serverdeck/plugin-sdk/types/platform';
import type { OpsResponse } from './types';
import { tr } from './i18n/messages';

export type ImageArchiveRequest =
  | { kind: 'import'; fileName: string; confirmed: boolean }
  | { kind: 'export'; id: string; reference: string; fileName: string; confirmed: boolean }
  | {
      kind: 'transfer';
      id: string;
      reference: string;
      fileName: string;
      confirmed: boolean;
      targetHostId: string;
      expectedTargetId: string | null;
      replaceConfirmed: boolean;
    };
export interface ArchiveProgress {
  stage:
    | 'preparing'
    | 'uploading'
    | 'transferring'
    | 'verifying'
    | 'loading'
    | 'saving'
    | 'downloading'
    | 'finishing';
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
  code?: string;
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

export async function inspectImageTarget(
  hostId: string,
  reference: string,
  signal: AbortSignal,
): Promise<string | null> {
  const check = () => {
    if (signal.aborted) throw cancelled();
  };
  check();
  await ensureConnection(hostId, true);
  check();
  const result = await invoke<OpsResponse>('query', { hostId, request: { kind: 'images' } });
  check();
  if (!result.success) throw new Error(result.message || tr('无法读取目标镜像列表。'));
  const matches = result.records.filter((row) => imageReference(row) === reference);
  if (!matches.length) return null;
  const ids = new Set(matches.map((row) => String(row.ID)));
  if (ids.size !== 1 || !/^sha256:[a-fA-F0-9]{64}$/.test(String(matches[0]!.ID)))
    throw new Error(tr('目标镜像信息无效，请刷新后重试。'));
  return String(matches[0]!.ID);
}

export async function runImageArchive(
  hostId: string,
  request: ImageArchiveRequest,
  localPath: string,
  signal: AbortSignal,
  update: (value: ArchiveProgress) => void,
): Promise<void> {
  let stream: ArchiveStream | undefined, transferId: string | undefined;
  const streams: { stream: ArchiveStream; hostId: string }[] = [];
  let output = '',
    contentHash: string | undefined,
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
    let ended: StreamEvent | undefined;
    for (const event of value.events) {
      if (event.type === 'state') {
        if (['closed', 'failed'].includes(event.state ?? '')) ended = event;
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
          else if (line.startsWith(`SD_ARCHIVE_CONTENT:${stream!.nonce}:`)) {
            const hash = line.slice(`SD_ARCHIVE_CONTENT:${stream!.nonce}:`.length);
            if (/^[a-f0-9]{64}$/.test(hash)) contentHash = hash;
          } else output = (output + line + '\n').slice(-65536);
        }
      } else output = (output + text).slice(-65536);
    }
    if (ended) {
      for (const decoder of decoders.values()) output = (output + decoder.decode()).slice(-65536);
      if (partial) {
        output = (output + partial).slice(-65536);
        partial = '';
      }
    }
    report();
    if (ended)
      throw new Error(
        ended.code === 'LOG_COMMAND'
          ? tr('远程镜像命令执行失败，请查看任务输出并核对目标镜像。')
          : ended.message || tr('镜像任务提前结束，未确认成功，请核对实际状态。'),
      );
  }
  async function transfer(preview: { id: string }) {
    const direction =
      request.kind === 'transfer'
        ? 'transferring'
        : request.kind === 'import'
          ? 'uploading'
          : 'downloading';
    transferId = preview.id;
    check();
    let state = await call<TransferState>({ kind: 'transfer_start', id: preview.id });
    while (true) {
      check();
      if (state.state === 'completed') {
        if (!state.sha256 || state.transferredBytes !== state.totalBytes)
          throw new Error(tr('文件传输未完成校验，请核对目标文件。'));
        return;
      }
      if (['failed', 'cancelled', 'expired', 'unverified'].includes(state.state))
        throw new Error(
          [
            state.message || tr('文件传输未完成，请核对实际状态。'),
            ...state.recoveryPaths.map((path) =>
              request.kind === 'export' ? displayLocalPath(path) : path,
            ),
          ].join('\n'),
        );
      stage =
        state.state === 'verifying' ||
        (state.state === 'running' && state.transferredBytes >= state.totalBytes)
          ? 'verifying'
          : state.state === 'running'
            ? direction
            : 'preparing';
      report(state);
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
    if (request.kind === 'transfer') {
      if (request.targetHostId === hostId) throw new Error(tr('请选择与来源不同的目标主机。'));
      await ensureConnection(request.targetHostId, true);
      check();
    }
    stream = await invoke<ArchiveStream>('image_archive', {
      hostId,
      request:
        request.kind === 'transfer'
          ? {
              kind: 'export',
              id: request.id,
              reference: request.reference,
              fileName: request.fileName,
              confirmed: request.confirmed,
            }
          : request,
    });
    streams.push({ stream, hostId });
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
      let preview: { id: string };
      if (request.kind === 'transfer') {
        const source = stream;
        if (!contentHash) throw new Error(tr('未取得来源镜像内容摘要，未开始目标导入。'));
        check();
        stream = await invoke<ArchiveStream>('image_archive', {
          hostId: request.targetHostId,
          request: {
            kind: 'receive',
            id: request.id,
            reference: request.reference,
            contentSha256: contentHash,
            fileName: request.fileName,
            expectedTargetId: request.expectedTargetId,
            replaceConfirmed: request.replaceConfirmed,
            confirmed: request.confirmed,
          },
        });
        streams.push({ stream, hostId: request.targetHostId });
        check();
        prepared = ready = false;
        partial = '';
        decoders.clear();
        stage = 'preparing';
        report();
        while (!prepared) {
          await poll();
          if (!prepared) await pause();
        }
        stage = 'transferring';
        report();
        preview = await call<TransferPreview>({
          kind: 'transfer_prepare',
          source: { kind: 'remote', hostId, path: source.path },
          destination: { hostId: request.targetHostId, path: stream.directory },
          overwrite: false,
        });
      } else {
        stage = 'downloading';
        report();
        preview = await call<TransferPreview<{ localPath: string }>>({
          kind: 'transfer_download_prepare',
          source: { hostId, path: stream.path },
          destination: localPath,
        });
      }
      transferId = preview.id;
      check();
      await transfer(preview);
      if (request.kind === 'transfer') {
        stage = 'loading';
        report();
        while (!ready) {
          await poll();
          if (!ready) await pause();
        }
      }
    }
  } catch (cause) {
    failure = cause;
  }
  const cleanup: string[] = [];
  if (transferId || stream) {
    stage = 'finishing';
    report();
  }
  // Stop and drain the native transfer before releasing its remote staging file.
  if (transferId) {
    try {
      await call({ kind: 'transfer_close', id: transferId });
    } catch (cause) {
      cleanup.push(errorMessage(cause));
    }
  }
  for (const { stream } of [...streams].reverse()) {
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
        streams
          .map(({ stream, hostId }) =>
            tr(
              '\n远程暂存位置：{0}。断线或异常关闭后可能需要手动清理；请先核对任务状态。',
              request.kind === 'transfer' ? `${hostId}: ${stream.directory}` : stream.directory,
            ),
          )
          .join(''),
      { cause: failure },
    );
  }
}
