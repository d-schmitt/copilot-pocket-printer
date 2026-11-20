import { CardEditor } from './editor.mjs';
import { randomInt, randomUUID } from 'node:crypto';
import { objectKeys } from './draft.mjs';
import { PreviewError } from './png.mjs';
import { documentSchema, documentIdSchema, requireDocumentId, validateDocument, renderDocument, documentStore, recordFlow } from './document.mjs';
import { templateNames, templateOf, templateDocument, revealTemplate } from './templates.mjs';
import { fixedDigest } from './fixed-template.mjs';
import { servePanel, readJson } from './loopback.mjs';

export class ChatDocument extends CardEditor {
  constructor(id, options = {}) {
    super({ ...options, render: options.render ?? renderDocument });
    this.documentId = id;
    this.documents = options.documents ?? documentStore(id);
    this.draft = null;
    this.revision = 0;
    this.flow = { template: null, customized: false, surpriseSeed: null };
    this.view = 'gallery';
    this.revealedRevision = null;
    this.pendingReplacement = null;
    this.lastSavedDraft = null;
    this.drawSeed = options.drawSeed ?? (() => randomInt(0x100000000));
    this.render = document => document.layout !== revealTemplate && options.render
      ? options.render(document) : renderDocument(document, { surpriseSeed: this.flow.surpriseSeed });
  }
  fixedTemplate() { return this.draft?.layout === revealTemplate; }
  openForPrint() {
    return this.view === 'preview' && !this.pendingReplacement &&
      (this.flow.template !== 'surprise' || this.revealedRevision === this.revision);
  }
  previewVisible() { return this.openForPrint() && !this.fixedTemplate(); }
  requirePrintView() {
    if (!this.openForPrint()) throw new PreviewError('preview_hidden', 'Open this card and reveal its current preview before preparing or approving a print.');
    if (this.fixedTemplate() && this.imageMetadata?.sha256 !== fixedDigest) {
      throw new PreviewError('preview_not_ready', 'The current fixed template did not render. Nothing was approved.');
    }
  }
  state(browser = false) {
    const { draft, saved, ...state } = super.state(browser);
    const fixed = this.fixedTemplate();
    let prepared = this.openForPrint() ? state.prepared : null;
    if (fixed) {
      if (browser && prepared?.digest === fixedDigest) {
        const { estimatedPaperMm, ...approval } = prepared;
        prepared = approval;
      } else prepared = null;
    }
    return { ...state, image: this.previewVisible() ? state.image : null,
      prepared,
      documentId: this.documentId, document: draft,
      flow: { template: this.flow.template, customized: this.flow.customized, view: this.view,
        hidden: this.flow.template === 'surprise' && this.revealedRevision !== this.revision,
        pendingReplacement: this.pendingReplacement, lastSavedDraft: this.lastSavedDraft } };
  }
  fail(error) {
    if (!(error instanceof PreviewError)) {
      const code = typeof error.code === 'string' ? error.code : 'unknown';
      const messages = {
        ENOENT: 'The renderer, document or independently running helper is unavailable.',
        EACCES: 'Private document storage is not accessible.',
        helper_not_running: 'Open Pocket Printer Helper independently, then refresh the print preview.',
        ipc_timeout: 'The helper did not answer. Check the original job before retrying any operation.'
      };
      return super.fail(new PreviewError('chat_operation_failed',
        `${messages[code] ?? 'The chat canvas operation failed.'} (${/^[a-zA-Z0-9_]+$/.test(code) ? code : 'unknown'}). No automatic retry.`));
    }
    return super.fail(error);
  }
  async adopt(record) {
    if (this.closed || record.revision <= this.revision) return;
    this.changed();
    this.revision = record.revision;
    this.draft = record.document;
    this.flow = recordFlow(record);
    this.revealedRevision = null;
    this.pendingReplacement = null;
    this.error = record.error;
    if (this.draft && !this.error) await this.refresh();
  }
  async sync() { await this.adopt(await this.documents.load()); return this.state(); }
  async updateDocument(input) {
    this.mutable();
    objectKeys(input, ['revision', 'document']);
    let record;
    await this.documents.locked(async () => {
      const previous = await this.documents.load();
      if (input.revision !== previous.revision) throw new PreviewError('stale_document', 'This document changed in another panel. Read get_document before revising it.');
      const previousFlow = recordFlow(previous);
      if (previousFlow.template === revealTemplate || templateOf(input.document) === revealTemplate) {
        throw new PreviewError('fixed_template', 'Vortragsnotiz cannot be edited in chat. Choose a template to change cards.');
      }
      if (previousFlow.customized && previousFlow.template && previousFlow.template !== templateOf(input.document)) {
        throw new PreviewError('replacement_required', 'This card has chat edits. Request a template change and let the user choose Save as draft, Replace without saving or Cancel.');
      }
      let document = previous.document, error = null;
      try { validateDocument(input.document); document = structuredClone(input.document); }
      catch (failure) {
        if (!(failure instanceof PreviewError)) throw failure;
        error = { code: failure.code, message: `${failure.message} Previous content is retained, but its preview is invalidated.` };
      }
      const template = document ? templateOf(document) : previousFlow.template;
      record = { id: this.documentId, revision: previous.revision + 1, document, error,
        flow: { template, customized: true, surpriseSeed: template === 'surprise' ? this.drawSeed() : null } };
      // Rejected edits invalidate printing durably without destroying recoverable customized content.
      await this.documents.write(record);
      this.invalidatePrint();
    });
    this.view = 'preview';
    await this.adopt(record);
    if (this.error) throw new PreviewError(this.error.code, this.error.message);
    return this.state();
  }
  async requestReplacement(input, kind = 'template') {
    this.mutable();
    objectKeys(input, kind === 'template' ? ['revision', 'template'] : ['revision', 'savedId']);
    if (kind === 'template' && !templateNames.includes(input.template)) {
      throw new PreviewError('unknown_template', 'Choose Daily card, Focus list or Vortragsnotiz.');
    }
    let record;
    await this.documents.locked(async () => {
      const previous = await this.documents.load();
      if (input.revision !== previous.revision) throw new PreviewError('stale_document', 'The card changed. Read the latest revision before switching.');
      await this.adopt(previous);
      this.invalidatePrint();
      this.revealedRevision = null;
      if (kind === 'template' && this.flow.template === input.template && this.draft) {
        this.pendingReplacement = null; this.view = 'preview'; return;
      }
      const request = { requestId: randomUUID(), revision: previous.revision, kind,
        ...(kind === 'template' ? { template: input.template } : { savedId: input.savedId }) };
      if (kind === 'saved') await this.documents.loadSaved(input.savedId);
      if (recordFlow(previous).customized) { this.pendingReplacement = request; return; }
      record = await this.replacementRecord(previous, request);
      await this.documents.write(record);
    });
    if (record) { this.view = 'preview'; await this.adopt(record); }
    return this.state();
  }
  async replacementRecord(previous, request) {
    const saved = request.kind === 'saved' ? await this.documents.loadSaved(request.savedId) : null;
    const document = saved ? saved.document : templateDocument(request.template);
    const flow = saved ? recordFlow(saved) :
      { template: request.template, customized: false, surpriseSeed: request.template === 'surprise' ? this.drawSeed() : null };
    return { id: this.documentId, revision: previous.revision + 1, document, error: saved?.error ?? null, flow };
  }
  async resolveReplacement(input) {
    this.mutable(); objectKeys(input, ['requestId', 'decision']);
    const request = this.pendingReplacement;
    if (!request || request.requestId !== input.requestId || !['save', 'replace', 'cancel'].includes(input.decision)) {
      throw new PreviewError('replacement_required', 'Choose an option for the current replacement prompt.');
    }
    if (input.decision === 'cancel') {
      this.pendingReplacement = null; this.view = this.draft ? 'preview' : 'gallery';
      return this.state();
    }
    let record;
    await this.documents.locked(async () => {
      const previous = await this.documents.load();
      if (previous.revision !== request.revision) {
        await this.adopt(previous);
        throw new PreviewError('stale_replacement', 'The card changed after the question was shown. Choose a template again.');
      }
      if (input.decision === 'save') this.lastSavedDraft = await this.documents.saveSnapshot(previous);
      record = await this.replacementRecord(previous, request);
      await this.documents.write(record);
      this.invalidatePrint();
    });
    this.view = 'preview'; await this.adopt(record);
    return this.state();
  }
  backToTemplates(input) {
    this.mutable(); objectKeys(input, []);
    this.view = 'gallery'; this.revealedRevision = null; this.pendingReplacement = null;
    this.invalidatePrint();
    return this.state();
  }
  resumePreview(input) {
    this.mutable(); objectKeys(input, []);
    if (!this.draft) throw new PreviewError('document_required', 'Choose a template first.');
    this.view = 'preview'; this.pendingReplacement = null;
    return this.state();
  }
  async reveal(input) {
    this.mutable(); objectKeys(input, ['revision']);
    await this.sync();
    if (this.view !== 'preview' || this.pendingReplacement || input.revision !== this.revision ||
        this.flow.template !== 'surprise' || this.renderedRevision !== this.revision || !this.image) {
      throw new PreviewError('preview_not_ready', 'Wait for the current Surprise to render before revealing it.');
    }
    this.revealedRevision = this.revision;
    this.error = null;
    return this.state();
  }
  async inspectSelected(input) {
    return this.documents.locked(async () => {
      await this.sync();
      this.requirePrintView();
      if (!this.selectedPrinter || input.target !== this.selectedPrinter.id) {
        throw new PreviewError('printer_required', 'Select a discovered printer in this panel first.');
      }
      if (['scanning', 'stopping'].includes(this.discovery.state)) {
        throw new PreviewError('discovery_busy', 'Wait for printer discovery to stop.');
      }
      return super.inspectForPrint(input);
    });
  }
  async confirmPrint(input) {
    // Keep the content revision locked through the shared durable claim boundary across all providers.
    return this.documents.locked(async () => {
      await this.sync();
      this.requirePrintView();
      if (this.fixedTemplate() && this.prepared?.intent.digest !== fixedDigest) {
        throw new PreviewError('approval_required', 'Explicit approval of the fixed template and target is required.');
      }
      if (input.target !== this.selectedPrinter?.id) throw new PreviewError('stale_approval', 'The selected printer changed.');
      return super.confirmPrint(input);
    });
  }
}

const shape = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export function chatCanvas(ErrorType = PreviewError, options = {}) {
  const panels = new Map();
  async function get(id) {
    const panel = await panels.get(id);
    if (!panel) throw new ErrorType('panel_closed', 'Open the chat-to-print canvas first.');
    return panel;
  }
  async function invoke(editor, name, input) {
    if (name === 'update_document') return editor.updateDocument(input);
    if (name === 'get_document') { objectKeys(input, []); return editor.sync(); }
    if (name === 'request_template') return editor.requestReplacement(input);
    if (name === 'list_saved_documents') { objectKeys(input, []); return editor.documents.locked(() => editor.documents.listSaved()); }
    if (name === 'open_saved_document') return editor.requestReplacement(input, 'saved');
    if (name === 'get_print_status') {
      objectKeys(input, ['jobId']);
      editor.job = await editor.printing.status(input.jobId);
      return editor.state();
    }
    if (name === 'list_prints') { objectKeys(input, []); return editor.printing.ledger.list(); }
    throw new PreviewError('unknown_action', 'Unsupported chat canvas action.');
  }
  const actions = [
    ['get_document', 'Read the document, revision and preview state before making a revision. Never prints.', {}],
    ['update_document', 'Revise the active card using daily-card offline inputs, focus with exactly three priorities, surprise with an optional message, or generic text/checklist blocks. Chat edits customize content; Surprise rerolls and hides until user reveal. Request template changes separately. Never prints.',
      { revision: { type: 'integer', minimum: 1 }, document: documentSchema }],
    ['request_template', 'Choose Daily card, Focus list or fixed Vortragsnotiz. Legacy Surprise remains supported. Customized cards require a user decision in the canvas before replacement.',
      { revision: { type: 'integer', minimum: 1 }, template: { enum: templateNames } }],
    ['list_saved_documents', 'List private saved card snapshots for this document. Never prints.', {}],
    ['open_saved_document', 'Open a saved card snapshot; prompts in the canvas before replacing chat-customized content.',
      { revision: { type: 'integer', minimum: 1 }, savedId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }],
    ['get_print_status', 'Query a retained job without retrying or submitting it.', { jobId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }],
    ['list_prints', 'Read retained print IDs for recovery. Never submits or deletes.', {}]
  ];
  return {
    id: 'pocket-printer-chat', displayName: 'Pocket Printer V2',
    description: 'Choose Daily card, Focus list or Vortragsnotiz. The user reviews the exact preview before Print, except for the fixed Vortragsnotiz paper reveal.',
    inputSchema: { type: ['object', 'null'], properties: { documentId: documentIdSchema },
      required: [], additionalProperties: false },
    actions: actions.map(([name, description, properties]) => ({
      name, description, inputSchema: shape(properties),
      handler: async ctx => {
        const { editor } = await get(ctx.instanceId);
        try { return await invoke(editor, name, ctx.input); }
        catch (error) { const failure = editor.fail(error); throw new ErrorType(failure.code, failure.message); }
      }
    })),
    async open(ctx) {
      const input = ctx.input ?? {};
      const hasDocumentId = Object.hasOwn(input, 'documentId');
      objectKeys(input, hasDocumentId ? ['documentId'] : []);
      const documentId = hasDocumentId ? input.documentId : 'project-chat-v2';
      requireDocumentId(documentId);
      let pending = panels.get(ctx.instanceId);
      if (!pending) {
        if (panels.size >= 4) throw new ErrorType('panel_limit', 'Close a V2 panel before opening another (maximum four).');
        pending = (async () => {
          const editor = new ChatDocument(documentId, options);
          await editor.adopt(await editor.documents.initialize());
          const server = await servePanel({
            assets: { '': ['chat.html', 'text/html; charset=utf-8'],
              'chat.js': ['chat.js', 'text/javascript; charset=utf-8'],
              'chat.css': ['chat.css', 'text/css; charset=utf-8'],
              'template-cover.png': ['template-cover.png', 'image/png'] },
            get: async (route, query) => {
              await editor.sync();
              if (route === 'state') return { type: 'application/json', body: JSON.stringify(editor.state(true)) };
              if (route === 'image.png' && editor.previewVisible() && editor.image && String(editor.renderedRevision) === query.get('revision')) {
                return { type: 'image/png', body: editor.image };
              }
              if (route === 'print-preview.png' && editor.previewVisible() && editor.prepared?.inspectionId === query.get('inspection')) {
                return { type: 'image/png', body: Buffer.from(editor.prepared.intent.preview, 'base64') };
              }
            },
            post: Object.fromEntries([
              ['request_template', input => editor.requestReplacement(input)],
              ['resolve_replacement', input => editor.resolveReplacement(input)],
              ['back_to_templates', input => editor.backToTemplates(input)],
              ['resume_preview', input => editor.resumePreview(input)],
              ['reveal_preview', input => editor.reveal(input)],
              ['start_scan', input => editor.startScan(input)],
              ['scan_status', input => editor.scanStatus(input)],
              ['stop_scan', input => editor.scanStatus(input, true)],
              ['select_printer', input => editor.selectPrinter(input)],
              ['inspect_for_print', input => editor.inspectSelected(input)],
              ['confirm_print', input => editor.confirmPrint(input)],
              ['get_print_status', input => invoke(editor, 'get_print_status', input)]
            ].map(([name, operation]) => [name, async req => {
              await operation(await readJson(req));
              return editor.state(true);
            }])),
            onError: error => editor.fail(error)
          });
          return { editor, server };
        })();
        panels.set(ctx.instanceId, pending);
      }
      try {
        const panel = await pending;
        if (panel.editor.documentId !== documentId) throw new ErrorType('document_conflict', 'Use a new panel for a different document.');
        return { title: 'Pocket Printer V2', url: panel.server.url };
      } catch (error) {
        if (error.code !== 'document_conflict' && panels.get(ctx.instanceId) === pending) panels.delete(ctx.instanceId);
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
