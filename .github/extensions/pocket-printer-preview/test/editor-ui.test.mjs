import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { exampleDraft } from '../draft.mjs';

async function browser(initial, request) {
  const nodes = new Map(), intervals = [], cleared = [], listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  class Element {
    constructor() { this.children = []; this.events = new Map(); this.dataset = {}; this.classList = { add() {}, remove() {} }; }
    set id(value) { this._id = value; nodes.set(`#${value}`, this); }
    get id() { return this._id; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, callback) { this.events.set(name, callback); }
    setAttribute() {}
  }
  const $ = name => {
    if (!nodes.has(name)) nodes.set(name, new Element());
    return nodes.get(name);
  };
  let state = initial;
  const source = await readFile(new URL('../editor.js', import.meta.url), 'utf8');
  await runInNewContext(`(async () => { ${source}\n })()`, {
    document: { querySelector: $, createElement: () => new Element(), querySelectorAll: () => [] },
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    fetch: async (route, options) => {
      if (request && options) state = await request(route, JSON.parse(options.body), state);
      return { ok: true, json: async () => route === 'list_drafts' ? [] : structuredClone(state) };
    },
    structuredClone, setInterval: callback => { intervals.push(callback); return intervals.length; },
    clearInterval: id => cleared.push(id),
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id)
  });
  return { $, intervals, cleared, listeners, state: value => { state = value; }, async tick() {
    // Let pending mutation responses schedule their preview, then advance one debounce at a time.
    await new Promise(resolve => setImmediate(resolve));
    const timer = timers.entries().next().value;
    if (timer) { timers.delete(timer[0]); await timer[1](); }
  } };
}

test('browser starts one poll on load and refreshes recovered state without opening saved drafts', async () => {
  let state = { draft: exampleDraft(), revision: 1, renderedRevision: null, saved: null, image: null,
    printingAvailable: false, error: { message: 'Temporary renderer failure' } };
  const ui = await browser(state);
  const { $, intervals, cleared, listeners } = ui;
  assert.equal(intervals.length, 1, 'Polling starts without any toolbar click');
  assert.equal($('#error').textContent, 'Temporary renderer failure');
  state = { ...state, revision: 2, draft: { ...state.draft, title: 'SYNTHETIC RECOVERY' }, error: null };
  ui.state(state);
  await intervals[0]();
  assert.equal($('#field-title').value, 'SYNTHETIC RECOVERY');
  assert.equal($('#card').hidden, true);
  state = { ...state, renderedRevision: 2, image: { width: 384, height: 100, estimatedPaperMm: 22.5 } };
  ui.state(state);
  await intervals[0]();
  assert.equal($('#error').hidden, true);
  assert.equal($('#card').hidden, false);
  await $('#browse').events.get('click')();
  await $('#browse').events.get('click')();
  assert.equal(intervals.length, 1, 'Browsing does not leak polling timers');
  listeners.get('pagehide')();
  assert.deepEqual(cleared, [1]);
  listeners.get('pageshow')();
  listeners.get('pageshow')();
  assert.equal(intervals.length, 2, 'Returning to the page restarts one timer only');
});

test('selecting a target and editing only prepare previews; one trusted Print click dispatches once', async () => {
  const calls = [];
  let inspection = 0;
  const initial = { draft: exampleDraft(), revision: 1, renderedRevision: 1, saved: null,
    image: { width: 384, height: 100, estimatedPaperMm: 22.5 }, printingAvailable: true, error: null };
  const ui = await browser(initial, async (route, input, state) => {
    calls.push({ route, input });
    if (route === 'invalidate_print') return { ...state, prepared: null };
    if (route === 'update_draft') return { ...state, draft: input.draft, revision: state.revision + 1,
      renderedRevision: state.revision + 1, prepared: null };
    if (route === 'inspect_for_print') return { ...state, prepared: {
      jobId: '11111111-2222-4333-8444-555555555555', target: input.target, digest: 'original',
      bitmapDigest: 'bitmap', revision: input.revision, mode: 'ai_client',
      inspectionId: `inspection-${++inspection}`, approvalToken: 'token', claimed: false,
      health: { bluetooth: 'ready', safety_blocked: false }, estimatedPaperMm: 22.5
    } };
    if (route === 'confirm_print') return { ...state, prepared: { ...state.prepared, claimed: true } };
    throw new Error(`Unexpected browser request: ${route}`);
  });
  const { $ } = ui;
  assert.equal(calls.length, 0, 'Opening does not contact the helper');
  $('#target').value = '11111111-2222-4333-8444-555555555555';
  $('#target').events.get('input')();
  await ui.tick();
  assert.equal(calls.filter(call => call.route === 'inspect_for_print').length, 1);
  assert.equal($('#confirm').disabled, true, 'Wait for exact bitmap decode');
  $('#print-image').children[0].events.get('load')();
  assert.equal($('#confirm').disabled, false, 'No checkbox or second confirmation is required');
  await $('#confirm').events.get('click')({ isTrusted: false });
  assert.equal(calls.filter(call => call.route === 'confirm_print').length, 0);
  $('#field-title').value = 'ANOTHER SYNTHETIC CARD';
  $('#field-title').events.get('input')();
  assert.equal($('#confirm').disabled, true, 'Local unsent edits immediately invalidate the button');
  await ui.tick();
  await ui.tick();
  assert.equal(calls.filter(call => call.route === 'inspect_for_print').length, 2);
  assert.equal(calls.filter(call => call.route === 'confirm_print').length, 0, 'Edits never print');
  $('#print-image').children[0].events.get('load')();
  assert.equal($('#confirm').disabled, false);
  await $('#confirm').events.get('click')({ isTrusted: true });
  await $('#confirm').events.get('click')({ isTrusted: true });
  const submissions = calls.filter(call => call.route === 'confirm_print');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].input.paperApproved, true);
  assert.equal(submissions[0].input.revision, 2);
  assert.equal(submissions[0].input.inspectionId, 'inspection-2');
});
