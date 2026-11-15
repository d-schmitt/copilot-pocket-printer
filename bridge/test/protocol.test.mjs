import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, lstat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { callHelper, MAX_FRAME } from '../ipc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureBinary = process.env.HELPER_CHECKS_BIN;
assert.ok(fixtureBinary, 'Set HELPER_CHECKS_BIN to the built inert printer-helper-checks executable.');
const png = (await readFile(path.join(root, 'examples/test-pattern.png'))).toString('base64');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class MCP {
  constructor(socketPath) {
    this.process = spawn(process.execPath, [path.join(root, 'bridge/server.mjs')], {
      env: { ...process.env, POCKET_PRINTER_SOCKET: socketPath }, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.pending = new Map(); this.sequence = 0; this.lines = []; this.errors = '';
    let buffer = '';
    this.process.stdout.on('data', data => {
      buffer += data;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const value = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        this.lines.push(value);
        this.pending.get(value.id)?.(value); this.pending.delete(value.id);
      }
    });
    this.process.stderr.on('data', data => { this.errors += data; });
  }
  call(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 8000);
      this.pending.set(id, response => { clearTimeout(timer); resolve(response); });
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }
  notify(method, params) { this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  async initialize(version = '2025-06-18') {
    const response = await this.call('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'offline-harness', version: '1' } });
    this.notify('notifications/initialized');
    return response;
  }
  async tool(name, args = {}) {
    const response = await this.call('tools/call', { name, arguments: args });
    return { ...response, value: response.result ? JSON.parse(response.result.content[0].text) : undefined };
  }
  async stop() {
    if (this.process.exitCode !== null) return;
    const exit = once(this.process, 'exit');
    this.process.stdin.end();
    await exit;
  }
}

async function fixture(t, mode = 'ready', existing) {
  const directory = existing ?? await mkdtemp('/tmp/cppmcp-');
  const child = spawn(fixtureBinary, ['--fixture', directory, mode], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const socketPath = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture readiness timeout: ' + errors)), 5000);
    child.stdout.once('data', data => { clearTimeout(timer); resolve(data.toString().trim()); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${errors}`)); });
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
  };
  t.after(async () => { await stop(); if (!existing) await rm(directory, { recursive: true, force: true }); });
  return { socketPath, directory, stop };
}

test('actual MCP lifecycle, tool contracts, inspection and helper-unavailable errors', async t => {
  const f = await fixture(t);
  const client = new MCP(f.socketPath); t.after(() => client.stop());
  assert.equal((await client.call('tools/list')).error.code, -32002);
  const init = await client.initialize('future-version');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual((await client.call('tools/list')).result.tools.map(tool => tool.name),
    ['printer_helper_status', 'inspect_png', 'submit_png', 'get_print_job', 'cancel_print_job']);
  assert.equal((await client.call('initialize', {})).error.code, -32600);
  assert.deepEqual((await client.call('ping')).result, {});
  assert.equal((await client.call('unknown')).error.code, -32601);
  assert.equal((await client.tool('unknown')).error.code, -32602);
  const health = await client.tool('printer_helper_status');
  assert.equal(health.value.health.bluetooth, 'ready');
  const inspected = await client.tool('inspect_png', { png_base64: png });
  assert.equal(inspected.value.image.width, 384);
  assert.equal(inspected.value.image.height, 288);
  assert.equal(inspected.result.content[1].type, 'image');
  assert.ok(Buffer.from(inspected.result.content[1].data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal((await client.tool('inspect_png', { path: '/etc/passwd' })).result.isError, true);
  assert.equal((await client.tool('inspect_png', { png_base64: Buffer.alloc(1024 * 1024 + 1).toString('base64') })).result.isError, true);
  assert.equal((await client.tool('inspect_png', { png_base64: Buffer.from('invalid').toString('base64') })).value.code, 'invalid_image');
  assert.equal((await client.call('tools/list', { cursor: null })).result.tools.length, 5);
  client.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'tools/call', params: { name: 'printer_helper_status', arguments: {} } }) + '\n' +
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9001 } }) + '\n');
  await sleep(50);
  assert.ok(!client.lines.some(line => line.id === 9001), 'MCP-cancelled request must not emit a response');
  await f.stop();
  assert.equal((await client.tool('printer_helper_status')).value.code, 'helper_not_running');
});

test('real IPC admission, duplicate identity, busy and restart receipts with inert printing', async t => {
  const f = await fixture(t);
  const client = new MCP(f.socketPath); t.after(() => client.stop());
  await client.initialize();
  const fields = { job_id: randomUUID(), device_id: randomUUID(), png_base64: png, paper_approved: true };
  assert.equal((await client.tool('submit_png', { ...fields, paper_approved: false })).value.code, 'paper_approval_required');
  const admitted = await client.tool('submit_png', fields);
  assert.equal(admitted.value.receipt.state, 'awaiting_approval');
  assert.equal((await client.tool('submit_png', fields)).value.receipt.job_id.toLowerCase(), fields.job_id);
  assert.equal((await client.tool('submit_png', { ...fields, device_id: randomUUID() })).value.code, 'job_id_conflict');
  assert.equal((await client.tool('submit_png', { ...fields, job_id: randomUUID() })).value.code, 'busy');
  await sleep(800);
  const done = await client.tool('get_print_job', { job_id: fields.job_id });
  assert.equal(done.value.receipt.state, 'submitted_only');
  assert.equal(done.value.receipt.paper_confirmed, false);
  assert.match(done.value.receipt.message, /inert executor calls=1/);
  await f.stop();
  const second = await fixture(t, 'ready', f.directory);
  assert.equal(second.socketPath, f.socketPath);
  assert.equal((await client.tool('submit_png', fields)).value.receipt.state, 'submitted_only');
  const interrupted = { ...fields, job_id: randomUUID() };
  await client.tool('submit_png', interrupted);
  await sleep(200);
  await second.stop();
  await fixture(t, 'ready', f.directory);
  const uncertain = await client.tool('submit_png', interrupted);
  assert.equal(uncertain.value.receipt.state, 'uncertain');
  assert.equal(uncertain.value.receipt.error_code, 'helper_restarted');
  const blocked = await client.tool('printer_helper_status');
  assert.equal(blocked.value.health.safety_blocked, true);
  assert.equal((await client.tool('submit_png', { ...fields, job_id: randomUUID() })).value.code, 'safety_blocked');
});

test('peer credentials, directory/socket modes and malformed bounded frames', async t => {
  const f = await fixture(t, 'wrong-peer');
  assert.equal((await lstat(path.dirname(f.socketPath))).mode & 0o777, 0o700);
  assert.equal((await lstat(f.socketPath)).mode & 0o777, 0o600);
  await assert.rejects(callHelper('helper_status', {}, { socketPath: f.socketPath }), { code: 'wrong_peer' });
  await chmod(f.socketPath, 0o666);
  await assert.rejects(callHelper('helper_status', {}, { socketPath: f.socketPath }), { code: 'unsafe_socket' });
  await chmod(f.socketPath, 0o600);
  const valid = await fixture(t);
  async function raw(data, halfClose = false) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(valid.socketPath);
      let result = Buffer.alloc(0);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('raw IPC deadline')); }, 5000);
      socket.on('connect', () => { socket.write(data); if (halfClose) socket.end(); });
      socket.on('data', data => { result = Buffer.concat([result, data]); });
      socket.on('error', reject);
      socket.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(result.subarray(4).toString())); } catch (error) { reject(error); }
      });
    });
  }
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_FRAME + 1);
  assert.equal((await raw(oversized)).error.code, 'frame_too_large');
  assert.equal((await raw(Buffer.from([0, 0, 0, 1, 123]))).error.code, 'invalid_request');
  assert.equal((await raw(Buffer.from([0, 0, 0, 10, 123]))).error.code, 'ipc_truncated_or_timeout');
  const overflow = await fixture(t);
  const occupied = Array.from({ length: 4 }, () => net.createConnection(overflow.socketPath));
  for (const socket of occupied) socket.on('error', () => {});
  try {
    await Promise.all(occupied.map(socket => once(socket, 'connect')));
    await sleep(30);
    await assert.rejects(callHelper('helper_status', {}, { socketPath: overflow.socketPath }), { code: 'ipc_busy' });
  } finally { for (const socket of occupied) socket.destroy(); }
});

test('typed permission failures and malformed MCP are explicit without content leaks', async t => {
  for (const mode of ['denied', 'off', 'permission_pending']) {
    const f = await fixture(t, mode);
    const client = new MCP(f.socketPath); t.after(() => client.stop());
    await client.initialize();
    const result = await client.tool('submit_png', { job_id: randomUUID(), device_id: randomUUID(), png_base64: png, paper_approved: true });
    assert.equal(result.value.code, `bluetooth_${mode}`);
    await client.stop(); await f.stop();
  }
  const client = new MCP('/tmp/missing-cpp-test/helper.sock'); t.after(() => client.stop());
  client.process.stdin.write('{broken\n');
  await sleep(50);
  assert.equal(client.lines[0].error.code, -32700);
  client.process.stdin.write('x'.repeat(MAX_FRAME + 1));
  await once(client.process, 'exit');
  assert.equal(client.process.exitCode, 2);
  assert.match(client.errors, /mcp_frame_too_large/);
  assert.ok(!client.errors.includes('broken'));
});

test('lost client reply never replays an admitted physical job', async t => {
  const f = await fixture(t);
  const fields = { job_id: randomUUID(), device_id: randomUUID(), png_base64: png, paper_approved: true };
  const data = Buffer.from(JSON.stringify({ version: 1, request_id: randomUUID(), method: 'submit_png', ...fields }));
  const frame = Buffer.alloc(4 + data.length); frame.writeUInt32BE(data.length); data.copy(frame, 4);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(f.socketPath);
    socket.on('error', reject);
    socket.on('connect', () => socket.write(frame, () => { socket.destroy(); resolve(); }));
  });
  await sleep(800);
  const receipt = await callHelper('job_status', { job_id: fields.job_id }, { socketPath: f.socketPath });
  assert.equal(receipt.receipt.state, 'submitted_only');
  const replay = await callHelper('submit_png', fields, { socketPath: f.socketPath });
  assert.match(replay.receipt.message, /inert executor calls=1/);
});

test('cancelled bridge request reports uncertainty with the original job ID', async t => {
  const directory = await mkdtemp('/tmp/cppsilent-');
  const socketPath = path.join(directory, 'helper.sock');
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('data', () => {}); });
  await new Promise(resolve => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const controller = new AbortController();
  const fields = { job_id: randomUUID(), device_id: randomUUID(), png_base64: png, paper_approved: true };
  const pending = callHelper('submit_png', fields, { socketPath, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, error => error.code === 'request_cancelled' && error.message.includes(fields.job_id) && error.message.includes('Admission may have occurred'));
});
