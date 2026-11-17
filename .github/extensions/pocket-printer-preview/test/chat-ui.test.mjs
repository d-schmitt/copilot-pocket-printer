import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const device = { id: '11111111-2222-4333-8444-555555555555', name: 'Mini Pocket Printer_BLE' };
const initial = () => ({ revision: 2, renderedRevision: 2, document: { version: 1, blocks: [] },
  image: { width: 384, height: 100, sha256: 'original', estimatedPaperMm: 22.5 },
  error: null, prepared: null, selectedPrinter: null, discovery: { state: 'idle', devices: [], message: 'Find printer' } });
const prepared = (id = 'one', revision = 2) => ({
  inspectionId: id, revision, target: device.id, jobId: 'original-job', bitmapDigest: 'bitmap',
  digest: 'original', mode: 'ai_client', approvalToken: 'token', claimed: false,
  health: { bluetooth: 'ready', safety_blocked: false }, estimatedPaperMm: 22.5
});
async function browser(input, onPost) {
  const nodes = new Map(), intervals = [], events = new Map();
  class Element {
    constructor() { this.children = []; this.events = new Map(); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, callback) { this.events.set(name, callback); }
  }
  const $ = name => {
    if (!nodes.has(name)) nodes.set(name, new Element());
    return nodes.get(name);
  };
  let state = structuredClone(input), get;
  const calls = [];
  const source = await readFile(new URL('../chat.js', import.meta.url), 'utf8');
  await runInNewContext(`(async () => { ${source} })()`, {
    document: { querySelector: $, createElement: () => new Element() },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    fetch: async (route, options) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(options.body); calls.push({ route, body });
        state = await onPost(route, body, state);
      } else if (get) return get();
      return { ok: true, json: async () => structuredClone(state) };
    },
    setInterval: callback => { intervals.push(callback); return intervals.length; }, clearInterval() {}
  });
  return { $, calls, tick: () => intervals.at(-1)(), events,
    set: value => { state = structuredClone(value); }, get: value => { get = value; } };
}
test('one image switches from explicit draft to exact bitmap, and only a trusted loaded Print dispatches', async () => {
  const ui = await browser(initial(), async (route, body, state) => {
    if (route === 'start_scan') return { ...state, discovery: { state: 'stopped', scanId: 'scan', devices: [device], message: 'Found' } };
    if (route === 'select_printer') return { ...state, prepared: null, selectedPrinter: device };
    if (route === 'inspect_for_print') return { ...state, prepared: prepared() };
    if (route === 'confirm_print') return { ...state, prepared: { ...state.prepared, claimed: true } };
    throw new Error(route);
  });
  const $ = ui.$;
  assert.equal(ui.calls.length, 0);
  assert.match($('#preview-status').textContent, /Draft/);
  assert.equal($('#preview').children.length, 1);
  const draftImage = $('#preview').children[0];
  await $('#scan').events.get('click')();
  assert.equal($('#target').value, '');
  $('#target').value = device.id;
  await $('#target').events.get('change')();
  assert.equal($('#preview').children.length, 1);
  assert.match($('#preview').children[0].src, /print-preview/);
  draftImage.events.get('load')();
  assert.equal($('#print').disabled, true, 'Late draft load is not approval');
  $('#preview').children[0].events.get('load')();
  assert.equal($('#print').disabled, false);
  await $('#print').events.get('click')({ isTrusted: false });
  assert.equal(ui.calls.filter(c => c.route === 'confirm_print').length, 0);
  await $('#print').events.get('click')({ isTrusted: true });
  await $('#print').events.get('click')({ isTrusted: true });
  assert.equal(ui.calls.filter(c => c.route === 'confirm_print').length, 1);
  assert.equal(ui.calls.at(-1).body.inspectionId, 'one');
});
test('image load failure, newer chat revision and stale image events cannot enable Print', async () => {
  const value = { ...initial(), prepared: prepared(), selectedPrinter: device };
  const ui = await browser(value, async () => { throw new Error('No automatic retries'); });
  const $ = ui.$, oldImage = $('#preview').children[0];
  oldImage.events.get('error')();
  assert.equal($('#print').disabled, true);
  assert.match($('#error').textContent, /could not be displayed/);
  ui.set({ ...value, revision: 3, renderedRevision: null, image: null, prepared: null });
  await ui.tick();
  assert.equal($('#preview').children.length, 0);
  oldImage.events.get('load')();
  assert.equal($('#print').disabled, true);
  assert.equal(ui.calls.length, 0);
});
test('an in-flight poll cannot restore approval after selection or page departure', async () => {
  const value = { ...initial(), prepared: prepared(), selectedPrinter: device,
    discovery: { state: 'stopped', devices: [device], message: 'Found' } };
  const ui = await browser(value, async (route, body, state) => {
    assert.equal(route, 'select_printer');
    return { ...state, selectedPrinter: null, prepared: null };
  });
  ui.$('#preview').children[0].events.get('load')();
  let release;
  ui.get(() => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => value }); }));
  const pending = ui.tick();
  ui.$('#target').value = '';
  await ui.$('#target').events.get('change')();
  release(); await pending;
  assert.equal(ui.$('#print').disabled, true);
  assert.equal(ui.$('#target').value, '');
  ui.events.get('pagehide')();
  assert.equal(ui.$('#print').disabled, true);
});

test('poll recovery and preserved-page return reload the bitmap before restoring Print', async () => {
  const value = { ...initial(), prepared: prepared(), selectedPrinter: device };
  const ui = await browser(value, async () => { throw new Error('Recovery must not call helper operations'); });
  const $ = ui.$;
  $('#preview').children[0].events.get('load')();
  assert.equal($('#print').disabled, false);
  ui.get(async () => { throw new Error('Temporary connection failure'); });
  await ui.tick();
  assert.equal($('#print').disabled, true);
  ui.get(null);
  const old = $('#preview').children[0];
  await ui.tick();
  assert.notEqual($('#preview').children[0], old);
  assert.equal($('#print').disabled, true);
  $('#preview').children[0].events.get('load')();
  assert.equal($('#print').disabled, false);
  ui.events.get('pagehide')();
  ui.events.get('pageshow')();
  await ui.tick();
  assert.equal($('#print').disabled, true);
  $('#preview').children[0].events.get('load')();
  assert.equal($('#print').disabled, false);
  assert.equal(ui.calls.length, 0);
});
