import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, readFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { inspectPng, readLocalPng, crc32, MAX_PNG } from '../png.mjs';

function chunk(type, data = Buffer.alloc(0)) {
  const bytes = Buffer.concat([Buffer.alloc(4), Buffer.from(type), data, Buffer.alloc(4)]);
  bytes.writeUInt32BE(data.length);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function png({ width = 384, height = 96, filter = 0, pixels, interlace = 0, tail = [] } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 0; header[12] = interlace;
  const raw = pixels ?? Buffer.alloc((width + 1) * height, 255);
  if (!pixels) for (let y = 0; y < height; y++) raw[y * (width + 1)] = filter;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)), ...tail, chunk('IEND')]);
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pocket-png-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('synthetic printing fixture is exact and nominal paper estimate matches the helper convention', async () => {
  const source = await readFile(new URL('../../../../examples/test-pattern.png', import.meta.url));
  const bundled = await readFile(new URL('../sample.png', import.meta.url));
  assert.deepEqual(bundled, source);
  assert.deepEqual(inspectPng(bundled), {
    width: 384, height: 288, bytes: 4725, estimatedPaperMm: (288 + 80) / 203 * 25.4
  });
});

test('PNG bounds and malformed compressed data fail before display', () => {
  assert.equal(inspectPng(png({ height: 4096 })).height, 4096);
  assert.equal(inspectPng(png({ height: 1 })).height, 1);
  const checksum = png(); checksum[checksum.length - 1] ^= 1;
  const nonAsciiType = png();
  nonAsciiType[12] |= 128;
  nonAsciiType.writeUInt32BE(crc32(nonAsciiType.subarray(12, 29)), 29);
  const cases = [
    [png({ width: 383 }), /384/], [png({ height: 0 }), /height/],
    [png({ height: 4097 }), /height/], [Buffer.alloc(MAX_PNG + 1), /1 MiB/],
    [Buffer.from('not PNG'), /complete PNG/], [png().subarray(0, -4), /Truncated/],
    [checksum, /checksum/], [nonAsciiType, /type/],
    [Buffer.concat([png(), Buffer.from('extra')]), /end chunk/],
    [png({ filter: 5 }), /filter/], [png({ pixels: Buffer.alloc(8) }), /dimensions/],
    [png({ pixels: Buffer.alloc(384 * 4097 * 8) }), /dimensions/],
    [png({ tail: [chunk('acTL', Buffer.alloc(8))] }), /Animated/],
    [png({ tail: [chunk('ABCD')] }), /critical/]
  ];
  for (const [bytes, error] of cases) assert.throws(() => inspectPng(bytes), error);
});

test('Adam7 scanline bounds are checked without converting the original pixels', () => {
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const rows = [];
  for (const [x, y, dx, dy] of passes) {
    for (let row = y; row < 7; row += dy) rows.push(Buffer.alloc(1 + Math.ceil((384 - x) / dx)));
  }
  assert.equal(inspectPng(png({ height: 7, interlace: 1, pixels: Buffer.concat(rows) })).height, 7);
});

test('explicit local reads reject unreadable paths, directories, symlinks, oversized and invalid files', async t => {
  const directory = await temporary(t);
  const valid = join(directory, 'valid.png');
  await writeFile(valid, png());
  assert.deepEqual(await readLocalPng(valid), png());
  await symlink(valid, join(directory, 'link.png'));
  await writeFile(join(directory, 'large.png'), Buffer.alloc(MAX_PNG + 1));
  await writeFile(join(directory, 'bad.png'), 'bad');
  for (const path of ['relative.png', join(directory, 'missing.png'), directory,
    join(directory, 'link.png'), join(directory, 'large.png'), join(directory, 'bad.png')]) {
    await assert.rejects(readLocalPng(path), /path|read|regular|MiB|PNG/);
  }
  if (process.getuid?.() !== 0) {
    await chmod(valid, 0);
    await assert.rejects(readLocalPng(valid), /Cannot read/);
    await chmod(valid, 0o600);
  }
});
