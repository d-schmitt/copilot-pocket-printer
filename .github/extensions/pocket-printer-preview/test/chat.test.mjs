import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ChatDocument, chatCanvas } from '../chat.mjs';
import { documentTemplate, documentStore, renderDocument } from '../document.mjs';
import { PrintLedger, Printing } from '../printing.mjs';
import { inspectPng } from '../png.mjs';
import { CardEditor } from '../editor.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dailyFixture } from './daily-fixture.mjs';

const target = '11111111-2222-4333-8444-555555555555';
const document = { version: 1, blocks: [
  { kind: 'heading', text: 'WEEKEND WALK' },
  { kind: 'text', text: 'Bring the essentials. Meet near the old stone bridge at ten.' },
  { kind: 'checklist', items: [{ text: 'Water bottle', checked: false }, { text: 'Comfortable shoes', checked: true }] }
] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pocket-chat-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], receipts = new Map(), ledger = new PrintLedger(root);
  const helper = async (method, fields) => {
    calls.push(method);
    if (method === 'helper_status') return { health: { bluetooth: 'ready', safety_blocked: false,
      confirmation_mode: 'ai_client', supports_expected_confirmation_mode: true } };
    if (method === 'inspect_png') {
      const bytes = Buffer.from(fields.png_base64, 'base64');
      return { image: { sha256: hash(bytes), width: 384, height: inspectPng(bytes).height,
        png_bytes: bytes.length, clearance_dots: 80 }, preview_png_base64: fields.png_base64 };
    }
    if (method === 'submit_png') {
      const bytes = Buffer.from(fields.png_base64, 'base64');
      const receipt = { job_id: fields.job_id, device_id: fields.device_id, image_sha256: hash(bytes),
        height: inspectPng(bytes).height, confirmation_mode: 'ai_client', state: 'submitted_only', paper_confirmed: false };
      receipts.set(fields.job_id, receipt);
      return { receipt };
    }
    if (method === 'job_status') return { receipt: receipts.get(fields.job_id) };
    throw new Error(`Unexpected helper call: ${method}`);
  };
  const options = { documents: documentStore('weekend-walk', root), printing: new Printing({ helper, ledger }) };
  const editor = new ChatDocument('weekend-walk', options);
  await editor.adopt(await options.documents.initialize());
  return { root, calls, helper, ledger, options, editor };
}
async function prepare(editor) {
  editor.discovery = { state: 'stopped', devices: [{ id: target, name: 'Mini Pocket Printer_BLE' }], message: 'Synthetic scan' };
  editor.selectPrinter({ id: target });
  await editor.inspectSelected({ revision: editor.revision, target });
  const p = editor.state(true).prepared;
  return { revision: p.revision, jobId: p.jobId, target, digest: p.digest, bitmapDigest: p.bitmapDigest,
    inspectionId: p.inspectionId, approvalToken: p.approvalToken, paperApproved: true };
}

test('bounded document uses generic text and checklist markers, rejects unsupported content without omission', async () => {
  const template = documentTemplate(document);
  assert.deepEqual(template.blocks.map(b => b.text), ['WEEKEND WALK',
    'Bring the essentials. Meet near the old stone bridge at ten.', '[ ] Water bottle', '[x] Comfortable shoes']);
  const bytes = await renderDocument(document);
  const image = inspectPng(bytes);
  assert.equal(image.width, 384);
  assert.ok(image.height > 100 && image.height <= 4096);
  assert.equal(image.estimatedPaperMm, (image.height + 80) / 203 * 25.4);
  for (const value of [
    { version: 1, blocks: [{ kind: 'image', url: 'https://example.invalid' }] },
    { version: 1, blocks: [{ kind: 'text', text: 'A'.repeat(4097) }] },
    { version: 1, blocks: [{ kind: 'checklist', items: [{ text: 'item', checked: 'false' }] }] },
    { version: 1, blocks: Array.from({ length: 65 }, () => ({ kind: 'text', text: 'item' })) }
  ]) assert.throws(() => documentTemplate(value));
  await assert.rejects(renderDocument({ version: 1, blocks: [{ kind: 'text', text: 'W'.repeat(100) }] }), /unbroken word/);
  await assert.rejects(renderDocument({ version: 1, blocks: [{ kind: 'text', text: 'line\n'.repeat(200) }] }), /4096 dots/);
  assert.throws(() => documentTemplate({ version: 1, blocks: Array.from({ length: 64 },
    () => ({ kind: 'text', text: 'a '.repeat(1024) })) }), /60 KiB/);
  const ascii = await renderDocument({ version: 1, blocks: [{ kind: 'text', text: 'Gruesse ? cafe' }] });
  const unicode = await renderDocument({ version: 1, blocks: [{ kind: 'text', text: 'Grüsse — café' }] });
  assert.deepEqual(unicode, ascii, 'Established transliteration remains unchanged');
});

test('canvas actions render initial content and revision, reopen durable content, expose no approval or print action', async t => {
  const f = await fixture(t);
  const canvas = chatCanvas(undefined, f.options);
  const ctx = { instanceId: 'walk-panel', input: { documentId: 'weekend-walk' } };
  t.after(() => canvas.onClose(ctx));
  assert.deepEqual(canvas.actions.map(a => a.name), ['get_document', 'update_document', 'get_print_status', 'list_prints']);
  const invoke = (name, input = {}) => canvas.actions.find(a => a.name === name).handler({ ...ctx, input });
  const opened = await canvas.open(ctx);
  assert.equal((await invoke('get_document')).document, null);
  let state = await invoke('update_document', { revision: 1, document });
  assert.equal(state.renderedRevision, 2);
  assert.equal(state.prepared, null);
  assert.equal((await fetch(opened.url + 'image.png?revision=2')).status, 200);
  const revised = structuredClone(document);
  revised.blocks[2].items.push({ text: 'Rain jacket', checked: false });
  state = await invoke('update_document', { revision: 2, document: revised });
  assert.equal(state.document.blocks[2].items.length, 3);
  assert.equal(state.renderedRevision, 3);
  assert.equal((await fetch(opened.url + 'image.png?revision=2')).status, 404);
  assert.equal((await fetch(opened.url + 'image.png?revision=3')).status, 200);
  await assert.rejects(invoke('update_document', { revision: 2, document }), /changed in another panel/);
  assert.equal((await fetch(opened.url, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  const html = await (await fetch(opened.url)).text();
  assert.doesNotMatch(html, /textarea|type="text"|print-image|sections/);
  assert.equal((await fetch(opened.url + 'confirm_print', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.deepEqual(f.calls, [], 'Open, content revisions and reads never contact the helper');
  await canvas.onClose(ctx);
  const reopened = chatCanvas(undefined, f.options);
  t.after(() => reopened.onClose(ctx));
  await reopened.open(ctx);
  const restored = await reopened.actions[0].handler({ ...ctx, input: {} });
  assert.equal(restored.revision, 3);
  assert.deepEqual(restored.document, revised);
  assert.equal(restored.selectedPrinter, null);
  assert.equal(restored.prepared, null);
});

test('another provider edit or rejected content invalidates approval durably before any submission', async t => {
  const f = await fixture(t);
  await f.editor.updateDocument({ revision: 1, document });
  const approval = await prepare(f.editor);
  assert.equal(f.editor.state().prepared.approvalToken, undefined);
  const peer = new ChatDocument('weekend-walk', f.options);
  await peer.sync();
  await peer.updateDocument({ revision: 2, document: { version: 1, blocks: [{ kind: 'text', text: 'Revised content' }] } });
  await assert.rejects(f.editor.confirmPrint(approval), /approval/);
  assert.equal(f.calls.includes('submit_png'), false);
  const fresh = await prepare(f.editor);
  await assert.rejects(peer.updateDocument({ revision: 3, document: { version: 1, blocks: [{ kind: 'image' }] } }), /Only headings/);
  await assert.rejects(f.editor.confirmPrint(fresh), /approval/);
  assert.equal(f.editor.image, null);
  const restarted = new ChatDocument('weekend-walk', f.options);
  await restarted.sync();
  assert.equal(restarted.state().document, null);
  assert.equal(restarted.state().error.code, 'invalid_document');
  assert.equal(f.calls.includes('submit_png'), false);
});

test('late rendering cannot replace a newer revision or make an over-height document printable', async t => {
  const f = await fixture(t);
  const image = await renderDocument(document);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const editor = new ChatDocument('weekend-walk', { ...f.options, render: async value => {
    if (value.blocks[0].text === 'OLD') { started(); await new Promise(resolve => { release = resolve; }); }
    return image;
  } });
  await editor.sync();
  const old = editor.updateDocument({ revision: 1, document: { version: 1, blocks: [{ kind: 'text', text: 'OLD' }] } });
  await ready;
  const latest = editor.updateDocument({ revision: 2, document });
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await Promise.all([old, latest]);
  assert.equal(editor.renderedRevision, 3);
  assert.deepEqual(editor.draft, document);
  await f.editor.sync();
  const approval = await prepare(f.editor);
  await assert.rejects(f.editor.updateDocument({ revision: 3,
    document: { version: 1, blocks: [{ kind: 'text', text: 'line\n'.repeat(200) }] } }), /4096 dots/);
  assert.equal(f.editor.image, null);
  await assert.rejects(f.editor.confirmPrint(approval), /approval/);
});

test('V1 and V2 share the same durable identity and cannot bypass a prior dispatch claim', async t => {
  const f = await fixture(t);
  await f.editor.updateDocument({ revision: 1, document });
  const approval = await prepare(f.editor);
  const v1 = new CardEditor({ render: async () => f.editor.image, printing: new Printing({ helper: f.helper, ledger: new PrintLedger(f.root) }) });
  await v1.refresh();
  await v1.inspectForPrint({ revision: 1, target });
  assert.equal(v1.prepared.intent.jobId, approval.jobId);
  await f.editor.confirmPrint(approval);
  assert.equal(f.calls.filter(c => c === 'submit_png').length, 1);
  await assert.rejects(f.editor.confirmPrint(approval), /approval/);
  await v1.printing.dispatch(v1.prepared.intent, () => {});
  assert.equal(f.calls.filter(c => c === 'submit_png').length, 1);
  const restarted = new ChatDocument('weekend-walk', f.options);
  await restarted.sync();
  await prepare(restarted);
  assert.equal(restarted.prepared.claimed, true);
});

test('content writes are excluded during claim admission, and target changes invalidate inspection', async t => {
  const f = await fixture(t);
  await f.editor.updateDocument({ revision: 1, document });
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const printing = f.editor.printing;
  const dispatch = printing.dispatch.bind(printing);
  printing.dispatch = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return dispatch(...args); };
  const approval = await prepare(f.editor);
  const pending = f.editor.confirmPrint(approval);
  await ready;
  const peer = new ChatDocument('weekend-walk', f.options);
  await peer.sync();
  await assert.rejects(peer.updateDocument({ revision: 2, document }), /Storage is busy/);
  release(); await pending;
  f.editor.selectPrinter({ id: '' });
  await assert.rejects(f.editor.inspectSelected({ revision: 2, target }), /Select a discovered printer/);
  assert.equal(f.editor.prepared, null);
});

test('separate provider process edits invalidate approvals and cannot write across claim admission', async t => {
  const f = await fixture(t);
  await f.editor.updateDocument({ revision: 1, document });
  const approval = await prepare(f.editor);
  const child = async (revision, value) => {
    const script = `
      import { ChatDocument } from ${JSON.stringify(new URL('../chat.mjs', import.meta.url).href)};
      import { documentStore } from ${JSON.stringify(new URL('../document.mjs', import.meta.url).href)};
      const editor = new ChatDocument('weekend-walk', { documents: documentStore('weekend-walk', process.argv[1]) });
      await editor.sync();
      try {
        await editor.updateDocument({ revision: Number(process.argv[2]), document: JSON.parse(process.argv[3]) });
        process.stdout.write('updated');
      } catch (error) { process.stdout.write(error.code); }
    `;
    return (await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.root,
      String(revision), JSON.stringify(value)], { timeout: 10_000 })).stdout;
  };
  assert.equal(await child(2, { version: 1, blocks: [{ kind: 'text', text: 'Changed by another provider' }] }), 'updated');
  await assert.rejects(f.editor.confirmPrint(approval), /approval/);
  const next = await prepare(f.editor);
  assert.equal(await child(3, { version: 1, blocks: [{ kind: 'image' }] }), 'invalid_document');
  await assert.rejects(f.editor.confirmPrint(next), /approval/);
  await f.editor.updateDocument({ revision: 4, document });
  const ready = await prepare(f.editor);
  const dispatch = f.editor.printing.dispatch.bind(f.editor.printing);
  f.editor.printing.dispatch = async (...args) => {
    assert.equal(await child(5, document), 'storage_locked');
    return dispatch(...args);
  };
  await f.editor.confirmPrint(ready);
  assert.equal(f.calls.filter(c => c === 'submit_png').length, 1);
});

test('original daily layout uses the same revision and approval boundary and does not change other documents', async t => {
  const f = await fixture(t);
  const otherStore = documentStore('another-document', f.root);
  const other = new ChatDocument('another-document', { documents: otherStore });
  await other.adopt(await otherStore.initialize());
  await other.updateDocument({ revision: 1, document });
  const before = await otherStore.load();
  await f.editor.updateDocument({ revision: 1, document });
  const previous = await prepare(f.editor);
  await f.editor.updateDocument({ revision: 2, document: dailyFixture() });
  assert.equal(f.editor.state().document.layout, 'daily-card');
  assert.equal(f.editor.renderedRevision, 3);
  assert.equal(f.editor.selectedPrinter.id, target);
  await assert.rejects(f.editor.confirmPrint(previous), /approval/);
  const approval = await prepare(f.editor);
  const invalid = dailyFixture(); invalid.date = '2026-02-30';
  await assert.rejects(f.editor.updateDocument({ revision: 3, document: invalid }), /Invalid date/);
  assert.equal(f.editor.image, null);
  await assert.rejects(f.editor.confirmPrint(approval), /approval/);
  await assert.rejects(f.editor.updateDocument({ revision: 3, document: dailyFixture() }), /changed in another panel/);
  await f.editor.updateDocument({ revision: 4, document: dailyFixture('sudoku-easy') });
  const reopened = new ChatDocument('weekend-walk', f.options);
  await reopened.sync();
  assert.equal(reopened.renderedRevision, 5);
  assert.deepEqual(reopened.image, f.editor.image);
  assert.deepEqual(await otherStore.load(), before);
  assert.equal(f.calls.includes('submit_png'), false);
});

test('V2 entrypoint registers the dedicated canvas only', async () => {
  const sdk = 'data:text/javascript,' + encodeURIComponent(`
    export let options;
    export const joinSession = async value => { options = value; };
    export const createCanvas = value => value;
    export class CanvasError extends Error {}
  `);
  const entry = new URL('../chat-extension.mjs', import.meta.url);
  const source = (await readFile(entry, 'utf8')).replace(/from (['"])([^'"]+)\1/g,
    (_, quote, dependency) => `from ${quote}${dependency === '@github/copilot-sdk/extension' ? sdk : new URL(dependency, entry).href}${quote}`);
  await import('data:text/javascript,' + encodeURIComponent(source));
  assert.deepEqual((await import(sdk)).options.canvases.map(c => c.id), ['pocket-printer-chat']);
});
