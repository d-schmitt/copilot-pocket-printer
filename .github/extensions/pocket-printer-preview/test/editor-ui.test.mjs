import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { exampleDraft } from '../draft.mjs';

async function browser(initial, request, read = state => state) {
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
      if (request && options?.method === 'POST') state = await request(route, JSON.parse(options.body), state);
      return { ok: true, json: async () => route === 'list_drafts' ? [] :
        structuredClone(route === 'state' ? await read(state) : state) };
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

test('failed scan operations resync server state so the picker can recover without reopening', async () => {
  for (const failedRoute of ['start_scan', 'scan_status', 'stop_scan']) {
    const initial = { draft: exampleDraft(), revision: 1, renderedRevision: null, saved: null,
      image: null, printingAvailable: true, error: null,
      discovery: { state: 'idle', devices: [], message: 'Choose Scan' } };
    const calls = [];
    const ui = await browser(initial, async (route, input, state) => {
      calls.push(route);
      if (route === failedRoute) {
        ui.state({ ...state, error: { message: 'Scan unavailable' },
          discovery: { scanId: 'owned-scan', state: 'error', devices: [], message: 'Try again explicitly' } });
        throw new Error('Scan unavailable');
      }
      assert.equal(route, 'start_scan');
      return { ...state, discovery: { scanId: 'owned-scan', state: 'scanning', devices: [], message: 'Scanning' } };
    });
    await ui.$('#scan').events.get('click')();
    if (failedRoute === 'scan_status') await ui.intervals[0]();
    if (failedRoute === 'stop_scan') await ui.$('#stop-scan').events.get('click')();
    assert.equal(ui.$('#scan').disabled, false, `${failedRoute} must not leave the browser stuck scanning`);
    assert.equal(ui.$('#stop-scan').disabled, false, 'An uncertain accepted scan can still be stopped');
    assert.match(ui.$('#error').textContent, /Scan unavailable/);
    assert.equal(calls.filter(route => route === 'start_scan').length, 1, 'Recovery never starts or retries a scan');
  }
});

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
  assert.equal($('#card').hidden, true, 'An unloaded image is not a current visible preview');
  $('#card').events.get('load')();
  assert.equal($('#card').hidden, false);
  assert.equal($('#render-status').textContent, 'Preview matches this draft', 'Opt-out panels do not suggest unavailable printer controls');
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
  const device = { id: '11111111-2222-4333-8444-555555555555', name: 'Mini Pocket Printer_BLE', rssi: -60 };
  const initial = { draft: exampleDraft(), revision: 1, renderedRevision: 1, saved: null,
    image: { width: 384, height: 100, estimatedPaperMm: 22.5 }, printingAvailable: true, error: null };
  const ui = await browser(initial, async (route, input, state) => {
    calls.push({ route, input });
    if (route === 'start_scan') return { ...state, prepared: null, selectedPrinter: null,
      discovery: { state: 'scanning', scanId: 'scan', devices: [device], message: 'Scanning' } };
    if (route === 'scan_status') return { ...state, discovery: { ...state.discovery, state: 'stopped', message: 'Scan complete' } };
    if (route === 'select_printer') return { ...state, prepared: null, selectedPrinter: device };
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
  $('#target').value = '';
  await $('#inspect').events.get('click')();
  assert.match($('#error').textContent, /Select a printer/);
  assert.equal(calls.length, 0, 'Refresh with no selected printer stays local and actionable');
  await $('#scan').events.get('click')();
  assert.equal($('#target').value, '', 'Discovery must not select the first device');
  assert.equal(calls.filter(call => call.route === 'inspect_for_print').length, 0);
  $('#target').value = device.id;
  await $('#target').events.get('change')();
  await ui.tick();
  assert.equal(calls.filter(call => call.route === 'inspect_for_print').length, 0, 'Wait for scan cleanup before preparing printing');
  await ui.intervals[0]();
  await ui.tick();
  assert.equal(calls.filter(call => call.route === 'inspect_for_print').length, 1);
  assert.equal($('#confirm').disabled, true, 'Wait for exact bitmap decode');
  assert.equal($('#card-preview').children.length, 1);
  assert.equal($('#card').src, 'print-preview.png?inspection=inspection-1');
  $('#card').events.get('load')();
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
  $('#card').events.get('load')();
  assert.equal($('#confirm').disabled, false);
  await $('#confirm').events.get('click')({ isTrusted: true });
  await $('#confirm').events.get('click')({ isTrusted: true });
  const submissions = calls.filter(call => call.route === 'confirm_print');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].input.paperApproved, true);
  assert.equal(submissions[0].input.revision, 2);
  assert.equal(submissions[0].input.inspectionId, 'inspection-2');
});

test('editor has one preview region, with a separate always-present Print control', async () => {
  const html = await readFile(new URL('../editor.html', import.meta.url), 'utf8');
  assert.equal((html.match(/class="paper-window"/g) ?? []).length, 1);
  assert.equal((html.match(/<img\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /id="print-image"/);
  assert.match(html, /<\/div>\s*<button id="confirm" disabled>Print<\/button>/);
});

const firstDevice = { id: '11111111-2222-4333-8444-555555555555', name: 'SYNTHETIC PRINTER', rssi: -60 };
const secondDevice = { ...firstDevice, id: '22222222-2222-4333-8444-555555555555' };
function readyState() {
  return {
    draft: exampleDraft(), revision: 1, renderedRevision: 1, saved: null,
    image: { width: 384, height: 100, estimatedPaperMm: 22.5 }, printingAvailable: true, error: null,
    selectedPrinter: firstDevice, discovery: { state: 'stopped', devices: [firstDevice, secondDevice] },
    prepared: {
      jobId: firstDevice.id, target: firstDevice.id, digest: 'original', bitmapDigest: 'bitmap',
      revision: 1, mode: 'ai_client', inspectionId: 'inspection-1', approvalToken: 'token',
      health: { bluetooth: 'ready', safety_blocked: false }, estimatedPaperMm: 22.5
    }
  };
}

test('only the current loaded top bitmap can approve printing; late image events are ignored', async () => {
  const initial = readyState();
  const ui = await browser(initial, async (route, input, state) => {
    assert.equal(route, 'select_printer');
    return { ...state, selectedPrinter: secondDevice, prepared: null };
  });
  const { $ } = ui;
  const oldBitmap = $('#card');
  oldBitmap.events.get('load')();
  assert.equal($('#confirm').disabled, false);
  $('#target').value = secondDevice.id;
  const changing = $('#target').events.get('change')();
  assert.equal(oldBitmap.hidden, true);
  oldBitmap.events.get('load')();
  assert.equal($('#confirm').disabled, true, 'An in-flight target change cannot restore approval');
  await changing;
  assert.equal($('#card').src, 'image.png?revision=1');
  $('#card').events.get('load')();
  assert.equal($('#confirm').disabled, true, 'Renderer-only pixels never approve printing');
  assert.match($('#render-status').textContent, /Draft preview only/);
  const latest = { ...initial, selectedPrinter: secondDevice,
    prepared: { ...initial.prepared, target: secondDevice.id, inspectionId: 'inspection-2' } };
  ui.state(latest);
  await ui.intervals[0]();
  const currentBitmap = $('#card');
  assert.equal(currentBitmap.hidden, true);
  assert.equal($('#confirm').disabled, true);
  oldBitmap.events.get('load')();
  assert.equal($('#confirm').disabled, true, 'Old bitmap loads cannot approve a replacement');
  currentBitmap.events.get('load')();
  assert.equal(currentBitmap.hidden, false);
  assert.equal($('#confirm').disabled, false);
  oldBitmap.events.get('error')();
  assert.equal($('#confirm').disabled, false, 'Stale failures cannot invalidate the new image');
  currentBitmap.events.get('error')();
  assert.equal(currentBitmap.hidden, true);
  assert.equal($('#confirm').disabled, true, 'Current image failure always disables Print');
});

test('edits and invalid rendering hide the exact bitmap, including late loads', async () => {
  const initial = readyState();
  const ui = await browser(initial, async route => {
    assert.equal(route, 'update_draft');
    throw new Error('Invalid draft');
  });
  const { $ } = ui;
  const oldBitmap = $('#card');
  oldBitmap.events.get('load')();
  $('#field-title').events.get('input')();
  oldBitmap.events.get('load')();
  assert.equal(oldBitmap.hidden, true);
  assert.equal($('#confirm').disabled, true);
  await ui.tick();
  assert.equal($('#card').hidden, true, 'Failed edits do not display the old server revision');
  assert.equal($('#confirm').disabled, true);
  assert.match($('#error').textContent, /Invalid draft/);

  const invalid = await browser({ ...initial, renderedRevision: null, image: null });
  assert.equal(invalid.$('#card').hidden, true);
  assert.equal(invalid.$('#confirm').disabled, true);
});

test('an inspection completed after a settled newer edit cannot display or approve the old revision', async () => {
  const initial = { ...readyState(), prepared: null };
  let release;
  const calls = [];
  const ui = await browser(initial, async (route, input, state) => {
    calls.push(route);
    if (route === 'inspect_for_print') {
      await new Promise(resolve => { release = resolve; });
      return readyState();
    }
    if (route === 'update_draft') return { ...state, draft: input.draft, revision: 2, renderedRevision: 2 };
    if (route === 'invalidate_print') return { ...state, revision: 2, renderedRevision: 2, prepared: null };
    throw new Error(`Unexpected request: ${route}`);
  });
  const inspecting = ui.$('#inspect').events.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  ui.$('#field-title').value = 'NEW SYNTHETIC REVISION';
  ui.$('#field-title').events.get('input')();
  await ui.tick();
  await ui.tick();
  release();
  await inspecting;
  assert.equal(ui.$('#card').src, 'image.png?revision=2');
  ui.$('#card').events.get('load')();
  assert.equal(ui.$('#confirm').disabled, true);
  assert.ok(calls.includes('invalidate_print'));
  assert.ok(!calls.includes('confirm_print'));
});

test('inspection failure preserves a draft-only preview and explicit refresh guidance after polling', async () => {
  const initial = readyState();
  const ui = await browser(initial, async route => {
    assert.equal(route, 'inspect_for_print');
    ui.state({ ...initial, prepared: null, error: { message: 'Helper unavailable' } });
    throw new Error('Helper unavailable');
  });
  ui.$('#card').events.get('load')();
  await ui.$('#inspect').events.get('click')();
  assert.equal(ui.$('#card').src, 'image.png?revision=1');
  ui.$('#card').events.get('load')();
  assert.equal(ui.$('#confirm').disabled, true);
  await ui.intervals[0]();
  assert.match(ui.$('#print-ready').textContent, /Resolve the error, then refresh/);
  assert.match(ui.$('#error').textContent, /Helper unavailable/);
});

test('a late poll cannot replace the preview after a newer edit has settled', async () => {
  let release, delay = false;
  const initial = readyState();
  const ui = await browser(initial, async (route, input, state) => {
    assert.equal(route, 'update_draft');
    return { ...state, revision: 2, renderedRevision: 2, draft: input.draft, prepared: null };
  }, async state => {
    if (delay) { delay = false; await new Promise(resolve => { release = resolve; }); }
    return state;
  });
  delay = true;
  const polling = ui.intervals[0]();
  await new Promise(resolve => setImmediate(resolve));
  ui.$('#field-title').value = 'NEW SYNTHETIC REVISION';
  ui.$('#field-title').events.get('input')();
  await ui.tick();
  release();
  await polling;
  assert.equal(ui.$('#card').src, 'image.png?revision=2');
  assert.equal(ui.$('#field-title').value, 'NEW SYNTHETIC REVISION');
  assert.equal(ui.$('#confirm').disabled, true);
});
