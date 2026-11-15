#!/usr/bin/env node
// Narrow MCP 2025-06-18 stdio server. No native executable, spawn, BLE, or path-reading tool.
import { callHelper, BridgeError, MAX_FRAME, MAX_PNG } from './ipc.mjs';

const versions = ['2025-06-18'];
const uuid = { type: 'string', format: 'uuid' };
const png = { type: 'string', minLength: 1, maxLength: Math.ceil(MAX_PNG / 3) * 4,
  description: 'Strict base64 of an existing 384-dot PNG, at most 1 MiB. No file paths.' };
const definitions = [
  ['printer_helper_status', 'helper_status', {}, 'Inspect helper availability, native permission state, current confirmation_mode and preference errors. Does not initialize Bluetooth, scan, connect or print.', true],
  ['inspect_png', 'inspect_png', { png_base64: png }, 'Validate an existing PNG in the helper and return its preview. No renderer and no Bluetooth access.', true],
  ['submit_png', 'submit_png', { job_id: uuid, device_id: uuid, png_base64: png, paper_approved: { type: 'boolean', const: true } },
    'Submit exactly one explicitly user-approved PNG job. May begin printing immediately when the helper has opted into AI-client confirmations; native mode waits for a helper-window click. Check printer_helper_status for confirmation_mode. Obtain explicit approval in the AI client before paper_approved:true; the helper cannot verify a human click or distinguish same-user callers. Always allow can remove the client prompt. Use a new stable UUID only for a genuinely new authorization. Never automatically retry a lost reply or replace its ID; query get_print_job. This tool does not confirm paper output.', false],
  ['get_print_job', 'job_status', { job_id: uuid }, 'Inspect the durable receipt for the original job ID after submission, timeout or restart. Unknown is not permission to print again.', true],
  ['cancel_print_job', 'cancel_job', { job_id: uuid }, 'Cancel a pending job or request interruption. Already submitted paper bytes cannot be undone; inspect its final receipt.', false]
];
const tools = definitions.map(([name, , properties, description, readOnly]) => ({
  name, description, inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: false }
}));
let state = 'new';
let input = Buffer.alloc(0);
const pending = new Map();
let stopping = false;

function send(value) {
  if (stopping) return;
  const line = JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n';
  if (Buffer.byteLength(line) > MAX_FRAME || process.stdout.writableLength + Buffer.byteLength(line) > MAX_FRAME * 4) {
    process.stderr.write('mcp_output_backpressure_limit\n'); stop(2); return;
  }
  process.stdout.write(line);
}
function rpcError(id, code, message) { send({ id, error: { code, message } }); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validId(value) { return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)); }
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const { controller } of pending.values()) controller.abort();
  process.stdin.destroy();
  process.exitCode = code;
}

function validateArgs(properties, args) {
  if (!isObject(args) || Object.keys(args).length !== Object.keys(properties).length ||
      Object.keys(args).some(key => !(key in properties))) {
    throw new BridgeError('invalid_arguments', 'Missing, extra or non-object tool arguments.');
  }
  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key];
    if (typeof value !== schema.type) throw new BridgeError('invalid_arguments', `Invalid ${key} type.`);
    if (schema.const !== undefined && value !== schema.const) throw new BridgeError('paper_approval_required', 'Explicit authorization for this one paper job is required.');
    if (schema.format === 'uuid' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) {
      throw new BridgeError('invalid_arguments', `Invalid ${key} UUID.`);
    }
    if (key === 'png_base64') {
      if (!value.length || value.length > schema.maxLength || Buffer.from(value, 'base64').toString('base64') !== value) {
        throw new BridgeError('invalid_image', 'PNG must be strict bounded base64.');
      }
    }
  }
}

async function handle(message) {
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      ('id' in message && !validId(message.id))) {
    rpcError(null, -32600, 'Invalid JSON-RPC request.'); return;
  }
  if (!('id' in message)) {
    if (message.method === 'notifications/initialized' && state === 'initializing') state = 'ready';
    else if (message.method === 'notifications/cancelled' && validId(message.params?.requestId)) {
      const operation = pending.get(message.params.requestId);
      if (operation) {
        operation.cancelled = true;
        operation.controller.abort();
        process.stderr.write('mcp_request_cancelled; query the original job_id; no automatic resubmission\n');
      }
    }
    return; // JSON-RPC notifications never receive responses.
  }
  const { id, method, params } = message;
  if (pending.has(id)) { rpcError(id, -32600, 'Duplicate in-flight JSON-RPC ID.'); return; }
  if (method === 'ping') { send({ id, result: {} }); return; }
  if (method === 'initialize') {
    if (state !== 'new') { rpcError(id, -32600, 'Already initialized.'); return; }
    if (!isObject(params) || typeof params.protocolVersion !== 'string' || !isObject(params.capabilities) ||
        !isObject(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
      rpcError(id, -32602, 'Invalid initialization parameters.'); return;
    }
    state = 'initializing';
    send({ id, result: {
      protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'pocket-printer', version: '0.1.0' },
      instructions: 'User-launched native helper required. No BLE in this process. Obtain explicit per-job approval in the AI client. Check confirmation_mode: native requires a helper click; opted-in ai_client may print immediately on paper_approved:true. The helper trusts any same-user caller and cannot attest a human click; Always allow may suppress client confirmations. Never automatically replay paper jobs; query the original durable job ID after uncertainty.'
    } }); return;
  }
  if (state !== 'ready') { rpcError(id, -32002, 'Initialize and send notifications/initialized first.'); return; }
  if (method === 'tools/list') {
    if (params !== undefined && (!isObject(params) || Object.keys(params).some(key => !['cursor', '_meta'].includes(key)) ||
        (params.cursor != null && params.cursor !== ''))) {
      rpcError(id, -32602, 'This fixed tool list has no pagination cursor.'); return;
    }
    send({ id, result: { tools } }); return;
  }
  if (method !== 'tools/call') { rpcError(id, -32601, 'Method not found.'); return; }
  if (!isObject(params) || typeof params.name !== 'string') { rpcError(id, -32602, 'Invalid tools/call parameters.'); return; }
  const definition = definitions.find(([name]) => name === params.name);
  if (!definition) { rpcError(id, -32602, 'Unknown tool.'); return; }
  if (pending.size >= 4) { rpcError(id, -32000, 'Too many in-flight requests.'); return; }
  const controller = new AbortController();
  const operation = { controller, cancelled: false };
  pending.set(id, operation);
  try {
    const args = params.arguments ?? {};
    validateArgs(definition[2], args);
    const result = await callHelper(definition[1], args, {
      socketPath: process.env.POCKET_PRINTER_SOCKET, signal: controller.signal
    });
    const { preview_png_base64: preview, ...metadata } = result;
    const content = [{ type: 'text', text: JSON.stringify(metadata) }];
    if (params.name === 'inspect_png') {
      if (typeof preview !== 'string' || preview.length > Math.ceil(MAX_PNG / 3) * 4 ||
          !Buffer.from(preview, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new BridgeError('invalid_ipc_reply', 'Helper did not return a bounded print preview.');
      }
      content.push({ type: 'image', data: preview, mimeType: 'image/png' });
    }
    if (!operation.cancelled) send({ id, result: { content, isError: false } });
  } catch (error) {
    const failure = error instanceof BridgeError ? { code: error.code, message: error.message } :
      { code: 'bridge_failed', message: 'Unexpected bridge failure. Query the original job ID; do not retry automatically.' };
    if (!operation.cancelled) send({ id, result: { content: [{ type: 'text', text: JSON.stringify(failure) }], isError: true } });
  } finally { pending.delete(id); }
}

process.stdin.on('data', chunk => {
  // Limit each JSON-RPC line before parsing; never log request/image content.
  let start = 0;
  while (start < chunk.length && !stopping) {
    const newline = chunk.indexOf(10, start);
    const end = newline < 0 ? chunk.length : newline;
    if (input.length + end - start > MAX_FRAME) {
      rpcError(null, -32600, 'MCP frame exceeds 2 MiB.');
      process.stderr.write('mcp_frame_too_large\n'); stop(2); return;
    }
    input = Buffer.concat([input, chunk.subarray(start, end)]);
    if (newline < 0) return;
    const line = input; input = Buffer.alloc(0); start = newline + 1;
    if (line.length === 0) continue;
    let message;
    try { message = JSON.parse(line.toString('utf8')); }
    catch { rpcError(null, -32700, 'Parse error.'); continue; }
    void handle(message).catch(() => { process.stderr.write('mcp_internal_error\n'); stop(1); });
  }
});
process.stdin.on('end', () => {
  if (input.length) process.stderr.write('mcp_truncated_frame\n');
  stop(input.length ? 2 : 0);
});
process.stdin.on('error', () => { process.stderr.write('mcp_input_error\n'); stop(1); });
process.stdout.on('error', () => stop(1));
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
