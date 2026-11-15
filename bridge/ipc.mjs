import net from 'node:net';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_FRAME = 2 * 1024 * 1024;
export const MAX_PNG = 1024 * 1024;

export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function defaultSocket() {
  return `/tmp/cpp-${process.getuid()}/helper.sock`;
}

export async function callHelper(method, fields, { socketPath = defaultSocket(), signal } = {}) {
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) >= 104) {
    throw new BridgeError('invalid_socket_path', 'Expected an absolute Unix socket path shorter than 104 bytes.');
  }
  try {
    const directory = await lstat(path.dirname(socketPath));
    const socket = await lstat(socketPath);
    if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700 ||
        !socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o777) !== 0o600) {
      throw new BridgeError('unsafe_socket', 'Expected an owned 0700 directory and 0600 socket, with no symlink at either path.');
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (error.code === 'ENOENT') throw new BridgeError('helper_not_running', 'Open Pocket Printer Helper independently in Finder. The bridge never launches it.');
    throw new BridgeError('socket_inspection_failed', 'Cannot inspect the private helper socket.');
  }
  const requestId = randomUUID();
  const payload = Buffer.from(JSON.stringify({ version: 1, request_id: requestId, method, ...fields }));
  if (payload.length > MAX_FRAME) throw new BridgeError('request_too_large', 'IPC frame exceeds 2 MiB.');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length);
  payload.copy(frame, 4);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = Buffer.alloc(0);
    let expected;
    let attempted = false;
    let finished = false;
    const timer = setTimeout(() => fail('ipc_timeout', 'Helper reply deadline expired.'), 5000);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
    };
    const fail = (code, message) => {
      if (finished) return;
      finished = true;
      cleanup();
      const uncertainty = attempted && method === 'submit_png'
        ? ` Admission may have occurred for job ${fields.job_id}. Query that same ID; never automatically submit again or invent a replacement ID.`
        : ' No automatic retry.';
      reject(new BridgeError(code, message + uncertainty));
    };
    const abort = () => fail('request_cancelled', 'Client cancelled the RPC; this does not undo an admitted job.');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.on('connect', () => { attempted = true; socket.write(frame); });
    socket.on('error', error => {
      const code = ['ENOENT', 'ECONNREFUSED'].includes(error.code) && !attempted ? 'helper_not_running' : 'ipc_disconnected';
      fail(code, 'Cannot communicate with the independently running helper.');
    });
    socket.on('end', () => fail('ipc_truncated', 'Helper closed before a complete reply.'));
    socket.on('data', data => {
      if (finished) return;
      if (buffer.length + data.length > MAX_FRAME + 4) { fail('invalid_ipc_reply', 'Oversized helper reply.'); return; }
      buffer = Buffer.concat([buffer, data]);
      if (expected === undefined && buffer.length >= 4) {
        expected = buffer.readUInt32BE(0);
        if (expected === 0 || expected > MAX_FRAME) { fail('invalid_ipc_reply', 'Invalid helper frame length.'); return; }
      }
      if (expected === undefined || buffer.length < expected + 4) return;
      if (buffer.length !== expected + 4) { fail('invalid_ipc_reply', 'Unexpected extra helper bytes.'); return; }
      let reply;
      try { reply = JSON.parse(buffer.subarray(4).toString('utf8')); }
      catch { fail('invalid_ipc_reply', 'Malformed helper JSON.'); return; }
      const returnedId = typeof reply?.request_id === 'string' ? reply.request_id.toLowerCase() : undefined;
      if (reply?.version !== 1 || typeof reply.ok !== 'boolean' ||
          (returnedId !== requestId && !(reply.request_id == null && reply.ok === false))) {
        fail('invalid_ipc_reply', 'Mismatched helper response identity.'); return;
      }
      if (!reply.ok) {
        if (typeof reply.error?.code !== 'string' || typeof reply.error?.message !== 'string') {
          fail('invalid_ipc_reply', 'Malformed helper error.'); return;
        }
        fail(reply.error.code, reply.error.message); return;
      }
      if (!reply.result || typeof reply.result !== 'object') { fail('invalid_ipc_reply', 'Missing helper result.'); return; }
      finished = true; cleanup(); resolve(reply.result);
    });
  });
}
