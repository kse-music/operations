// Only OSC 7 protocol reports are consumed; arbitrary shell output is never parsed as pwd.
export function osc7Path(value: string): string | null {
  if (
    value.length > 16384 ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'file:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    const path = decodeURIComponent(url.pathname);
    return path.startsWith('/') && path.length <= 4096 && !path.includes('\0') ? path : null;
  } catch {
    return null;
  }
}
