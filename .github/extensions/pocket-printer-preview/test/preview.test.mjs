import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, writeFile, rm, readFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { request } from 'node:http';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { inspectPng, readLocalPng, crc32, MAX_PNG } from '../png.mjs';
import { previewCanvas } from '../preview.mjs';

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
  const directory = await mkdtemp(join(tmpdir(), 'pocket-preview-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function withoutPhysicalOperations(operation) {
  const spies = [mock.method(net.Socket.prototype, 'connect', () => { throw new Error('Forbidden outbound socket'); })];
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    spies.push(mock.method(childProcess, method, () => { throw new Error('Forbidden process launch'); }));
  }
  syncBuiltinESMExports();
  try {
    const result = await operation();
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0, 'No outbound sockets or process launches');
    return result;
  } finally {
    for (const spy of spies) spy.mock.restore();
    syncBuiltinESMExports();
  }
}
function action(canvas, instanceId, name, input = {}) {
  return canvas.actions.find(entry => entry.name === name).handler({ instanceId, input });
}

test('bundled synthetic fixture is exact and nominal paper estimate matches the helper convention', async () => {
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

test('open, replace, refresh, reset, close and provider restart never connect or launch a process', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'second.png');
  await writeFile(path, png());
  const canvas = previewCanvas();
  const ctx = { instanceId: 'offline-card', input: {} };
  t.after(() => canvas.onClose(ctx));
  await withoutPhysicalOperations(async () => {
    const opened = await canvas.open(ctx);
    assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/$/);
    const replaced = await action(canvas, ctx.instanceId, 'replace_png', { path });
    assert.equal(replaced.height, 96);
    assert.equal(replaced.source, 'Explicitly supplied local PNG');
    await writeFile(path, png({ height: 12 }));
    assert.deepEqual(await canvas.open(ctx), opened);
    assert.equal((await action(canvas, ctx.instanceId, 'get_preview')).height, 96, 'no path reread');
    await assert.rejects(action(canvas, ctx.instanceId, 'replace_png', { path: join(directory, 'missing') }), /Cannot read/);
    const failed = await action(canvas, ctx.instanceId, 'get_preview');
    assert.equal(failed.height, 96);
    assert.equal(failed.error.code, 'unreadable_png');
    assert.ok(!JSON.stringify(failed).includes(directory), 'No path exposed in browser state');
    assert.equal((await action(canvas, ctx.instanceId, 'reset_sample')).height, 288);
    await canvas.onClose(ctx);
    await assert.rejects(action(canvas, ctx.instanceId, 'get_preview'), /Open a preview/);
    await canvas.open(ctx);
    assert.equal((await action(canvas, ctx.instanceId, 'get_preview')).height, 288);
    await canvas.onClose(ctx);
    const restarted = previewCanvas();
    await restarted.open(ctx);
    assert.equal((await action(restarted, ctx.instanceId, 'get_preview')).height, 288);
    await restarted.onClose(ctx);
  });
});

test('concurrent opens share one listener and all panel state is bounded and isolated', async t => {
  const canvas = previewCanvas();
  const ids = ['one', 'two', 'three', 'four'];
  t.after(async () => { for (const instanceId of ids) await canvas.onClose({ instanceId }); });
  const urls = await Promise.all(Array.from({ length: 10 }, () => canvas.open({ instanceId: 'one' })));
  assert.equal(new Set(urls.map(result => result.url)).size, 1);
  for (const instanceId of ids.slice(1)) await canvas.open({ instanceId });
  await assert.rejects(canvas.open({ instanceId: 'five' }), /maximum four/);
  await assert.rejects(action(canvas, 'one', 'replace_png', { path: '/no-such-preview.png' }));
  assert.equal((await action(canvas, 'two', 'get_preview')).error, null);
});

test('loopback boundary serves exact bytes and rejects unauthorized or oversized mutation', async t => {
  const canvas = previewCanvas();
  const ctx = { instanceId: 'http-card' };
  const { url } = await canvas.open(ctx);
  t.after(() => canvas.onClose(ctx));
  const origin = new URL(url).origin;
  assert.equal((await fetch(origin)).status, 404);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: 'attacker.invalid' } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await fetch(url, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  const initial = await fetch(url + 'image.png');
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.equal(initial.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(Buffer.from(await initial.arrayBuffer()), await readFile(new URL('../sample.png', import.meta.url)));
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://attacker.invalid' }]) {
    assert.equal((await fetch(url + 'image', { method: 'POST', headers, body: png() })).status, 403);
  }
  const headers = { Origin: origin, 'Content-Type': 'image/png' };
  const upload = await fetch(url + 'image', { method: 'POST', headers, body: png() });
  assert.equal(upload.status, 200);
  assert.equal((await upload.json()).height, 96);
  assert.deepEqual(Buffer.from(await (await fetch(url + 'image.png')).arrayBuffer()), png());
  for (const bytes of [png({ width: 385 }), Buffer.from('not PNG'), Buffer.alloc(MAX_PNG + 1)]) {
    const response = await fetch(url + 'image', { method: 'POST', headers, body: bytes });
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error.message);
    const visible = await (await fetch(url + 'state')).json();
    assert.ok(visible.error.message);
    assert.equal(visible.height, 96);
  }
  assert.equal((await fetch(url + 'print', { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(url + 'image', { method: 'GET' })).status, 404);
  const script = await (await fetch(url + 'view.js')).text();
  assert.ok(script.includes("fetch('state'"));
  await canvas.onClose(ctx);
  await assert.rejects(fetch(url), /fetch failed/);
});

test('extension runtime imports stay independent of helper, BLE and portable MCP', async () => {
  const allowed = new Set(['node:http', 'node:crypto', 'node:fs', 'node:fs/promises',
    'node:path', 'node:url', 'node:zlib', '@github/copilot-sdk/extension', './preview.mjs', './png.mjs']);
  for (const file of ['extension.mjs', 'preview.mjs', 'png.mjs']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, dependency] of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
      assert.ok(allowed.has(dependency), `Unexpected runtime dependency: ${dependency}`);
    }
    assert.doesNotMatch(source, /\bimport\s*\(|\bfetch\s*\(|\bwriteFile\s*\(/);
  }
});
