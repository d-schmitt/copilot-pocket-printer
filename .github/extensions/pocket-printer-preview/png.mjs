import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { inflateSync } from 'node:zlib';

// Match the existing helper bounds without importing its IPC or executable code.
export const MAX_PNG = 1024 * 1024;
export const WIDTH = 384;
export const MAX_HEIGHT = 4096;

export class PreviewError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function invalid(message) { throw new PreviewError('invalid_png', message); }

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function inspectPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PNG) {
    invalid('PNG must be at most 1 MiB.');
  }
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    invalid('Expected a complete PNG file.');
  }
  let width, height, depth, color, interlace;
  let offset = 8, palette = false, transparency = false, ended = false, idatEnded = false;
  const compressed = [];
  let paletteEntries = 0;
  const seen = new Set();
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid('Truncated PNG chunk.');
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) invalid('Truncated PNG chunk.');
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) ||
        crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      invalid('PNG chunk checksum or type is invalid.');
    }
    const data = bytes.subarray(offset + 8, end - 4);
    if (offset === 8 && type !== 'IHDR') invalid('PNG header must be first.');
    if (type !== 'IDAT' && compressed.length) idatEnded = true;
    if (type === 'IHDR') {
      if (seen.has(type) || size !== 13) invalid('Invalid PNG header.');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
      if (width !== WIDTH) invalid('PNG width must be exactly 384 pixels.');
      if (height < 1 || height > MAX_HEIGHT) invalid('PNG height must be 1 to 4096 pixels.');
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || interlace > 1) {
        invalid('Unsupported PNG header encoding.');
      }
    } else if (type === 'PLTE') {
      if (palette || compressed.length || transparency || [0, 4].includes(color) ||
          size < 3 || size > 768 || size % 3 || (color === 3 && size / 3 > 2 ** depth)) {
        invalid('Invalid PNG palette.');
      }
      palette = true;
      paletteEntries = size / 3;
    } else if (type === 'tRNS') {
      if (transparency || compressed.length ||
          !((color === 0 && size === 2) || (color === 2 && size === 6) ||
            (color === 3 && palette && size > 0 && size <= paletteEntries))) {
        invalid('Invalid PNG transparency.');
      }
      transparency = true;
    } else if (type === 'IDAT') {
      if (idatEnded || (color === 3 && !palette)) invalid('Invalid PNG image chunk order.');
      compressed.push(data);
    } else if (type === 'IEND') {
      if (size || end !== bytes.length || !compressed.length) invalid('Invalid PNG end chunk.');
      ended = true;
    } else if (['acTL', 'fcTL', 'fdAT'].includes(type)) {
      invalid('Animated PNG is not supported. Supply one still image.');
    } else if (type[0] === type[0].toUpperCase()) {
      invalid('Unknown critical PNG chunk.');
    }
    seen.add(type);
    offset = end;
  }
  if (!ended) invalid('PNG is missing its end chunk.');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const bitsPerPixel = channels * depth;
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => ({
    width: Math.max(0, Math.ceil((width - x) / dx)),
    height: Math.max(0, Math.ceil((height - y) / dy))
  })).filter(pass => pass.width && pass.height);
  const expected = rows.reduce((total, pass) =>
    total + (1 + Math.ceil(pass.width * bitsPerPixel / 8)) * pass.height, 0);
  const input = Buffer.concat(compressed);
  let decoded;
  try { decoded = inflateSync(input, { maxOutputLength: expected, info: true }); }
  catch { invalid('PNG pixel stream is corrupt or exceeds its declared dimensions.'); }
  if (decoded.buffer.length !== expected || decoded.engine.bytesWritten !== input.length) {
    invalid('PNG pixel stream does not match its dimensions.');
  }
  let position = 0;
  for (const pass of rows) {
    const rowBytes = Math.ceil(pass.width * bitsPerPixel / 8);
    for (let y = 0; y < pass.height; y++) {
      if (decoded.buffer[position] > 4) invalid('Invalid PNG row filter.');
      position += rowBytes + 1;
    }
  }
  // The image is served unchanged. This is nominal paper use, not a helper raster.
  return { width, height, bytes: bytes.length, estimatedPaperMm: (height + 80) / 203 * 25.4 };
}

export async function readLocalPng(path) {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || !isAbsolute(path)) {
    throw new PreviewError('invalid_path', 'Supply an absolute path to one local PNG.');
  }
  let file;
  try {
    // Nonblocking open avoids hanging on FIFOs; reject final-component symlinks.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile()) throw new PreviewError('unreadable_png', 'Input must be a readable regular file.');
    if (stat.size > MAX_PNG) invalid('PNG must be at most 1 MiB.');
    const bytes = Buffer.alloc(MAX_PNG + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const snapshot = bytes.subarray(0, length);
    inspectPng(snapshot);
    return Buffer.from(snapshot);
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('unreadable_png', 'Cannot read this local PNG. Check the path and read permissions; symlinks are not accepted.');
  } finally { await file?.close(); }
}
