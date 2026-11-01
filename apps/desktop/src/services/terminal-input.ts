// A bounded queue with generation isolation: reconnect never replays or consumes old input.
export class TerminalInputQueue {
  private target?: string;
  private generation = 0;
  private queue: Uint8Array[] = [];
  private bytes = 0;
  private sending = false;
  private disposed = false;
  constructor(
    private send: (id: string, data: Uint8Array) => Promise<void>,
    private failed: (error: unknown) => void,
  ) {}
  reset(target?: string): void {
    this.target = target;
    this.generation++;
    this.queue = [];
    this.bytes = 0;
  }
  dispose(): void {
    this.disposed = true;
    this.reset();
  }
  enqueue(data: Uint8Array, large = false): boolean {
    if (!this.target || this.disposed) return false;
    if (this.bytes + data.length > (large ? 2 * 1024 * 1024 + 32 : 128 * 1024)) return false;
    for (let offset = 0; offset < data.length; offset += 16384)
      this.queue.push(data.slice(offset, offset + 16384));
    this.bytes += data.length;
    void this.drain();
    return true;
  }
  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    const generation = this.generation,
      target = this.target;
    try {
      while (this.queue.length && target && generation === this.generation && !this.disposed) {
        const chunk = this.queue[0]!;
        try {
          await this.send(target, chunk);
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'BUSY'
          ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            continue;
          }
          throw error;
        }
        if (generation !== this.generation) break;
        this.queue.shift();
        this.bytes -= chunk.length;
      }
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        this.queue = [];
        this.bytes = 0;
        this.failed(error);
      }
    } finally {
      this.sending = false;
      if (this.queue.length && generation !== this.generation && !this.disposed) void this.drain();
    }
  }
}
