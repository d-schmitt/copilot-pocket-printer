import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDraft, templateFor, validateDraft, renderDraft } from '../draft.mjs';
import { draftStore } from '../private-store.mjs';
import { CardEditor, editorCanvas } from '../editor.mjs';
import { inspectPng } from '../png.mjs';

async function root(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pocket-editor-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('editable fields, toggles, swappable bottom and order reach the existing renderer', async () => {
  const draft = exampleDraft();
  draft.name = 'Synthetic Visitor'; draft.title = 'MY CARD';
  draft.joke = 'A synthetic joke written for this test.';
  draft.order.reverse();
  draft.enabled.meetings = false;
  const template = templateFor(draft);
  assert.equal(template.blocks[0].text, 'JOKE');
  assert.equal(template.blocks[1].text, draft.joke);
  assert.equal(template.blocks.at(-1).text, draft.name);
  assert.ok(!JSON.stringify(template).includes(draft.meetings));
  assert.equal(inspectPng(await renderDraft(draft)).width, 384);
  for (const bottom of ['sudoku', 'art']) {
    draft.bottom = bottom;
    for (const difficulty of ['easy', 'medium']) {
      draft.difficulty = difficulty;
      assert.equal(inspectPng(await renderDraft(draft)).width, 384);
    }
  }
  draft.bottom = 'joke';
  assert.equal(templateFor(draft).blocks[1].text, draft.joke, 'Switching did not erase custom joke');
});

test('invalid fields, duplicate sections and renderer overflow cannot become valid previews', async () => {
  const draft = exampleDraft();
  assert.throws(() => validateDraft({ ...draft, secret: 'private-provider-object' }), /fields/);
  assert.throws(() => validateDraft({ ...draft, name: '' }), /name/);
  assert.throws(() => validateDraft({ ...draft, order: ['bottom', 'bottom'] }), /order/);
  assert.throws(() => validateDraft({ ...draft, enabled: Object.fromEntries(draft.order.map(id => [id, false])) }), /at least/);
  await assert.rejects(renderDraft({ ...draft, joke: 'x'.repeat(2048) }), /Rendering failed/);
  const editor = new CardEditor();
  await editor.refresh();
  assert.ok(editor.image);
  await editor.update({ revision: editor.revision, draft: { ...draft, joke: 'x'.repeat(2048) } });
  assert.equal(editor.image, null);
  assert.equal(editor.renderedRevision, null);
  assert.equal(editor.error.code, 'render_failed');
});

test('a stale asynchronous render never replaces the latest draft or a closed panel', async () => {
  const png = await renderDraft(exampleDraft());
  const waiting = [];
  const editor = new CardEditor({ render: () => new Promise(resolve => waiting.push(resolve)) });
  const first = editor.refresh();
  const next = { ...exampleDraft(), title: 'LATEST' };
  const update = editor.update({ revision: 1, draft: next });
  waiting.shift()(png);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.image, null);
  assert.equal(waiting.length, 1, 'Only one renderer runs per panel');
  waiting.shift()(png);
  await Promise.all([first, update]);
  assert.equal(editor.draft.title, 'LATEST');
  assert.equal(editor.renderedRevision, 2);
  const closing = editor.update({ revision: 2, draft: exampleDraft() });
  editor.close();
  waiting.shift()(png);
  await closing;
  assert.equal(editor.image, null);
});

test('private Save/Open is bounded, explicit, versioned and does not restore on startup', async t => {
  const directory = await root(t);
  const store = draftStore(directory);
  const record = await store.save({ id: null, revision: null, draft: { ...exampleDraft(), name: 'SYNTHETIC SAVED' } });
  assert.equal((await stat(join(directory, 'drafts', `${record.id}.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'drafts'))).mode & 0o777, 0o700);
  assert.equal((await store.list()).length, 1);
  const otherProcess = draftStore(directory);
  assert.equal((await otherProcess.load(record.id)).draft.name, 'SYNTHETIC SAVED');
  const editor = new CardEditor({ store: otherProcess });
  assert.equal(editor.draft.name, 'Sample Reader');
  await editor.load({ revision: editor.revision, id: record.id });
  assert.equal(editor.draft.name, 'SYNTHETIC SAVED');
  await store.save({ id: record.id, revision: 1, draft: exampleDraft() });
  await assert.rejects(otherProcess.save({ id: record.id, revision: 1, draft: exampleDraft() }), /another panel/);
  for (let i = 1; i < 20; i++) await store.save({ id: null, revision: null, draft: exampleDraft() });
  await assert.rejects(store.save({ id: null, revision: null, draft: exampleDraft() }), /20-draft/);
  assert.equal((await readdir(join(directory, 'drafts'))).length, 20);
  await assert.rejects(store.load('../../outside'), /UUID/);
  const unsafe = join(directory, 'unsafe');
  await symlink(join(directory, 'drafts'), unsafe);
  await assert.rejects(draftStore(unsafe).list(), /0700/);
});

test('editor HTTP mutations require capability, origin, bounded JSON and exact schemas', async t => {
  const canvas = editorCanvas(undefined, { store: draftStore(await root(t)) });
  const ctx = { instanceId: 'editor-test' };
  const { url } = await canvas.open(ctx);
  t.after(() => canvas.onClose(ctx));
  const origin = new URL(url).origin;
  const initial = await (await fetch(url + 'state')).json();
  assert.equal(initial.renderedRevision, 1);
  const post = (route, input, headers = { Origin: origin, 'Content-Type': 'application/json' }) =>
    fetch(url + route, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await post('update_draft', { revision: 1, draft: exampleDraft() }, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post('print', {})).status, 405);
  assert.equal((await post('update_draft', { revision: 1, draft: exampleDraft(), extra: true })).status, 400);
  const changed = await post('update_draft', { revision: 1, draft: { ...exampleDraft(), bottom: 'sudoku' } });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).renderedRevision, 2);
  assert.equal((await fetch(url + 'image.png?revision=1')).status, 404);
  assert.equal((await fetch(url + 'image.png?revision=2')).status, 200);
  assert.equal((await post('update_draft', { revision: 1, draft: exampleDraft() })).status, 400);
});
