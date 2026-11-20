import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { objectKeys, renderTemplate } from './draft.mjs';
import { PreviewError } from './png.mjs';
import { storeRoot, privateDirectory, readRecord, writeRecord, withStoreLock, requireId } from './private-store.mjs';
import { dailyDocumentSchema, validateDailyDocument, dailyDocumentTemplate } from './daily-document.mjs';
import { focusSchema, surpriseSchema, templateOf, validateTemplateDocument, templateBlocks, revealTemplate } from './templates.mjs';
import { renderFixedTemplate } from './fixed-template.mjs';

const textSchema = { type: 'string', minLength: 1, maxLength: 4096 };
const genericDocumentSchema = {
  type: 'object', additionalProperties: false, required: ['version', 'blocks'],
  properties: {
    version: { const: 1 },
    blocks: { type: 'array', minItems: 1, maxItems: 64, items: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['kind', 'text'],
        properties: { kind: { enum: ['heading', 'text'] }, text: textSchema } },
      { type: 'object', additionalProperties: false, required: ['kind', 'items'],
        properties: { kind: { const: 'checklist' }, items: {
          type: 'array', minItems: 1, maxItems: 64, items: {
            type: 'object', additionalProperties: false, required: ['text', 'checked'],
            properties: { text: textSchema, checked: { type: 'boolean' } }
          }
        } } }
    ] } }
  }
};
export const documentSchema = { oneOf: [genericDocumentSchema, dailyDocumentSchema, focusSchema, surpriseSchema] };
export const documentIdSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' };
export function requireDocumentId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new PreviewError('invalid_document_id', 'Use a stable document name of 1-64 lowercase letters, digits or hyphens.');
  }
}
function text(value, limit = 4096) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit ||
      /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
    throw new PreviewError('invalid_document', `Text must contain 1-${limit} UTF-8 bytes with no control characters except newlines and tabs.`);
  }
  return value;
}
export function documentTemplate(value) {
  objectKeys(value, ['version', 'blocks']);
  if (value.version !== 1 || !Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 64) {
    throw new PreviewError('invalid_document', 'Use version 1 and 1-64 heading, text or checklist blocks.');
  }
  const blocks = [];
  for (const block of value.blocks) {
    if (block?.kind === 'heading' || block?.kind === 'text') {
      objectKeys(block, ['kind', 'text']);
      // The existing 18-dot preset keeps thin strokes readable without any fit-to-page shrinking.
      blocks.push({ kind: 'text', text: text(block.text), style: block.kind === 'heading' ? 'title' : 'heading' });
    } else if (block?.kind === 'checklist') {
      objectKeys(block, ['kind', 'items']);
      if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 64) {
        throw new PreviewError('invalid_document', 'A checklist needs 1-64 items.');
      }
      for (const item of block.items) {
        objectKeys(item, ['text', 'checked']);
        if (typeof item.checked !== 'boolean') throw new PreviewError('invalid_document', 'Checklist checked must be true or false.');
        blocks.push({ kind: 'text', text: `${item.checked ? '[x]' : '[ ]'} ${text(item.text, 4092)}`, style: 'heading' });
      }
    } else throw new PreviewError('invalid_document', 'Only headings, plain text and checklists are supported.');
  }
  const template = { version: 1, blocks };
  if (blocks.length > 128 || Buffer.byteLength(JSON.stringify(template)) > 60 * 1024 ||
      Buffer.byteLength(JSON.stringify(value)) > 60 * 1024) {
    throw new PreviewError('document_too_large', 'Use fewer items or less text (128 rendered blocks and 60 KiB maximum). Nothing was shortened.');
  }
  return template;
}
export function validateDocument(document) {
  if (document?.layout === 'daily-card') validateDailyDocument(document);
  else if (['focus', 'surprise', revealTemplate].includes(document?.layout)) validateTemplateDocument(document);
  else documentTemplate(document);
}
export async function renderDocument(document, { surpriseSeed } = {}) {
  if (document?.layout === revealTemplate) {
    validateTemplateDocument(document);
    return renderFixedTemplate();
  }
  return renderTemplate(document?.layout === 'daily-card'
    ? await dailyDocumentTemplate(document) : ['focus', 'surprise'].includes(document?.layout)
      ? templateBlocks(document, surpriseSeed) : documentTemplate(document));
}
export function recordFlow(record) {
  // Previously saved chat documents predate provenance; conservatively protect them as customized.
  return record.flow ?? { template: templateOf(record.document), customized: Boolean(record.document), surpriseSeed: null };
}
function validateRecord(record, id) {
  objectKeys(record, ['id', 'revision', 'document', 'error', ...(Object.hasOwn(record, 'flow') ? ['flow'] : [])]);
  if (record.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      (record.error !== null && (typeof record.error?.code !== 'string' || typeof record.error?.message !== 'string'))) {
    throw new PreviewError('invalid_storage', 'Chat document identity or revision is invalid.');
  }
  if (record.document !== null) validateDocument(record.document);
  const flow = recordFlow(record);
  objectKeys(flow, ['template', 'customized', 'surpriseSeed']);
  if (![null, 'custom', 'daily', 'focus', 'surprise', revealTemplate].includes(flow.template) ||
      typeof flow.customized !== 'boolean' || (record.document && templateOf(record.document) !== flow.template) ||
      (flow.template === 'surprise' ? !Number.isInteger(flow.surpriseSeed) || flow.surpriseSeed < 0 || flow.surpriseSeed > 0xffffffff
        : flow.surpriseSeed !== null)) {
    throw new PreviewError('invalid_storage', 'Stored template provenance or Surprise draw is invalid.');
  }
  return record;
}

// Separate content records, but the existing global print ledger remains the only dispatch authority.
export function documentStore(id, root = storeRoot) {
  requireDocumentId(id);
  const directory = join(root, 'chat-documents', id);
  const path = join(directory, 'document.json');
  const savedDirectory = join(directory, 'saved');
  async function prepare() {
    await privateDirectory(root);
    await privateDirectory(join(root, 'chat-documents'));
    await privateDirectory(directory);
  }
  async function load() {
    return validateRecord(await readRecord(path, 64 * 1024), id);
  }
  async function savedNames() {
    await privateDirectory(savedDirectory);
    const names = await readdir(savedDirectory);
    if (names.some(name => !/^[a-f0-9-]{36}\.json$/.test(name)) || names.length > 20) {
      throw new PreviewError('invalid_storage', 'Saved card storage contains unexpected files or exceeds its 20-card limit.');
    }
    return names;
  }
  async function loadSaved(savedId) {
    requireId(savedId);
    await privateDirectory(savedDirectory);
    return validateRecord(await readRecord(join(savedDirectory, `${savedId}.json`), 64 * 1024), id);
  }
  return {
    load, loadSaved,
    async listSaved() {
      const result = [];
      for (const name of await savedNames()) {
        const savedId = name.slice(0, -5), record = await loadSaved(savedId);
        result.push({ savedId, template: recordFlow(record).template, revision: record.revision });
      }
      return result;
    },
    // Called under the document lock before replacing its current contents.
    async saveSnapshot(record) {
      if (!record.document) throw new PreviewError('draft_not_ready', 'Provide content before saving a draft.');
      if ((await savedNames()).length >= 20) throw new PreviewError('storage_limit', 'This document already has 20 saved drafts. Nothing was replaced.');
      const savedId = randomUUID();
      await writeRecord(join(savedDirectory, `${savedId}.json`), validateRecord({ ...record, error: null }, id), { exclusive: true });
      return savedId;
    },
    async initialize() {
      await prepare();
      return withStoreLock(directory, async () => {
        try { return await load(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const record = { id, revision: 1, document: null, error: null };
        await writeRecord(path, record, { exclusive: true });
        return record;
      });
    },
    async locked(operation) { await prepare(); return withStoreLock(directory, operation); },
    async write(record) { await writeRecord(path, validateRecord(record, id)); }
  };
}
