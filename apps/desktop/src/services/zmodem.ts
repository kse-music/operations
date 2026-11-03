import Zmodem from 'zmodem.js';
import type { TerminalUploadSelection } from '../types/terminal';

type Session = NonNullable<ReturnType<typeof Zmodem.Session.parse>>;
export interface UploadProgress {
  phase: 'choosing' | 'uploading' | 'finishing';
  name: string;
  sent: number;
  size: number;
}
interface Options {
  write: (data: Uint8Array) => void;
  send: (data: Uint8Array) => Promise<void>;
  pick: () => Promise<TerminalUploadSelection>;
  read: (token: string, index: number, offset: number) => Promise<number[]>;
  release: (token: string) => Promise<void>;
  progress: (value: UploadProgress | null) => void;
  failed: (error: unknown) => void;
  notice: (message: string) => void;
}
const PREFIX = [42, 42, 24, 66];
const TIMEOUT = 30000;

// Keep only a possible initialization header between SSH chunks. The protocol
// library handles CRC, escaping and file offers; normal output never waits on UI.
export class ZmodemUpload {
  private pending: number[] = [];
  private session?: Session;
  private controller?: AbortController;
  private selection?: TerminalUploadSelection;
  private outgoing = Promise.resolve();
  private disposed = false;
  private running = false;
  private ignoreXon = false;
  constructor(private options: Options) {}
  get busy(): boolean {
    return this.running;
  }
  consume(data: Uint8Array): void {
    if (this.disposed) return;
    if (!this.pending.length && !this.ignoreXon && !this.running && !data.includes(42)) {
      this.options.write(data);
      return;
    }
    const output: number[] = [];
    const flush = () => {
      if (output.length) this.options.write(Uint8Array.from(output.splice(0)));
    };
    for (const byte of data) {
      if (this.ignoreXon) {
        this.ignoreXon = false;
        if (byte === 17) continue;
      }
      if (this.session && !this.session.has_ended()) {
        try {
          // Responses are tiny. Consuming individually preserves the shell
          // prompt when ZFIN and ordinary output share the same SSH packet.
          this.session.consume([byte]);
        } catch (error) {
          this.stop(error);
        }
        continue;
      }
      this.pending.push(byte);
      while (this.pending.length) {
        if (
          this.pending
            .slice(0, Math.min(4, this.pending.length))
            .some((value, index) => value !== PREFIX[index])
        ) {
          output.push(this.pending.shift()!);
          continue;
        }
        if (this.pending.length < 19) break;
        if (this.pending.length === 19 && [13, 141].includes(byte)) break;
        let session: Session | undefined;
        if ([10, 138].includes(byte) && !this.running) {
          try {
            session = Zmodem.Session.parse([...this.pending]);
          } catch (cause) {
            this.pending = [];
            this.ignoreXon = true;
            this.options.failed(new Error('远端 ZMODEM 参数不受支持，请检查 rz 参数。', { cause }));
            void this.options
              .send(Uint8Array.of(24, 24, 24, 24, 24, 8, 8, 8, 8, 8))
              .catch((error: unknown) => this.options.failed(error));
            break;
          }
        }
        if (!session) {
          output.push(this.pending.shift()!);
          continue;
        }
        this.pending = [];
        this.ignoreXon = true;
        flush();
        this.start(session);
      }
    }
    flush();
  }
  private start(session: Session): void {
    this.session = session;
    this.running = true;
    this.controller = new AbortController();
    this.outgoing = Promise.resolve();
    session.on('garbage', (data) => this.options.write(Uint8Array.from(data)));
    session.on('session_end', () => {
      if (session.aborted()) this.stop(new Error('远端已取消 ZMODEM 上传。'));
    });
    session.set_sender((data) => {
      // The shared input queue preserves ordering and enforces its byte limit.
      this.outgoing = this.options.send(Uint8Array.from(data));
      void this.outgoing.catch((error: unknown) => this.stop(error));
    });
    if (session.type !== 'send') {
      this.stop(new Error('当前 ZMODEM 支持 rz 上传；下载请使用 SFTP 文件页面。'));
      void this.finish();
      return;
    }
    this.options.progress({ phase: 'choosing', name: '', sent: 0, size: 0 });
    void this.upload(session)
      .catch((error: unknown) => {
        if (!this.controller?.signal.aborted) this.stop(error);
      })
      .finally(() => this.finish());
  }
  private async upload(session: Session): Promise<void> {
    // A native picker may remain open indefinitely. It continues to send
    // protocol keepalives and never uploads a file without a user selection.
    const signal = this.controller!.signal;
    const picked = this.options.pick().then(async (selection) => {
      if (this.disposed || signal.aborted) {
        try {
          await this.options.release(selection.token);
        } catch (error) {
          this.options.failed(error);
        }
      }
      return selection;
    });
    this.selection = await this.wait(picked, false);
    let uploaded = 0,
      skipped = 0;
    for (const [index, file] of this.selection.files.entries()) {
      const progress: UploadProgress = {
        phase: 'uploading',
        name: file.name,
        sent: 0,
        size: file.size,
      };
      this.options.progress({ ...progress });
      const transfer = await this.wait(session.send_offer(file));
      if (!transfer) {
        skipped++;
        continue;
      }
      let offset = transfer.get_offset();
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
        throw new Error('远端请求的文件偏移无效。');
      while (offset < file.size) {
        const data = await this.wait(this.options.read(this.selection.token, index, offset));
        if (!data.length || data.length > 8192 || offset + data.length > file.size)
          throw new Error('本地文件读取长度异常，请重新选择文件。');
        transfer.send(Uint8Array.from(data));
        await this.wait(this.outgoing);
        offset += data.length;
        this.options.progress({ ...progress, sent: offset });
      }
      await this.wait(transfer.end());
      uploaded++;
    }
    this.options.progress({ phase: 'finishing', name: '', sent: 0, size: 0 });
    await this.wait(session.close());
    await this.wait(this.outgoing);
    this.options.notice(
      this.selection.files.length
        ? `ZMODEM 上传完成：${uploaded} 个文件，远端跳过 ${skipped} 个文件。`
        : '已取消 ZMODEM 文件选择。',
    );
  }
  private wait<T>(promise: Promise<T>, timeout = true): Promise<T> {
    const signal = this.controller!.signal;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      if (signal.aborted) {
        // Still attach a rejection handler to the operation being abandoned.
        promise.then(resolve, reject);
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      if (timeout)
        timer = setTimeout(() => {
          cleanup();
          reject(new Error('ZMODEM 上传等待响应超时，传输已停止。'));
        }, TIMEOUT);
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
  private stop(error: unknown, report = true): void {
    if (!this.controller || this.controller.signal.aborted) return;
    this.controller.abort(error);
    if (report) this.options.failed(error);
    if (this.session && !this.session.has_ended()) {
      try {
        this.session.abort();
      } catch (cause) {
        this.options.failed(cause);
      }
    }
  }
  cancel(): void {
    this.stop(new Error('已取消 ZMODEM 上传，远端可能保留未完成的文件。'), false);
    this.options.notice('已取消 ZMODEM 上传，远端可能保留未完成的文件。');
  }
  private async finish(): Promise<void> {
    const selection = this.selection;
    this.selection = undefined;
    if (selection) {
      try {
        await this.options.release(selection.token);
      } catch (error) {
        this.options.failed(error);
      }
    }
    this.running = false;
    this.options.progress(null);
  }
  dispose(): void {
    this.disposed = true;
    // Closing/reconnecting will cancel the old SSH channel; no protocol data
    // from this instance may be sent to the replacement terminal.
    this.session?.set_sender(() => {});
    this.stop(new Error('终端会话已结束，ZMODEM 上传已停止。'), false);
  }
}
