import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { exampleDraft } from '../draft.mjs';

test('browser starts one poll on load and refreshes recovered state without opening saved drafts', async () => {
  const nodes = new Map(), intervals = [], cleared = [], listeners = new Map();
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
  let state = { draft: exampleDraft(), revision: 1, renderedRevision: null, saved: null, image: null,
    printingAvailable: false, error: { message: 'Temporary renderer failure' } };
  const source = await readFile(new URL('../editor.js', import.meta.url), 'utf8');
  await runInNewContext(`(async () => { ${source}\n })()`, {
    document: { querySelector: $, createElement: () => new Element(), querySelectorAll: () => [] },
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    fetch: async route => ({ ok: true, json: async () => route === 'list_drafts' ? [] : structuredClone(state) }),
    structuredClone, setInterval: callback => { intervals.push(callback); return intervals.length; },
    clearInterval: id => cleared.push(id), setTimeout, clearTimeout
  });
  assert.equal(intervals.length, 1, 'Polling starts without any toolbar click');
  assert.equal($('#error').textContent, 'Temporary renderer failure');
  state = { ...state, revision: 2, draft: { ...state.draft, title: 'SYNTHETIC RECOVERY' }, error: null };
  await intervals[0]();
  assert.equal($('#field-title').value, 'SYNTHETIC RECOVERY');
  assert.equal($('#card').hidden, true);
  state = { ...state, renderedRevision: 2, image: { width: 384, height: 100, estimatedPaperMm: 22.5 } };
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
