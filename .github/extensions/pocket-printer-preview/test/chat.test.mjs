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
import { templateDocument, templateBlocks } from '../templates.mjs';
import { fixedDigest, renderFixedTemplate } from '../fixed-template.mjs';

const target = '11111111-2222-4333-8444-555555555555';
const document = { version: 1, blocks: [
  { kind: 'heading', text: 'WEEKEND WALK' },
  { kind: 'text', text: 'Bring the essentials. Meet near the old stone bridge at ten.' },
  { kind: 'checklist', items: [{ text: 'Water bottle', checked: false }, { text: 'Comfortable shoes', checked: true }] }
] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, { lostSubmit = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pocket-chat-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], receipts = new Map(), ledger = new PrintLedger(root);
  const secondTarget = '22222222-2222-4333-8444-555555555555';
  const helper = async (method, fields) => {
    calls.push(method);
    if (method === 'helper_status') return { health: { bluetooth: 'ready', safety_blocked: false,
      confirmation_mode: 'ai_client', supports_expected_confirmation_mode: true, supports_printer_discovery: true } };
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
      if (lostSubmit) throw new Error('Synthetic missing submit response');
      return { receipt };
    }
    if (method === 'start_discovery') return { discovery: { scan_id: fields.scan_id, state: 'stopped',
      devices: [target, secondTarget].map(id => ({ id, name: 'Mini Pocket Printer_BLE' })), message: 'Synthetic scan' } };
    if (method === 'job_status') return { receipt: receipts.get(fields.job_id) };
    throw new Error(`Unexpected helper call: ${method}`);
  };
  const options = { documents: documentStore('weekend-walk', root), printing: new Printing({ helper, ledger }) };
  const editor = new ChatDocument('weekend-walk', options);
  await editor.adopt(await options.documents.initialize());
  return { root, calls, helper, ledger, options, editor, secondTarget, receipts };
}
async function prepare(editor) {
  editor.resumePreview({});
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
  assert.deepEqual(canvas.actions.map(a => a.name), ['get_document', 'update_document', 'request_template',
    'list_saved_documents', 'open_saved_document', 'get_print_status', 'list_prints']);
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

test('picker opens without input reuse the default document while explicit IDs remain validated', async t => {
  const f = await fixture(t);
  const documents = documentStore('project-chat-v2', f.root);
  const record = { ...(await documents.initialize()), revision: 2, document };
  await documents.write(record);
  const canvas = chatCanvas(undefined, { ...f.options, documents });
  assert.deepEqual(canvas.inputSchema.required, []);
  assert.equal(canvas.inputSchema.properties.documentId.pattern, '^[a-z0-9][a-z0-9-]{0,63}$');
  for (const [index, input] of [undefined, null, {}, { documentId: 'project-chat-v2' }].entries()) {
    const ctx = { instanceId: `picker-${index}`, ...(input === undefined ? {} : { input }) };
    t.after(() => canvas.onClose(ctx));
    const opened = await canvas.open(ctx);
    assert.equal((await fetch(opened.url)).status, 200);
    const state = await canvas.actions[0].handler({ ...ctx, input: {} });
    assert.equal(state.documentId, 'project-chat-v2');
    assert.equal(state.revision, 2);
    assert.equal(state.flow.view, 'gallery');
    assert.deepEqual(state.document, document);
  }
  for (const input of [{ documentId: '' }, { documentId: null }, { documentId: '../private' },
    { documentId: 'UPPER' }, { unexpected: true }, [], 'project-chat-v2']) {
    await assert.rejects(canvas.open({ instanceId: 'invalid-picker', input }));
  }
  assert.deepEqual(await documents.load(), record);
  assert.deepEqual(f.calls, []);
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
  assert.deepEqual(restarted.state().document, { version: 1, blocks: [{ kind: 'text', text: 'Revised content' }] });
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
  await f.editor.requestReplacement({ revision: 2, template: 'daily' });
  await f.editor.resolveReplacement({ requestId: f.editor.pendingReplacement.requestId, decision: 'replace' });
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

test('Focus has exactly three blank priorities; Surprise renders a meme, Easy or Medium with retained user text', async () => {
  const focus = templateDocument('focus');
  assert.deepEqual(focus.priorities, ['', '', '']);
  assert.equal(templateBlocks(focus).blocks.length, 4);
  for (const priorities of [[], ['', ''], ['', '', '', ''], ['a\nb', '', ''], ['x'.repeat(513), '', '']]) {
    await assert.rejects(renderDocument({ ...focus, priorities }));
  }
  const surprise = { ...templateDocument('surprise'), message: 'A synthetic reminder' };
  const images = [];
  for (const seed of [0, 1, 3]) {
    const blocks = templateBlocks(surprise, seed).blocks;
    assert.ok(blocks.some(b => b.text === surprise.message));
    if (!seed) assert.ok(blocks.some(b => b.kind === 'art' && b.name === 'printer'));
    else assert.equal(blocks.find(b => b.kind === 'sudoku').difficulty, seed === 1 ? 'easy' : 'medium');
    const bytes = await renderDocument(surprise, { surpriseSeed: seed });
    assert.equal(inspectPng(bytes).width, 384);
    assert.deepEqual(bytes, await renderDocument(surprise, { surpriseSeed: seed }));
    images.push(hash(bytes));
  }
  assert.equal(new Set(images).size, 3);
  await assert.rejects(renderDocument({ ...focus, priorities: ['W'.repeat(100), '', ''] }), /unbroken word/);
});

test('gallery preserves generated provenance and protects chat edits with save, replace, cancel and recoverable snapshots', async t => {
  const f = await fixture(t), e = f.editor;
  assert.equal(e.state().flow.view, 'gallery');
  await e.requestReplacement({ revision: 1, template: 'focus' });
  assert.equal(e.state().flow.view, 'preview');
  assert.equal(e.state().flow.customized, false);
  await e.requestReplacement({ revision: 2, template: 'daily' });
  assert.equal(e.pendingReplacement, null, 'Untouched generated content does not prompt');
  await e.requestReplacement({ revision: 3, template: 'focus' });
  const customized = { version: 1, layout: 'focus', priorities: ['Call the team', 'Write the outline', 'Take a walk'] };
  await e.updateDocument({ revision: 4, document: customized });
  await assert.rejects(e.updateDocument({ revision: 5, document: templateDocument('daily') }), { code: 'replacement_required' });
  await e.requestReplacement({ revision: 5, template: 'daily' });
  assert.deepEqual(e.draft, customized);
  await e.resolveReplacement({ requestId: e.pendingReplacement.requestId, decision: 'cancel' });
  assert.equal(e.revision, 5);
  await e.requestReplacement({ revision: 5, template: 'daily' });
  await e.resolveReplacement({ requestId: e.pendingReplacement.requestId, decision: 'save' });
  const saved = await e.documents.listSaved();
  assert.equal(saved.length, 1);
  assert.deepEqual((await e.documents.loadSaved(saved[0].savedId)).document, customized);
  assert.equal(e.flow.customized, false);
  const restarted = new ChatDocument('weekend-walk', f.options);
  await restarted.sync();
  assert.equal(restarted.flow.customized, false);
  await restarted.requestReplacement({ revision: 6, savedId: saved[0].savedId }, 'saved');
  assert.deepEqual(restarted.draft, customized);
  assert.equal(restarted.flow.customized, true);
  await restarted.requestReplacement({ revision: 7, template: 'surprise' });
  await restarted.resolveReplacement({ requestId: restarted.pendingReplacement.requestId, decision: 'replace' });
  assert.equal((await e.documents.listSaved()).length, 1);
  assert.equal(restarted.state().flow.hidden, true);
  assert.deepEqual(f.calls, [], 'Selection, edits, saves and restoration do not contact a helper');
});

test('failed save and concurrent edits cannot authorize a stale customized-content replacement', async t => {
  const f = await fixture(t), e = f.editor;
  await e.updateDocument({ revision: 1, document });
  await e.requestReplacement({ revision: 2, template: 'focus' });
  const requestId = e.pendingReplacement.requestId, save = e.documents.saveSnapshot;
  e.documents.saveSnapshot = async () => { throw new Error('Synthetic disk full'); };
  await assert.rejects(e.resolveReplacement({ requestId, decision: 'save' }), /disk full/);
  assert.equal(e.revision, 2);
  assert.deepEqual((await e.documents.load()).document, document);
  e.documents.saveSnapshot = save;
  const peer = new ChatDocument('weekend-walk', f.options);
  await peer.sync();
  await peer.updateDocument({ revision: 2, document });
  await assert.rejects(e.resolveReplacement({ requestId, decision: 'replace' }), { code: 'stale_replacement' });
  assert.deepEqual(e.draft, document);
  assert.equal(e.pendingReplacement, null);
});

test('rejected chat edits retain customized content, block bypass and can save the last valid document', async t => {
  const f = await fixture(t), e = f.editor;
  const focus = { version: 1, layout: 'focus', priorities: ['Keep this priority', '', ''] };
  await e.updateDocument({ revision: 1, document: focus });
  await assert.rejects(e.updateDocument({ revision: 2, document: { ...focus, priorities: [] } }));
  assert.deepEqual(e.draft, focus);
  assert.equal(e.image, null);
  const peer = new ChatDocument('weekend-walk', f.options);
  await peer.sync();
  assert.deepEqual(peer.draft, focus);
  assert.equal(peer.image, null);
  await assert.rejects(peer.updateDocument({ revision: 3, document: templateDocument('daily') }), { code: 'replacement_required' });
  await peer.requestReplacement({ revision: 3, template: 'daily' });
  await peer.resolveReplacement({ requestId: peer.pendingReplacement.requestId, decision: 'save' });
  const snapshot = await peer.documents.loadSaved(peer.lastSavedDraft);
  assert.deepEqual(snapshot.document, focus);
  assert.equal(snapshot.error, null);
  await peer.requestReplacement({ revision: 4, savedId: peer.lastSavedDraft }, 'saved');
  assert.deepEqual(peer.draft, focus);
  assert.equal(peer.renderedRevision, 5);
  assert.deepEqual(f.calls, []);
});

test('Surprise rerolls and conceals every chat revision; back, reload and hidden endpoints never retain print approval', async t => {
  const f = await fixture(t);
  let draw = 0;
  const canvas = chatCanvas(undefined, { ...f.options, drawSeed: () => [0, 1, 3][draw++] });
  const ctx = { instanceId: 'surprise-test', input: { documentId: 'weekend-walk' } };
  t.after(() => canvas.onClose(ctx));
  const opened = await canvas.open(ctx);
  const invoke = (name, input = {}) => canvas.actions.find(a => a.name === name).handler({ ...ctx, input });
  const post = async (route, input) => fetch(opened.url + route, { method: 'POST',
    headers: { Origin: new URL(opened.url).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  let state = await invoke('request_template', { revision: 1, template: 'surprise' });
  assert.equal(state.flow.hidden, true);
  assert.equal(state.image, null);
  assert.equal((await fetch(opened.url + 'image.png?revision=2')).status, 404);
  assert.equal((await post('inspect_for_print', { revision: 2, target })).status, 400);
  state = await (await post('reveal_preview', { revision: 2 })).json();
  const firstHash = state.image.sha256;
  assert.equal((await fetch(opened.url + 'image.png?revision=2')).status, 200);
  state = await invoke('update_document', { revision: 2, document: { version: 1, layout: 'surprise', message: 'Synthetic note' } });
  assert.equal(state.flow.hidden, true);
  assert.equal((await post('reveal_preview', { revision: 2 })).status, 400);
  assert.equal((await fetch(opened.url + 'image.png?revision=3')).status, 404);
  state = await (await post('reveal_preview', { revision: 3 })).json();
  assert.notEqual(state.image.sha256, firstHash);
  await post('back_to_templates', {});
  assert.equal((await fetch(opened.url + 'image.png?revision=3')).status, 404);
  await post('resume_preview', {});
  state = await invoke('get_document');
  assert.equal(state.flow.hidden, true);
  const restarted = new ChatDocument('weekend-walk', f.options);
  await restarted.sync();
  restarted.resumePreview({});
  assert.equal(restarted.state().image, null);
  await assert.rejects(restarted.confirmPrint({}), { code: 'preview_hidden' });
  await restarted.reveal({ revision: 3 });
  const approval = await prepare(restarted);
  restarted.backToTemplates({});
  await assert.rejects(restarted.confirmPrint(approval), { code: 'preview_hidden' });
  restarted.resumePreview({});
  await restarted.reveal({ revision: 3 });
  await assert.rejects(restarted.confirmPrint(approval), /approval/);
  assert.equal(f.calls.includes('submit_png'), false);
});

for (const name of ['vortragsnotiz', 'token-verbrauch']) test(`${name} raster stays private across inspection, lost submit, same-job recovery and reopen`, async t => {
  const f = await fixture(t, { lostSubmit: true });
  const canvas = chatCanvas(undefined, { ...f.options, render() { throw new Error('No external rendering'); } });
  const ctx = { instanceId: 'fixed-test', input: { documentId: 'weekend-walk' } };
  const { url } = await canvas.open(ctx);
  t.after(() => canvas.onClose(ctx));
  const invoke = (name, input = {}) => canvas.actions.find(a => a.name === name).handler({ ...ctx, input });
  const post = (route, input = {}) => fetch(url + route, { method: 'POST',
    headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const raster = await renderDocument(templateDocument(name));
  assert.equal(hash(raster), fixedDigest(name));
  assert.equal(inspectPng(raster).width, 384);
  const cover = Buffer.from(await (await fetch(url + 'template-cover.png')).arrayBuffer());
  assert.deepEqual(cover, await readFile(new URL('../template-cover.png', import.meta.url)));
  assert.notEqual(hash(cover), fixedDigest(name));
  assert.ok(!canvas.actions.some(a => ['confirm_print', 'inspect_for_print'].includes(a.name)));
  await assert.rejects(invoke('update_document', { revision: 1, document: templateDocument(name) }),
    { code: 'fixed_template' });
  const fixed = await invoke('request_template', { revision: 1, template: name });
  const revision = fixed.revision;
  assert.equal(fixed.image, null);
  await assert.rejects(invoke('update_document', { revision, document }), { code: 'fixed_template' });
  assert.equal((await post('inspect_for_print', { revision, target })).status, 400, 'Explicit target required');
  assert.equal((await post('start_scan')).status, 200);
  const select = id => post('select_printer', { id });
  const inspect = async () => {
    const response = await post('inspect_for_print', { revision, target });
    const value = await response.text();
    assert.equal(response.status, 200, value);
    assert.ok(!value.includes(raster.toString('base64')));
    const { image, prepared: p } = JSON.parse(value);
    assert.equal(image, null);
    assert.equal(p.digest, fixedDigest(name));
    assert.equal(p.estimatedPaperMm, undefined);
    return { revision, target, jobId: p.jobId, digest: p.digest, bitmapDigest: p.bitmapDigest,
      inspectionId: p.inspectionId, approvalToken: p.approvalToken, paperApproved: true };
  };
  const concealed = async approval => {
    for (const route of ['template-raster.png', 'token-raster.png', `image.png?revision=${revision}`, `print-preview.png?inspection=${approval.inspectionId}`]) {
      assert.equal((await fetch(url + route)).status, 404, route);
    }
    const state = await (await fetch(url + 'state')).text();
    assert.ok(!state.includes(raster.toString('base64')));
    assert.equal(JSON.parse(state).image, null);
    assert.equal((await invoke('get_document')).prepared, null);
  };
  await select(target);
  const old = await inspect();
  await select(f.secondTarget);
  assert.equal((await post('confirm_print', old)).status, 400);
  await select(target);
  const approval = await inspect();
  assert.equal(approval.jobId, old.jobId);
  await concealed(approval);
  assert.equal((await post('confirm_print', { ...approval, digest: '0'.repeat(64) })).status, 400);
  assert.equal((await post('confirm_print', { ...approval, paperApproved: false })).status, 400);
  const responses = await Promise.all([post('confirm_print', approval), post('confirm_print', approval)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
  const winner = await responses.find(response => response.ok).json();
  assert.equal(winner.job.state, 'uncertain');
  assert.equal(winner.job.jobId, approval.jobId);
  await concealed(approval);
  assert.equal((await invoke('get_print_status', { jobId: approval.jobId })).job.state, 'submitted_only');
  assert.equal((await post('confirm_print', approval)).status, 400);
  const reopened = new ChatDocument('weekend-walk', f.options);
  await reopened.sync();
  const recovered = await prepare(reopened);
  assert.equal(recovered.jobId, approval.jobId);
  assert.equal(reopened.state(true).prepared.claimed, true);
  assert.equal(reopened.state(true).prepared.approvalToken, undefined);
  assert.equal(f.calls.filter(call => call === 'submit_png').length, 1);
});

test('replacing a fixed revision revokes approval and preserves recoverable Surprise snapshots', async t => {
  const f = await fixture(t), e = f.editor;
  let state = await e.requestReplacement({ revision: 1, template: 'surprise' });
  const surprise = { version: 1, layout: 'surprise', message: 'Retained synthetic note' };
  state = await e.updateDocument({ revision: state.revision, document: surprise });
  state = await e.requestReplacement({ revision: state.revision, template: 'vortragsnotiz' });
  state = await e.resolveReplacement({ requestId: state.flow.pendingReplacement.requestId, decision: 'save' });
  const approval = await prepare(e);
  const other = new ChatDocument('weekend-walk', f.options);
  await other.sync();
  const token = await other.requestReplacement({ revision: state.revision, template: 'token-verbrauch' });
  await assert.rejects(e.confirmPrint(approval), { code: 'approval_required' });
  const tokenApproval = await prepare(e);
  assert.notEqual(tokenApproval.digest, approval.digest);
  await assert.rejects(e.confirmPrint({ ...tokenApproval, digest: approval.digest }), { code: 'approval_required' });
  await other.requestReplacement({ revision: token.revision, savedId: state.flow.lastSavedDraft }, 'saved');
  await assert.rejects(e.confirmPrint(approval), { code: 'preview_hidden' });
  assert.deepEqual(e.draft, surprise);
  assert.equal(e.state().flow.hidden, true);
  await e.reveal({ revision: e.revision });
  await assert.rejects(e.confirmPrint(approval), { code: 'approval_required' });
  assert.equal(f.calls.includes('submit_png'), false);
});

test('Token-Verbrauch repeats require fresh approval, recover the newest claim and never replay a predecessor', async t => {
  const f = await fixture(t), e = f.editor;
  await e.requestReplacement({ revision: 1, template: 'token-verbrauch' });
  const initial = await prepare(e);
  const repeat = ({ revision, target, jobId, inspectionId }, paperApproved = true) => ({
    revision, target, jobId, inspectionId, paperApproved
  });
  await assert.rejects(e.repeatPrint(repeat(initial)), { code: 'copy_approval_required' });
  await e.confirmPrint(initial);
  await assert.rejects(e.repeatPrint(repeat(initial, false)), { code: 'copy_approval_required' });
  const twin = new ChatDocument('weekend-walk', f.options);
  await twin.sync();
  const twinApproval = await prepare(twin);
  f.receipts.get(initial.jobId).state = 'in_progress';
  await assert.rejects(e.repeatPrint(repeat(initial)), { code: 'unresolved_dispatch' });
  assert.equal((await f.ledger.list()).length, 1, 'No repeat intent is created for an active job');
  f.receipts.get(initial.jobId).state = 'uncertain';
  f.receipts.get(initial.jobId).outcome_acknowledged = true;
  const refreshed = await prepare(e);
  await assert.rejects(e.repeatPrint(repeat(refreshed)), { code: 'unresolved_dispatch' });
  assert.equal((await f.ledger.list()).length, 1, 'Even acknowledged uncertainty cannot create a repeat');
  f.receipts.get(initial.jobId).state = 'submitted_only';
  const ready = await prepare(e);
  const raced = await Promise.allSettled([e.repeatPrint(repeat(ready)), twin.repeatPrint(repeat(twinApproval))]);
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
  const copy = raced.find(result => result.status === 'fulfilled').value.job;
  assert.notEqual(copy.jobId, initial.jobId);
  const original = await f.ledger.find(initial.jobId);
  const successor = await f.ledger.find(copy.jobId);
  assert.equal(successor.copyOf, original.jobId);
  assert.equal(successor.original, (await renderFixedTemplate('token-verbrauch')).toString('base64'));
  assert.equal(successor.original, original.original);
  assert.equal(successor.bitmapDigest, original.bitmapDigest);
  assert.equal(f.calls.filter(call => call === 'submit_png').length, 2);

  const reopened = new ChatDocument('weekend-walk', f.options);
  await reopened.sync();
  f.receipts.delete(copy.jobId);
  const recovered = await prepare(reopened);
  assert.equal(recovered.jobId, copy.jobId, 'Reload recovers the latest claim even if its receipt is missing');
  assert.equal((await f.options.printing.status(copy.jobId)).state, 'uncertain');
  await assert.rejects(reopened.repeatPrint(repeat(recovered)), { code: 'unresolved_dispatch' });
  assert.equal((await f.ledger.list()).length, 2);
  assert.equal(f.calls.filter(call => call === 'submit_png').length, 2);
});

test('Vortragsnotiz does not acquire a repeat action', async t => {
  const f = await fixture(t), e = f.editor;
  await e.requestReplacement({ revision: 1, template: 'vortragsnotiz' });
  const first = await prepare(e);
  await e.confirmPrint(first);
  const { revision, target, jobId, inspectionId } = first;
  await assert.rejects(e.repeatPrint({ revision, target, jobId, inspectionId, paperApproved: true }),
    { code: 'copy_approval_required' });
  assert.equal((await f.ledger.list()).length, 1);
});

test('a copy rejected before admission can be followed only by a newly approved job', async t => {
  const f = await fixture(t), e = f.editor;
  const helper = f.options.printing.helper;
  let rejectNext = false;
  f.options.printing.helper = async (method, fields) => {
    if (method === 'submit_png' && rejectNext) {
      rejectNext = false;
      throw Object.assign(new Error('Synthetic native rejection'), { helperReported: true, code: 'busy' });
    }
    return helper(method, fields);
  };
  await e.requestReplacement({ revision: 1, template: 'token-verbrauch' });
  const first = await prepare(e);
  await e.confirmPrint(first);
  const approveCopy = ({ revision, target, jobId, inspectionId }) => ({
    revision, target, jobId, inspectionId, paperApproved: true
  });
  rejectNext = true;
  const rejected = (await e.repeatPrint(approveCopy(first))).job;
  assert.equal(rejected.state, 'rejected_before_admission');
  await assert.rejects(e.repeatPrint(approveCopy(first)), { code: 'copy_approval_required' });
  const recovered = await prepare(e);
  assert.equal(recovered.jobId, rejected.jobId);
  assert.equal(e.state(true).prepared.isCopy, true);
  const next = (await e.repeatPrint(approveCopy(recovered))).job;
  assert.equal(next.state, 'submitted_only');
  assert.notEqual(next.jobId, rejected.jobId);
  assert.equal((await f.ledger.find(next.jobId)).copyOf, rejected.jobId);
});
