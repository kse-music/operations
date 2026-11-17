const maxClipboardBytes = 2 * 1024 * 1024;
const maxEncodedLength = 4 * Math.ceil(maxClipboardBytes / 3);

// Only text writes to the clipboard/default selection are supported. Never answer queries.
export function osc52Text(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator < 0 || !/^[cs]*$/.test(data.slice(0, separator))) return null;
  const encoded = data.slice(separator + 1);
  if (!encoded || encoded.length > maxEncodedLength || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    return null;
  try {
    const binary = atob(encoded);
    if (binary.length > maxClipboardBytes) return null;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}
