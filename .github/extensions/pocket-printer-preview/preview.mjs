import { fileURLToPath } from 'node:url';
import { inspectPng, readLocalPng, PreviewError, MAX_PNG } from './png.mjs';
import { servePanel, readBody } from './loopback.mjs';

const emptyInput = { type: 'object', properties: {}, additionalProperties: false };
const assets = {
  '': ['view.html', 'text/html; charset=utf-8'],
  'view.js': ['view.js', 'text/javascript; charset=utf-8'],
  'view.css': ['view.css', 'text/css; charset=utf-8']
};
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
    const panel = { image, metadata: inspectPng(image), source: 'Bundled synthetic sample',
      revision: 1, error: null, busy: false, closed: false };
    const listener = await servePanel({
      assets,
      get: route => {
        if (route === 'state') return { type: 'application/json', body: JSON.stringify(state(panel)) };
        if (route === 'image.png') return { type: 'image/png', body: panel.image };
      },
      post: {
        image: req => replace(panel, () => readBody(req, MAX_PNG, 'image/png'), 'Explicitly selected local PNG')
      },
      onError: error => { failure(panel, error); return panel.error; }
    });
    panel.url = listener.url;
    panel.close = listener.close;
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
      await panel.close();
    }
  };
}
