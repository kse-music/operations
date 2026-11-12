/** Formats local paths for display only; keep the original path for file operations. */
export function displayLocalPath(path: string): string {
  // Other Windows namespaces cannot be represented as ordinary drive or UNC paths.
  if (/^\\\\\?\\[a-z]:\\/i.test(path)) return path.slice(4);
  if (/^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.test(path)) return '\\\\' + path.slice(8);
  return path;
}
