/** Decimal MB, matching network MB/s (1 MB = 1,000,000 bytes). */
export function megabytes(bytes: number): string {
  return (Number.isFinite(bytes) ? Math.max(0, bytes) / 1_000_000 : 0).toFixed(2);
}
