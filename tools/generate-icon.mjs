import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// Deterministic project-native icon, with no external media dependencies.
const size = 256;
const scanlines = Buffer.alloc((1 + size * 4) * size);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const px = Math.floor(x / 8);
    const py = Math.floor(y / 8);
    const chevron = px >= 7 && px <= 15 && Math.abs(py - 14) === px - 7;
    const cursor = px >= 17 && px <= 25 && py >= 21 && py <= 23;
    const offset = y * (1 + size * 4) + 1 + x * 4;
    scanlines.set(chevron || cursor ? [115, 217, 190, 255] : [21, 24, 31, 255], offset);
  }
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  body.copy(output, 4);
  output.writeUInt32BE(crc32(body), output.length - 4);
  return output;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(scanlines)),
  chunk('IEND', Buffer.alloc(0)),
]);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = size === 256 ? 0 : size;
header[7] = size === 256 ? 0 : size;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
const directory = new URL('../apps/desktop/src-tauri/icons/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('icon.ico', directory), Buffer.concat([header, png]));
writeFileSync(new URL('icon.png', directory), png);
