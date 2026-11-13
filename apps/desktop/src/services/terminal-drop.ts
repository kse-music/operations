import { tr } from '../i18n/messages';
import type { TerminalDropProgress, TerminalDropResult } from '../types/terminal';

export type DropProgress = TerminalDropProgress;
interface Options {
  run: (receive: (progress: TerminalDropProgress) => void) => Promise<TerminalDropResult>;
  cancel: () => Promise<void>;
  release: () => Promise<void>;
  progress: (value: DropProgress | null) => void;
  failed: (error: unknown) => void;
  notice?: (message: string) => void;
}
const errors: Record<string, () => string> = {
  DEPENDENCY: () => tr('服务器缺少上传所需的 GNU 基础命令或参数，未安装额外软件。'),
  PERMISSION: () => tr('当前 Shell 用户不能在当前目录创建上传临时目录，请检查权限和磁盘空间。'),
  CONFLICT: () => tr('目标存在同名文件、文件夹或链接，上传已停止，未覆盖已有内容。'),
  CHECKSUM: () => tr('远端文件校验失败，未提交本次文件。'),
  EXTRACT: () => tr('远端解包失败，请检查磁盘空间及目录权限。'),
  METADATA: () => tr('远端无法保留文件修改时间，未提交本次文件。'),
  RECEIVE: () => tr('远端接收失败或超时，上传已停止。'),
  COMMIT: () => tr('远端提交失败，请检查权限和磁盘空间。'),
  TTY: () => tr('无法设置当前终端的接收模式。'),
  TTY_RESTORE: () => tr('无法恢复终端设置，请关闭此会话后重新打开。'),
  CLEANUP: () => tr('上传临时目录清理失败。'),
  LOCAL_READ: () => tr('本地上传文件读取失败，请重新选择文件。'),
};

/** The native backend owns binary I/O and terminal recovery. The UI only
 * observes progress; cancellation stays busy until native recovery finishes. */
export class TerminalDropUpload {
  private running = true;
  private disposed = false;
  private cancelled = false;
  private released = false;
  constructor(private options: Options) {}
  get busy(): boolean {
    return this.running;
  }
  async run(): Promise<void> {
    this.options.progress({
      phase: 'preparing',
      sent: 0,
      size: 0,
      bytesPerSecond: 0,
      elapsedSeconds: 0,
      uid: null,
      username: null,
      directory: null,
    });
    try {
      const result = await this.options.run((value) => {
        if (!this.disposed) this.options.progress(value);
      });
      if (this.disposed) return;
      if (result.code === 'CANCELLED') this.options.notice?.(tr('已取消上传。'));
      else if (result.code) {
        let message = errors[result.code]?.() ?? tr('远端上传失败，请检查当前 Shell 和目录。');
        if (result.recovery) message += tr(' 临时目录：') + result.recovery;
        this.options.failed(
          new Error(message + tr(' 已确认提交 ') + result.committed + tr(' 个项目。')),
        );
      } else this.options.notice?.(tr('上传完成：') + result.committed + tr(' 个项目。'));
    } catch (error) {
      if (!this.disposed) this.options.failed(error);
    } finally {
      await this.release();
      this.running = false;
      if (!this.disposed) this.options.progress(null);
    }
  }
  cancel(): void {
    if (this.cancelled || !this.running) return;
    this.cancelled = true;
    void this.options.cancel().catch((error) => {
      if (!this.disposed) this.options.failed(error);
    });
  }
  private async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await this.options.release();
    } catch (error) {
      if (!this.disposed) this.options.failed(error);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    void this.release();
    this.running = false;
  }
}
