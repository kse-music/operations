// One log tab has a strict UTF-8 byte and line budget; plain text is never executed.
export class LogBuffer {
  private chunks: { text: string; bytes: number; lines: number }[] = [];
  private total = 0;
  private lines = 0;
  dropped = 0;
  constructor(
    readonly maxBytes = 1024 * 1024,
    readonly maxLines = 5000,
  ) {}
  append(text: string): void {
    // Cap a single payload as well as the whole buffer, preserving Unicode boundaries.
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 4096, text.length);
      if (end < text.length && /^[\uDC00-\uDFFF]$/.test(text[end]!)) end--;
      const value = text.slice(offset, end);
      offset = end;
      const bytes = new TextEncoder().encode(value).length,
        lines = (value.match(/\n/g) ?? []).length;
      this.chunks.push({ text: value, bytes, lines });
      this.total += bytes;
      this.lines += lines;
    }
    while (this.chunks.length && (this.total > this.maxBytes || this.lines > this.maxLines)) {
      const removed = this.chunks.shift()!;
      this.total -= removed.bytes;
      this.lines -= removed.lines;
      this.dropped += removed.bytes;
    }
  }
  value(): string {
    return this.chunks.map((c) => c.text).join('');
  }
  clear(): void {
    this.chunks = [];
    this.total = 0;
    this.lines = 0;
    this.dropped = 0;
  }
  get byteLength(): number {
    return this.total;
  }
}
