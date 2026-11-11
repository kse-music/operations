import { tr } from '../i18n/messages';
import type { TerminalDropPrepared } from '../types/terminal';

export interface DropProgress {
  phase:
    'preparing' | 'starting' | 'uploading' | 'verifying' | 'committing' | 'cancelling' | 'blocked';
  sent: number;
  size: number;
  bytesPerSecond: number;
  uid?: string;
  directory?: string;
}
interface Options {
  prepare: () => Promise<TerminalDropPrepared>;
  read: (offset: number) => Promise<number[]>;
  release: () => Promise<void>;
  send: (data: Uint8Array) => Promise<void>;
  interrupt: () => Promise<void>;
  write: (data: Uint8Array) => void;
  progress: (value: DropProgress | null) => void;
  failed: (error: unknown) => void;
  notice?: (message: string) => void;
}
const encoder = new TextEncoder();
const decode = new TextDecoder('utf-8', { fatal: true });
const TIMEOUT = 30000;
const errors: Record<string, string> = {
  get DEPENDENCY() {
    return tr('服务器缺少上传所需的 GNU 基础命令或参数，未安装额外软件。');
  },
  get PERMISSION() {
    return tr('当前 Shell 用户不能在当前目录创建上传临时目录，请检查权限和磁盘空间。');
  },
  get CONFLICT() {
    return tr('目标存在同名文件、文件夹或链接，上传已停止，未覆盖已有内容。');
  },
  get CHECKSUM() {
    return tr('远端归档校验失败，未提交本次文件。');
  },
  get EXTRACT() {
    return tr('远端解包失败，请检查磁盘空间及目录权限。');
  },
  get RECEIVE() {
    return tr('远端接收失败或超时，上传已停止。');
  },
  get DECODE() {
    return tr('远端解码失败，上传已停止。');
  },
  get COMMIT() {
    return tr('远端提交失败，请检查权限和磁盘空间。');
  },
  get TTY() {
    return tr('无法设置当前终端的接收模式。');
  },
  get TTY_RESTORE() {
    return tr('无法恢复终端设置，请关闭此会话后重新打开。');
  },
  get CANCELLED() {
    return tr('已取消上传。');
  },
  get CLEANUP() {
    return tr('上传临时目录清理失败。');
  },
};
function unbase64(text: string): string {
  return decode.decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
}
function base64(bytes: number[]): Uint8Array {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.slice(i, i + 8192));
  return encoder.encode(btoa(text));
}

/** One confirmed upload in the original PTY. A peer frame never grants local files. */
export class TerminalDropUpload {
  private pending: number[] = [];
  private nonce = '';
  private running = true;
  private disposed = false;
  private cancelled = false;
  private started = false;
  private ended = false;
  private reported = false;
  private redrawPrompt = false;
  private endCode?: string;
  private endError?: Error;
  private peerFailure?: Error;
  private count = 0;
  private inFlightBytes = 0;
  private uploadStartedAt?: number;
  private unsafeTerminal = false;
  private released = false;
  private expected?: {
    key: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private endWaiter?: () => void;
  private endReject?: (error: Error) => void;
  private value: DropProgress = { phase: 'preparing', sent: 0, size: 0, bytesPerSecond: 0 };
  constructor(private options: Options) {}
  get busy(): boolean {
    return this.running;
  }
  get pendingOutput(): boolean {
    return this.redrawPrompt;
  }
  private write(data: Uint8Array): void {
    if (!data.length) return;
    if (this.redrawPrompt) {
      this.redrawPrompt = false;
      // The hidden command consumed the blank input line remotely. Refresh the
      // normal Shell prompt in place instead of appending it to the old prompt.
      this.options.write(Uint8Array.of(13, 27, 91, 50, 75));
    }
    this.options.write(data);
  }
  private progress(phase: DropProgress['phase']): void {
    this.value.phase = phase;
    const seconds =
      this.uploadStartedAt === undefined ? 0 : (performance.now() - this.uploadStartedAt) / 1000;
    this.value.bytesPerSecond =
      phase === 'uploading' && seconds > 0 ? Math.floor(this.value.sent / seconds) : 0;
    this.options.progress({ ...this.value });
  }
  consume(data: Uint8Array): void {
    if (!this.nonce || this.disposed) {
      this.options.write(data);
      return;
    }
    const prefix = encoder.encode('\x1eSDU:' + this.nonce + ':');
    const output: number[] = [];
    for (const byte of data) {
      if (this.ended) {
        output.push(byte);
        continue;
      }
      this.pending.push(byte);
      while (this.pending.length) {
        if (
          this.pending
            .slice(0, Math.min(prefix.length, this.pending.length))
            .some((b, i) => b !== prefix[i])
        ) {
          // From the first command byte through RETURN, echo, PS2, command
          // diagnostics and control bytes belong to the hidden upload.
          this.pending.shift();
          continue;
        }
        if (this.pending.length > 16384) {
          this.pending.shift();
          this.rejectExpected(new Error(tr('上传响应超过长度限制。')));
          continue;
        }
        if (byte === 31 && this.pending.length > prefix.length) {
          const frame = String.fromCharCode(...this.pending.slice(prefix.length, -1));
          this.pending = [];
          this.frame(frame);
        }
        break;
      }
    }
    this.write(Uint8Array.from(output));
  }
  private frame(frame: string): void {
    if (this.ended) return;
    const parts = frame.split(':');
    if (frame === 'RETURN') {
      if (!this.reported) {
        this.endError = new Error(tr('接收进程未报告最终结果，请关闭此会话后重新打开。'));
        this.unsafeTerminal = true;
      }
      this.ended = true;
      this.redrawPrompt = true;
      if (this.expected) this.rejectExpected(this.endError ?? new Error(tr('上传接收端已结束。')));
      this.endWaiter?.();
      return;
    }
    if (this.reported) return;
    if (parts[0] === 'FAIL') {
      this.peerFailure = new Error(
        (errors[parts[1]!] ?? tr('远端接收失败。')) +
          tr(' 已确认提交 ') +
          (Number(parts[2]) || 0) +
          tr(' 个项目。'),
      );
      this.rejectExpected(this.peerFailure);
      this.endReject?.(this.peerFailure);
      return;
    }
    if (parts[0] === 'ERROR' || parts[0] === 'DONE') {
      this.reported = true;
      this.count = Number(parts[parts[0] === 'DONE' ? 1 : 2]) || 0;
      if (parts[0] === 'ERROR') {
        this.unsafeTerminal = parts[1] === 'TTY_RESTORE';
        this.endCode = parts[1];
        let message = errors[parts[1]!] ?? tr('远端上传失败，请检查当前 Shell 和目录。');
        if (parts[1] === 'CLEANUP' && parts[3]) {
          try {
            message += tr(' 临时目录：') + unbase64(parts[3]);
          } catch {
            message += tr(' 临时目录响应无效，请检查远端 .serverdeck-upload.* 目录。');
          }
        }
        this.endError = new Error(message + tr(' 已确认提交 ') + this.count + tr(' 个项目。'));
      } else if (this.value.sent !== this.value.size || this.value.phase !== 'committing') {
        this.endError = new Error(tr('远端提前报告完成，上传结果未经确认。'));
      }
      return;
    }
    if (parts[0] === 'READY') {
      if (this.expected?.key !== 'READY' || !/^\d+$/.test(parts[1] ?? '')) {
        this.rejectExpected(new Error(tr('上传接收端身份响应无效。')));
        return;
      }
      try {
        const directory = unbase64(parts.slice(2).join(':'));
        if (!directory.startsWith('/') || !directory.endsWith('\n'))
          throw new Error(tr('上传接收端目录响应无效。'));
        this.value.uid = parts[1];
        this.value.directory = directory.slice(0, -1);
      } catch {
        this.rejectExpected(new Error(tr('上传接收端目录响应无效。')));
        return;
      }
    } else if (frame === 'VERIFYING') {
      this.progress('verifying');
      return;
    } else if (frame === 'COMMITTING') {
      this.progress('committing');
      return;
    }
    const key = parts[0] === 'READY' ? 'READY' : frame;
    if (this.expected?.key === key) {
      if (key.startsWith('ACK:')) this.value.sent += this.inFlightBytes;
      clearTimeout(this.expected.timer);
      const resolve = this.expected.resolve;
      this.expected = undefined;
      resolve();
    } else this.rejectExpected(new Error(tr('上传接收端响应顺序无效。')));
  }
  private rejectExpected(error: Error): void {
    const pending = this.expected;
    if (!pending) return;
    this.expected = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  private async exchange(key: string, bytes: Uint8Array): Promise<void> {
    if (this.peerFailure) throw this.peerFailure;
    if (this.cancelled || this.disposed || this.ended) throw new Error(tr('上传已停止。'));
    const response = new Promise<void>((resolve, reject) => {
      this.expected = {
        key,
        resolve,
        reject,
        timer: setTimeout(
          () => this.rejectExpected(new Error(tr('等待上传接收端响应超时。'))),
          TIMEOUT,
        ),
      };
    });
    // A cancellation/peer failure can arrive while the bounded input queue drains.
    void response.catch(() => {});
    await this.options.send(bytes);
    await response;
  }
  private waitEnd(timeout: number): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.peerFailure) return Promise.reject(this.peerFailure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.endWaiter = undefined;
        this.endReject = undefined;
        reject(new Error(tr('无法确认远端接收进程已结束，请关闭此会话后重新打开。')));
      }, timeout);
      this.endWaiter = () => {
        clearTimeout(timer);
        this.endWaiter = undefined;
        this.endReject = undefined;
        resolve();
      };
      this.endReject = (error) => {
        clearTimeout(timer);
        this.endWaiter = undefined;
        this.endReject = undefined;
        reject(error);
      };
    });
  }
  async run(): Promise<void> {
    this.progress('preparing');
    try {
      const prepared = await this.options.prepare();
      if (this.cancelled || this.disposed) return;
      if (
        !Number.isSafeInteger(prepared.size) ||
        prepared.size <= 0 ||
        !/^[a-f0-9]{32}$/.test(prepared.nonce) ||
        !/^[a-f0-9]{64}$/.test(prepared.sha256)
      )
        throw new Error(tr('本地上传归档信息无效。'));
      this.nonce = prepared.nonce;
      this.value.size = prepared.size;
      this.progress('starting');
      this.started = true;
      await this.exchange('READY', encoder.encode(prepared.command));
      this.uploadStartedAt = performance.now();
      for (let offset = 0, seq = 0; offset < prepared.size; seq++) {
        if (this.cancelled || this.disposed) throw new Error(tr('上传已取消。'));
        const bytes = await this.options.read(offset);
        if (bytes.length !== Math.min(65536, prepared.size - offset))
          throw new Error(tr('本地归档读取长度无效，上传已停止。'));
        // Progress advances only after the corresponding ACK. Set it before
        // exchange resolves so an immediate DONE in the final packet is valid.
        const next = offset + bytes.length;
        this.inFlightBytes = bytes.length;
        this.progress('uploading');
        await this.exchange('ACK:' + seq, base64(bytes));
        this.value.sent = next;
        offset = next;
        if (this.value.phase === 'uploading') this.progress('uploading');
      }
      if (this.cancelled) throw new Error(tr('上传已取消。'));
      await this.waitEnd(TIMEOUT);
      if (this.disposed) return;
      if (this.endError) throw this.endError;
      this.options.notice?.(tr('上传完成：') + this.count + tr(' 个项目。'));
    } catch (error) {
      if (this.disposed) return;
      this.rejectExpected(new Error(tr('上传已停止。')));
      if (this.unsafeTerminal) {
        this.progress('blocked');
        this.options.failed(this.endError ?? error);
        return;
      }
      if (this.started && !this.ended) {
        this.progress('cancelling');
        this.peerFailure = undefined;
        try {
          await this.options.interrupt();
          await this.waitEnd(5000);
        } catch (recovery) {
          this.progress('blocked');
          this.options.failed(recovery);
          return;
        }
      }
      if (!this.cancelled) this.options.failed(error);
      else if (this.endError && this.endCode !== 'CANCELLED') this.options.failed(this.endError);
      else this.options.notice?.(tr('已取消上传。'));
    } finally {
      await this.release();
      if (this.value.phase !== 'blocked' || this.disposed) {
        this.running = false;
        this.options.progress(null);
      }
    }
  }
  cancel(): void {
    if (this.cancelled || this.disposed) return;
    this.cancelled = true;
    const error = new Error(tr('上传已取消。'));
    this.rejectExpected(error);
    this.endReject?.(error);
    if (!this.started) {
      void this.release();
      this.running = false;
      this.options.progress(null);
    }
  }
  private async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await this.options.release();
    } catch (error) {
      this.options.failed(error);
    }
  }
  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.rejectExpected(new Error(tr('终端会话已结束。')));
    this.endWaiter?.();
    void this.release();
    this.running = false;
    this.redrawPrompt = false;
  }
}
