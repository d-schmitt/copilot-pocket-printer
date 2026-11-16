import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inspectPng, readLocalPng, PreviewError, MAX_PNG } from './png.mjs';

const emptyInput = { type: 'object', properties: {}, additionalProperties: false };
const assets = new Map([
  ['', ['view.html', 'text/html; charset=utf-8']],
  ['view.js', ['view.js', 'text/javascript; charset=utf-8']],
  ['view.css', ['view.css', 'text/css; charset=utf-8']]
]);
const samplePath = fileURLToPath(new URL('./sample.png', import.meta.url));

export function previewCanvas(ErrorType = PreviewError) {
  // Deliberately panel-lifetime only: no path persistence or automatic private reload.
  const panels = new Map();
  async function getPanel(id) {
    const panel = await panels.get(id);
    if (!panel || panel.closed) throw new ErrorType('panel_closed', 'Open a preview panel first.');
    return panel;
  }
  function state(panel) {
    return { ...panel.metadata, source: panel.source, revision: panel.revision, error: panel.error };
  }
  function failure(panel, error) {
    const known = error instanceof PreviewError;
    panel.error = { code: known ? error.code : 'preview_failed',
      message: known ? error.message : 'Preview failed. Close and reopen the panel.' };
    if (!known) console.error('pocket-printer-preview: unexpected preview failure');
    return new ErrorType(panel.error.code, panel.error.message);
  }
  async function replace(panel, load, source) {
    if (panel.busy) throw new ErrorType('preview_busy', 'Another image is loading. Try again when it finishes.');
    panel.busy = true;
    try {
      const bytes = await load();
      const metadata = inspectPng(bytes);
      if (panel.closed) throw new PreviewError('panel_closed', 'Preview panel was closed.');
      panel.image = bytes;
      panel.metadata = metadata;
      panel.source = source;
      panel.revision++;
      panel.error = null;
      return state(panel);
    } catch (error) { throw failure(panel, error); }
    finally { panel.busy = false; }
  }
  async function startServer() {
    const image = await readLocalPng(samplePath);
    const staticAssets = new Map(await Promise.all([...assets].map(async ([route, [file, type]]) =>
      [route, { type, bytes: await readFile(new URL(file, import.meta.url)) }])));
    const panel = { image, metadata: inspectPng(image), source: 'Bundled synthetic sample',
      revision: 1, error: null, busy: false, closed: false };
    const prefix = `/${randomBytes(32).toString('hex')}/`;
    const server = createServer((req, res) => {
      void respond(req, res).catch(error => {
        failure(panel, error);
        if (!res.headersSent) res.writeHead(500);
        res.end('Preview request failed.');
      });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.maxConnections = 16;
    async function respond(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
      if (req.headers.host !== new URL(panel.url).host ||
          (req.headers.origin && req.headers.origin !== panel.origin)) {
        res.writeHead(403); res.end('Forbidden.'); return;
      }
      const url = new URL(req.url, panel.origin);
      if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end('Not found.'); return; }
      const route = url.pathname.slice(prefix.length);
      if (req.method === 'GET') {
        const asset = staticAssets.get(route);
        if (asset) { res.setHeader('Content-Type', asset.type); res.end(asset.bytes); return; }
        if (route === 'state') {
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state(panel))); return;
        }
        if (route === 'image.png') {
          res.setHeader('Content-Type', 'image/png'); res.end(panel.image); return;
        }
        res.writeHead(404); res.end('Not found.'); return;
      }
      if (req.method !== 'POST' || route !== 'image') {
        res.writeHead(405); res.end('Method not allowed.'); return;
      }
      if (req.headers.origin !== panel.origin) { res.writeHead(403); res.end('Forbidden.'); return; }
      res.setHeader('Content-Type', 'application/json');
      try {
        const result = await replace(panel, async () => {
          if (req.headers['content-type'] !== 'image/png') {
            throw new PreviewError('invalid_png', 'Choose a PNG file.');
          }
          if (Number(req.headers['content-length']) > MAX_PNG) {
            throw new PreviewError('invalid_png', 'PNG must be at most 1 MiB.');
          }
          const chunks = [];
          let size = 0;
          // A separate deadline also bounds an otherwise valid but stalled upload.
          const timer = setTimeout(() => req.destroy(), 10_000);
          try {
            for await (const chunk of req) {
              size += chunk.length;
              if (size > MAX_PNG) throw new PreviewError('invalid_png', 'PNG must be at most 1 MiB.');
              chunks.push(chunk);
            }
          } finally { clearTimeout(timer); }
          return Buffer.concat(chunks);
        }, 'Explicitly selected local PNG');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400); res.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
      }
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    panel.origin = `http://127.0.0.1:${server.address().port}`;
    panel.url = panel.origin + prefix;
    panel.server = server;
    return panel;
  }
  return {
    id: 'pocket-printer-preview',
    displayName: 'Pocket Printer Preview',
    description: 'Read-only exact PNG preview with a synthetic sample, local image replacement and estimated paper length; no printer access.',
    inputSchema: emptyInput,
    actions: [
      { name: 'get_preview', description: 'Get dimensions, estimated paper length and visible validation error; no image bytes or private path.',
        inputSchema: emptyInput, handler: async ctx => state(await getPanel(ctx.instanceId)) },
      { name: 'replace_png', description: 'Replace the preview with one explicitly supplied absolute local PNG path, at most 1 MiB and 384 x 1-4096 pixels. No printing or history.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } },
          required: ['path'], additionalProperties: false },
        handler: async ctx => replace(await getPanel(ctx.instanceId), () => readLocalPng(ctx.input.path), 'Explicitly supplied local PNG') },
      { name: 'reset_sample', description: 'Discard the local preview and show the bundled synthetic sample.',
        inputSchema: emptyInput,
        handler: async ctx => replace(await getPanel(ctx.instanceId), () => readLocalPng(samplePath), 'Bundled synthetic sample') }
    ],
    open: async ctx => {
      let pending = panels.get(ctx.instanceId);
      if (!pending) {
        if (panels.size >= 4) throw new ErrorType('preview_limit', 'Close a preview panel before opening another (maximum four).');
        pending = startServer();
        panels.set(ctx.instanceId, pending);
      }
      let panel;
      try { panel = await pending; }
      catch (error) {
        if (panels.get(ctx.instanceId) === pending) panels.delete(ctx.instanceId);
        throw error;
      }
      if (panel.closed) throw new ErrorType('panel_closed', 'Preview panel was closed.');
      return { title: 'Pocket Printer Preview', url: panel.url };
    },
    onClose: async ctx => {
      const pending = panels.get(ctx.instanceId);
      if (!pending) return;
      panels.delete(ctx.instanceId);
      const panel = await pending;
      panel.closed = true;
      panel.image = null;
      await new Promise(resolve => {
        panel.server.close(resolve);
        panel.server.closeAllConnections();
      });
    }
  };
}
