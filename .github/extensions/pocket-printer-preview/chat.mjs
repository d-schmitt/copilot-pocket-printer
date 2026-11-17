import { CardEditor } from './editor.mjs';
import { objectKeys } from './draft.mjs';
import { PreviewError } from './png.mjs';
import { documentSchema, documentIdSchema, requireDocumentId, documentTemplate, renderDocument, documentStore } from './document.mjs';
import { servePanel, readJson } from './loopback.mjs';

export class ChatDocument extends CardEditor {
  constructor(id, options = {}) {
    super({ ...options, render: options.render ?? renderDocument });
    this.documentId = id;
    this.documents = options.documents ?? documentStore(id);
    this.draft = null;
    this.revision = 0;
  }
  state(browser = false) {
    const { draft, saved, ...state } = super.state(browser);
    return { ...state, documentId: this.documentId, document: draft };
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
      let document = null, error = null;
      try { documentTemplate(input.document); document = structuredClone(input.document); }
      catch (failure) {
        if (!(failure instanceof PreviewError)) throw failure;
        error = { code: failure.code, message: failure.message };
      }
      record = { id: this.documentId, revision: previous.revision + 1, document, error };
      // Persist invalidation too: another panel must never print the previous content after a rejected edit.
      await this.documents.write(record);
      this.invalidatePrint();
    });
    await this.adopt(record);
    if (this.error) throw new PreviewError(this.error.code, this.error.message);
    return this.state();
  }
  async inspectSelected(input) {
    return this.documents.locked(async () => {
      await this.sync();
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
    ['update_document', 'Replace the complete text/checklist document at its current revision. Preserve all requested content; never summarize to fit. Renders offline, never prints.',
      { revision: { type: 'integer', minimum: 1 }, document: documentSchema }],
    ['get_print_status', 'Query a retained job without retrying or submitting it.', { jobId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }],
    ['list_prints', 'Read retained print IDs for recovery. Never submits or deletes.', {}]
  ];
  return {
    id: 'pocket-printer-chat', displayName: 'Pocket Printer V2',
    description: 'Describe text or checklists in Copilot chat, update this document, then let the user review one exact preview and click Print.',
    inputSchema: shape({ documentId: documentIdSchema }),
    actions: actions.map(([name, description, properties]) => ({
      name, description, inputSchema: shape(properties),
      handler: async ctx => {
        const { editor } = await get(ctx.instanceId);
        try { return await invoke(editor, name, ctx.input); }
        catch (error) { const failure = editor.fail(error); throw new ErrorType(failure.code, failure.message); }
      }
    })),
    async open(ctx) {
      objectKeys(ctx.input, ['documentId']);
      requireDocumentId(ctx.input.documentId);
      let pending = panels.get(ctx.instanceId);
      if (!pending) {
        if (panels.size >= 4) throw new ErrorType('panel_limit', 'Close a V2 panel before opening another (maximum four).');
        pending = (async () => {
          const editor = new ChatDocument(ctx.input.documentId, options);
          await editor.adopt(await editor.documents.initialize());
          const server = await servePanel({
            assets: { '': ['chat.html', 'text/html; charset=utf-8'],
              'chat.js': ['chat.js', 'text/javascript; charset=utf-8'],
              'chat.css': ['chat.css', 'text/css; charset=utf-8'] },
            get: async (route, query) => {
              await editor.sync();
              if (route === 'state') return { type: 'application/json', body: JSON.stringify(editor.state(true)) };
              if (route === 'image.png' && editor.image && String(editor.renderedRevision) === query.get('revision')) {
                return { type: 'image/png', body: editor.image };
              }
              if (route === 'print-preview.png' && editor.prepared?.inspectionId === query.get('inspection')) {
                return { type: 'image/png', body: Buffer.from(editor.prepared.intent.preview, 'base64') };
              }
            },
            post: Object.fromEntries([
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
        if (panel.editor.documentId !== ctx.input.documentId) throw new ErrorType('document_conflict', 'Use a new panel for a different document.');
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
