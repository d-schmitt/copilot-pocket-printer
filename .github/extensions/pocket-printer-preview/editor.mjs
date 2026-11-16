import { createHash } from 'node:crypto';
import { PreviewError, inspectPng } from './png.mjs';
import { exampleDraft, validateDraft, objectKeys, renderDraft } from './draft.mjs';
import { draftStore } from './private-store.mjs';
import { servePanel, readJson } from './loopback.mjs';

export class CardEditor {
  constructor({ render = renderDraft, store = draftStore() } = {}) {
    this.render = render;
    this.store = store;
    this.draft = exampleDraft();
    this.revision = 1;
    this.renderedRevision = null;
    this.saved = null;
    this.image = null;
    this.error = null;
    this.closed = false;
    this.pending = false;
    this.rendering = null;
  }
  fail(error) {
    this.error = error instanceof PreviewError ? { code: error.code, message: error.message } :
      { code: 'editor_failed', message: 'Editor operation failed. Check the renderer or private storage; no printing was requested.' };
    if (!(error instanceof PreviewError)) console.error('pocket-card-editor: operation failed');
    return this.error;
  }
  state() {
    return {
      draft: this.draft, revision: this.revision, renderedRevision: this.renderedRevision,
      saved: this.saved, rendering: Boolean(this.rendering), error: this.error,
      image: this.image ? { ...inspectPng(this.image), sha256: createHash('sha256').update(this.image).digest('hex') } : null,
      printingAvailable: false
    };
  }
  changed() {
    this.revision++;
    this.renderedRevision = null;
    this.image = null;
    this.error = null;
  }
  async refresh() {
    this.pending = true;
    if (this.rendering) { await this.rendering; return this.state(); }
    this.rendering = (async () => {
      while (this.pending && !this.closed) {
        this.pending = false;
        const revision = this.revision;
        const draft = structuredClone(this.draft);
        try {
          const bytes = await this.render(draft);
          inspectPng(bytes);
          if (this.closed || revision !== this.revision) continue;
          this.image = bytes;
          this.renderedRevision = revision;
          this.error = null;
        } catch (error) {
          if (!this.closed && revision === this.revision) this.fail(error);
        }
      }
    })();
    try { await this.rendering; }
    finally { this.rendering = null; }
    return this.state();
  }
  async update(input) {
    objectKeys(input, ['revision', 'draft']);
    if (input.revision !== this.revision) throw new PreviewError('stale_draft', 'The draft changed. Refresh before editing it again.');
    this.changed();
    this.draft = validateDraft(input.draft);
    await this.refresh();
    return this.state();
  }
  async save(input) {
    objectKeys(input, ['revision', 'copy']);
    if (input.revision !== this.revision || typeof input.copy !== 'boolean') {
      throw new PreviewError('stale_draft', 'Save the latest draft revision.');
    }
    const revision = this.revision;
    const saved = await this.store.save({
      id: input.copy ? null : this.saved?.id ?? null,
      revision: input.copy ? null : this.saved?.revision ?? null,
      draft: structuredClone(this.draft)
    });
    if (this.closed || revision !== this.revision) throw new PreviewError('stale_draft', 'An earlier draft was saved; current unsaved edits were not overwritten.');
    this.saved = { id: saved.id, revision: saved.revision };
    return this.state();
  }
  async load(input) {
    objectKeys(input, ['revision', 'id']);
    if (input.revision !== this.revision) throw new PreviewError('stale_draft', 'Refresh before opening a saved draft.');
    this.changed();
    const revision = this.revision;
    const saved = await this.store.load(input.id);
    if (this.closed || revision !== this.revision) throw new PreviewError('stale_draft', 'The draft changed while opening; saved content was not applied.');
    this.draft = saved.draft;
    this.saved = { id: saved.id, revision: saved.revision };
    return this.refresh();
  }
  close() {
    this.closed = true;
    this.changed();
    this.draft = null;
  }
}

export function editorCanvas(ErrorType = PreviewError, options = {}) {
  const panels = new Map();
  async function get(id) {
    const panel = await panels.get(id);
    if (!panel || panel.editor.closed) throw new ErrorType('panel_closed', 'Open a card editor first.');
    return panel;
  }
  async function invoke(editor, name, input) {
    try {
      if (name === 'get_draft') { objectKeys(input, []); return editor.state(); }
      if (name === 'list_drafts') { objectKeys(input, []); return await editor.store.list(); }
      if (name === 'update_draft') return await editor.update(input);
      if (name === 'save_draft') return await editor.save(input);
      if (name === 'open_draft') return await editor.load(input);
      throw new PreviewError('unknown_action', 'Unsupported editor action.');
    } catch (error) {
      const failure = editor.fail(error);
      throw new ErrorType(failure.code, failure.message);
    }
  }
  const descriptions = {
    get_draft: 'Read this panel draft and preview state. No printer operation.',
    update_draft: 'Edit the draft at its current revision and render an updated preview. Never prints.',
    list_drafts: 'Explicitly list up to 20 private saved draft titles.',
    save_draft: 'Explicitly save this draft locally; copy:true creates a separate saved draft.',
    open_draft: 'Explicitly open a saved draft ID, replacing this panel draft. Never prints.'
  };
  const integer = { type: 'integer', minimum: 1 };
  const shapes = {
    get_draft: {}, list_drafts: {},
    update_draft: { revision: integer, draft: { type: 'object' } },
    save_draft: { revision: integer, copy: { type: 'boolean' } },
    open_draft: { revision: integer, id: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }
  };
  return {
    id: 'pocket-printer-editor', displayName: 'Pocket Card Editor',
    description: 'Edit a synthetic card, reorder sections, choose joke or Sudoku and explicitly save/open private local drafts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    actions: Object.entries(descriptions).map(([name, description]) => ({
      name, description,
      inputSchema: { type: 'object', properties: shapes[name], required: Object.keys(shapes[name]), additionalProperties: false },
      handler: async ctx => invoke((await get(ctx.instanceId)).editor, name, ctx.input)
    })),
    async open(ctx) {
      let pending = panels.get(ctx.instanceId);
      if (!pending) {
        if (panels.size >= 4) throw new ErrorType('panel_limit', 'Close an editor before opening another (maximum four).');
        pending = (async () => {
          const editor = new CardEditor(options);
          await editor.refresh();
          const server = await servePanel({
            assets: {
              '': ['editor.html', 'text/html; charset=utf-8'],
              'editor.js': ['editor.js', 'text/javascript; charset=utf-8'],
              'editor.css': ['editor.css', 'text/css; charset=utf-8'],
              'view.css': ['view.css', 'text/css; charset=utf-8']
            },
            get: (route, query) => {
              if (route === 'state') return { type: 'application/json', body: JSON.stringify(editor.state()) };
              if (route === 'image.png' && editor.image && String(editor.renderedRevision) === query.get('revision')) {
                return { type: 'image/png', body: editor.image };
              }
            },
            post: Object.fromEntries(Object.keys(descriptions).map(name =>
              [name, async req => invoke(editor, name, await readJson(req))])),
            onError: error => editor.fail(error)
          });
          return { editor, server };
        })();
        panels.set(ctx.instanceId, pending);
      }
      try {
        const panel = await pending;
        return { title: 'Pocket Card Editor', url: panel.server.url };
      } catch (error) {
        if (panels.get(ctx.instanceId) === pending) panels.delete(ctx.instanceId);
        throw error;
      }
    },
    async onClose(ctx) {
      const pending = panels.get(ctx.instanceId);
      if (!pending) return;
      panels.delete(ctx.instanceId);
      const panel = await pending;
      panel.editor.close();
      await panel.server.close();
    }
  };
}
