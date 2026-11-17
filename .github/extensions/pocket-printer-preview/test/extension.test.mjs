import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

test('entrypoint registers only the working editor and retains its draft and printing capabilities', async t => {
  // Capture SDK registration without joining or reloading a real Copilot session.
  const sdkUrl = 'data:text/javascript,' + encodeURIComponent(`
    export let registration;
    export const joinSession = async options => { registration = options; };
    export const createCanvas = options => options;
    export class CanvasError extends Error {
      constructor(code, message) { super(message); this.code = code; }
    }
  `);
  const entryUrl = process.env.POCKET_TEST_PACKAGED_EXTENSION
    ? new URL(process.env.POCKET_TEST_PACKAGED_EXTENSION)
    : new URL('../extension.mjs', import.meta.url);
  const source = (await readFile(entryUrl, 'utf8')).replace(/from (['"])([^'"]+)\1/g,
    (_, quote, dependency) => `from ${quote}${dependency === '@github/copilot-sdk/extension'
      ? sdkUrl : new URL(dependency, entryUrl).href}${quote}`);
  await import('data:text/javascript,' + encodeURIComponent(source));
  const { registration } = await import(sdkUrl);
  assert.deepEqual(registration.canvases.map(canvas => canvas.id), ['pocket-printer-editor']);
  const [canvas] = registration.canvases;
  assert.equal(canvas.displayName, 'Pocket Card Editor');
  assert.deepEqual(canvas.actions.map(action => action.name).sort(), [
    'get_draft', 'update_draft', 'list_drafts', 'save_draft', 'open_draft',
    'inspect_for_print', 'invalidate_print', 'get_print_status', 'list_prints'
  ].sort());
  const context = { instanceId: 'entrypoint-check', input: {} };
  t.after(() => canvas.onClose(context));
  const opened = await canvas.open(context);
  const getDraft = canvas.actions.find(action => action.name === 'get_draft').handler;
  const state = await getDraft(context);
  assert.equal(state.error, null);
  assert.equal(state.image.width, 384);
  assert.equal(state.printingAvailable, true);
  const updated = await canvas.actions.find(action => action.name === 'update_draft').handler({
    ...context, input: { revision: state.revision, draft: { ...state.draft, title: 'SYNTHETIC CHECK' } }
  });
  assert.equal(updated.error, null);
  assert.equal(updated.draft.title, 'SYNTHETIC CHECK');
  assert.equal(updated.renderedRevision, updated.revision);
  for (const asset of ['', 'editor.js', 'editor.css', 'view.css', `image.png?revision=${updated.revision}`]) {
    assert.equal((await fetch(opened.url + asset)).status, 200, `Missing editor asset: ${asset}`);
  }
  for (const removed of ['view.html', 'view.js', 'sample.png']) {
    assert.equal((await fetch(opened.url + removed)).status, 404);
  }
  assert.equal((await fetch(opened.url, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  await canvas.onClose(context);
  await assert.rejects(getDraft(context), /Open a card editor/);
});

test('editor dependencies isolate helper IPC to printing and process launch to the fixed renderer', async () => {
  const dependencies = {
    'extension.mjs': ['@github/copilot-sdk/extension', './editor.mjs', './printing.mjs'],
    'editor.mjs': ['node:crypto', './png.mjs', './draft.mjs', './private-store.mjs', './loopback.mjs'],
    'draft.mjs': ['node:child_process', 'node:fs/promises', 'node:os', 'node:path', 'node:url', './png.mjs'],
    'private-store.mjs': ['node:fs', 'node:fs/promises', 'node:os', 'node:path', 'node:crypto', './png.mjs', './draft.mjs'],
    'printing.mjs': ['node:crypto', 'node:fs/promises', 'node:path', '../../../bridge/ipc.mjs', './png.mjs', './private-store.mjs', './draft.mjs']
  };
  for (const [file, allowed] of Object.entries(dependencies)) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, dependency] of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
      assert.ok(allowed.includes(dependency), `Unexpected dependency in ${file}: ${dependency}`);
    }
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(|\bfetch\s*\(/);
  }
});
