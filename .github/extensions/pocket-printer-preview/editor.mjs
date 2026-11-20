import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PreviewError, inspectPng } from './png.mjs';
import { exampleDraft, validateDraft, objectKeys, renderDraft } from './draft.mjs';
import { draftStore } from './private-store.mjs';
import { servePanel, readJson } from './loopback.mjs';

export class CardEditor {
  constructor({ render = renderDraft, store = draftStore(), printing = null } = {}) {
    this.render = render;
    this.store = store;
    this.draft = exampleDraft();
    this.revision = 1;
    this.renderedRevision = null;
    this.saved = null;
    this.image = null;
    this.imageMetadata = null;
    this.error = null;
    this.closed = false;
    this.pending = false;
    this.rendering = null;
    this.printing = typeof printing === 'function' ? printing() : printing;
    this.prepared = null;
    this.printGeneration = 0;
    this.dispatching = false;
    this.job = null;
    this.discovery = { state: 'idle', devices: [], message: 'Scan for compatible advertised BLE printers.' };
    this.scanId = null;
    this.selectedPrinter = null;
  }
  fail(error) {
    const diagnostic = typeof error.code === 'string' && /^[A-Z_]{1,40}$/.test(error.code) ? error.code :
      error instanceof TypeError ? 'TYPE_ERROR' : 'UNEXPECTED_ERROR';
    this.error = error instanceof PreviewError ? { code: error.code, message: error.message } :
      { code: 'editor_failed', message: `Editor operation failed (${diagnostic}). Check the renderer or private storage and inspect any existing job before continuing.` };
    if (!(error instanceof PreviewError)) console.error(`pocket-card-editor: ${diagnostic}`);
    return this.error;
  }
  state(browser = false) {
    const prepared = this.prepared;
    return {
      draft: this.draft, revision: this.revision, renderedRevision: this.renderedRevision,
      saved: this.saved, rendering: Boolean(this.rendering), error: this.error,
      image: this.imageMetadata,
      printingAvailable: Boolean(this.printing),
      discovery: this.discovery, selectedPrinter: this.selectedPrinter,
      prepared: prepared ? {
        jobId: prepared.intent.jobId, target: prepared.intent.target, digest: prepared.intent.digest,
        bitmapDigest: prepared.intent.bitmapDigest, revision: prepared.revision,
        mode: prepared.intent.mode, inspectionId: prepared.inspectionId, claimed: prepared.claimed,
        health: prepared.health, estimatedPaperMm: prepared.estimatedPaperMm,
        ...(browser && !prepared.claimed ? { approvalToken: prepared.approvalToken } : {})
      } : null,
      dispatching: this.dispatching, job: this.job
    };
  }
  changed() {
    this.revision++;
    this.renderedRevision = null;
    this.image = null;
    this.imageMetadata = null;
    this.error = null;
    this.invalidatePrint();
  }
  invalidatePrint() { this.printGeneration++; this.prepared = null; }
  mutable() {
    if (this.closed) throw new PreviewError('panel_closed', 'This panel was closed.');
    if (this.dispatching) throw new PreviewError('dispatch_in_progress', 'A confirmed dispatch is being recorded. Wait before changing this draft.');
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
          const metadata = inspectPng(bytes);
          if (this.closed || revision !== this.revision) continue;
          this.image = bytes;
          this.imageMetadata = { ...metadata, sha256: createHash('sha256').update(bytes).digest('hex') };
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
    this.mutable();
    objectKeys(input, ['revision', 'draft']);
    if (input.revision !== this.revision) throw new PreviewError('stale_draft', 'The draft changed. Refresh before editing it again.');
    // Even rejected local edits must not leave the previous bitmap approved as current.
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
    this.mutable();
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
  async inspectForPrint(input, { copyOf, recoverLatest } = {}) {
    this.mutable();
    objectKeys(input, ['revision', 'target']);
    this.invalidatePrint();
    if (!input.target) throw new PreviewError('printer_required', 'Select a printer before refreshing the print preview.');
    if (!this.printing || input.revision !== this.revision || this.renderedRevision !== this.revision || !this.image) {
      throw new PreviewError('preview_not_ready', 'Render the current draft before inspecting for printing.');
    }
    const revision = this.revision, generation = this.printGeneration;
    const current = () => {
      if (this.closed || revision !== this.revision || generation !== this.printGeneration) {
        throw new PreviewError('stale_preview', 'Draft or target changed during inspection. Inspect again.');
      }
    };
    const result = await this.printing.inspect({ original: this.image, target: input.target, revision, current, copyOf, recoverLatest });
    current();
    this.prepared = { ...result, revision, inspectionId: randomBytes(16).toString('hex'),
      approvalToken: randomBytes(32).toString('hex'),
      estimatedPaperMm: inspectPng(Buffer.from(result.intent.preview, 'base64')).estimatedPaperMm };
    this.error = null;
    return this.state();
  }
  async startScan(input) {
    this.mutable(); objectKeys(input, []);
    if (['scanning', 'stopping'].includes(this.discovery.state)) {
      throw new PreviewError('discovery_busy', 'Wait for the current scan to stop.');
    }
    this.invalidatePrint(); this.selectedPrinter = null;
    const scanId = randomUUID();
    this.scanId = scanId;
    this.discovery = { scanId, state: 'scanning', devices: [], message: 'Starting printer discovery...' };
    try {
      const result = await this.printing.discovery('start_discovery', scanId);
      if (this.closed) {
        await this.printing.discovery('stop_discovery', scanId);
        throw new PreviewError('panel_closed', 'The panel closed; printer discovery was stopped.');
      }
      this.discovery = result; this.error = null;
      return this.state();
    } catch (error) {
      this.discovery = { scanId, state: 'error', devices: [], message: 'Discovery unavailable. Check the error before scanning again.' };
      throw error;
    }
  }
  async scanStatus(input, stop = false) {
    objectKeys(input, []);
    const scanId = this.scanId;
    if (!scanId) throw new PreviewError('unknown_scan', 'Choose Scan for printers first.');
    try {
      const result = await this.printing.discovery(stop ? 'stop_discovery' : 'discovery_status', scanId);
      if (scanId !== this.scanId) throw new PreviewError('stale_scan', 'A newer scan replaced this result.');
      this.discovery = result;
    } catch (error) {
      if (scanId === this.scanId) this.discovery = { ...this.discovery, state: 'error', message: 'Scan status unavailable. Stop the scan or try again explicitly.' };
      throw error;
    }
    this.error = null;
    return this.state();
  }
  selectPrinter(input) {
    this.mutable(); objectKeys(input, ['id']);
    this.invalidatePrint();
    const device = this.discovery.devices.find(value => value.id === input.id);
    if (input.id && !device) throw new PreviewError('unknown_printer', 'Choose a printer from this scan, or scan again.');
    this.selectedPrinter = device ?? null;
    this.error = null;
    return this.state();
  }
  async confirmPrint(input) {
    objectKeys(input, ['revision', 'jobId', 'target', 'digest', 'bitmapDigest', 'inspectionId', 'approvalToken', 'paperApproved']);
    const prepared = this.prepared;
    if (!this.printing || !prepared || prepared.claimed || input.paperApproved !== true ||
        typeof input.approvalToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.approvalToken) ||
        !timingSafeEqual(Buffer.from(input.approvalToken), Buffer.from(prepared.approvalToken)) ||
        input.jobId !== prepared.intent.jobId || input.target !== prepared.intent.target ||
        input.digest !== prepared.intent.digest || input.bitmapDigest !== prepared.intent.bitmapDigest ||
        input.inspectionId !== prepared.inspectionId || input.revision !== prepared.revision) {
      throw new PreviewError('approval_required', 'Explicit approval of this exact inspected image and target is required.');
    }
    const current = () => {
      if (this.closed || this.prepared !== prepared || this.revision !== prepared.revision ||
          this.renderedRevision !== this.revision || !this.image ||
          createHash('sha256').update(this.image).digest('hex') !== prepared.intent.digest) {
        throw new PreviewError('stale_approval', 'The approved image is no longer current. Nothing was dispatched.');
      }
    };
    current();
    if (this.dispatching) throw new PreviewError('dispatch_in_progress', 'This confirmed job is already being dispatched. Query its status.');
    this.dispatching = true;
    // Consume this panel's approval before any await. The durable ledger independently gates other panels.
    prepared.claimed = true;
    try { this.job = await this.printing.dispatch(prepared.intent, current); }
    finally { this.dispatching = false; }
    return this.state();
  }
  async close() {
    this.closed = true;
    this.changed();
    this.draft = null;
    if (this.scanId && ['scanning', 'stopping', 'error'].includes(this.discovery.state)) {
      try { await this.scanStatus({}, true); } catch (error) { this.fail(error); }
    }
  }
}

export function editorCanvas(ErrorType = PreviewError, options = {}) {
  const panels = new Map();
  async function get(id) {
    const panel = await panels.get(id);
    if (!panel || panel.editor.closed) throw new ErrorType('panel_closed', 'Open a card editor first.');
    return panel;
  }
  async function invoke(editor, name, input, sdk = false) {
    try {
      if (name === 'get_draft') { objectKeys(input, []); return editor.state(); }
      if (name === 'list_drafts') { objectKeys(input, []); return await editor.store.list(); }
      if (name === 'update_draft') return await editor.update(input);
      if (name === 'save_draft') return await editor.save(input);
      if (name === 'open_draft') return await editor.load(input);
      if (name === 'inspect_for_print') return await editor.inspectForPrint(input);
      if (name === 'invalidate_print') { objectKeys(input, []); editor.invalidatePrint(); return editor.state(); }
      if (name === 'get_print_status') {
        objectKeys(input, ['jobId']);
        editor.job = await editor.printing.status(input.jobId);
        return editor.state();
      }
      if (name === 'list_prints') { objectKeys(input, []); return await editor.printing.ledger.list(); }
      throw new PreviewError('unknown_action', 'Unsupported editor action.');
    } catch (error) {
      // HTTP has its own error boundary. Wrapping twice loses the original typed failure.
      if (!sdk) throw error;
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
  if (options.printing) {
    Object.assign(descriptions, {
      inspect_for_print: 'Inspect the current image with the independently running helper and explicit target. Does not print.',
      invalidate_print: 'Discard the current inspection/approval; does not cancel an already admitted job.',
      get_print_status: 'Query the original durable job ID. Never submit, retry or replace it.',
      list_prints: 'Explicitly list retained local print intent IDs for recovery. Never prints.'
    });
    Object.assign(shapes, {
      inspect_for_print: { revision: integer, target: { type: 'string', pattern: '^[a-f0-9-]{36}$' } },
      invalidate_print: {}, get_print_status: { jobId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }, list_prints: {}
    });
  }
  return {
    id: 'pocket-printer-editor', displayName: 'Pocket Card Editor',
    description: 'Edit a synthetic card, reorder sections, choose joke or Sudoku and explicitly save/open private local drafts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    actions: Object.entries(descriptions).map(([name, description]) => ({
      name, description,
      inputSchema: { type: 'object', properties: shapes[name], required: Object.keys(shapes[name]), additionalProperties: false },
      handler: async ctx => invoke((await get(ctx.instanceId)).editor, name, ctx.input, true)
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
              if (route === 'state') return { type: 'application/json', body: JSON.stringify(editor.state(true)) };
              if (route === 'image.png' && editor.image && String(editor.renderedRevision) === query.get('revision')) {
                return { type: 'image/png', body: editor.image };
              }
              if (route === 'print-preview.png' && editor.prepared?.inspectionId === query.get('inspection')) {
                return { type: 'image/png', body: Buffer.from(editor.prepared.intent.preview, 'base64') };
              }
            },
            post: {
              ...Object.fromEntries(Object.keys(descriptions).map(name =>
                [name, async req => {
                  const result = await invoke(editor, name, await readJson(req));
                  return Array.isArray(result) ? result : editor.state(true);
                }])),
              ...(editor.printing ? {
                start_scan: async req => { await editor.startScan(await readJson(req)); return editor.state(true); },
                scan_status: async req => { await editor.scanStatus(await readJson(req)); return editor.state(true); },
                stop_scan: async req => { await editor.scanStatus(await readJson(req), true); return editor.state(true); },
                select_printer: async req => { editor.selectPrinter(await readJson(req)); return editor.state(true); },
                discard_unsubmitted: async req => {
                  const input = await readJson(req);
                  objectKeys(input, ['jobId', 'confirmed']);
                  if (input.confirmed !== true) throw new PreviewError('confirmation_required', 'Explicit confirmation is required to discard an unsubmitted intent.');
                  const result = await editor.printing.ledger.discardUnsubmitted(input.jobId);
                  if (editor.prepared?.intent.jobId === input.jobId) editor.invalidatePrint();
                  return result;
                },
                confirm_print: async req => {
                  await editor.confirmPrint(await readJson(req));
                  return editor.state(true);
                }
              } : {})
            },
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
      await panel.editor.close();
      await panel.server.close();
    }
  };
}
