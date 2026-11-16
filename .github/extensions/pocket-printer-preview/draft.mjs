import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalPng, PreviewError } from './png.mjs';

export const sectionIds = ['heading', 'day', 'walk', 'meetings', 'bottom'];
export const rendererPath = fileURLToPath(new URL('../../../.build/debug/card-renderer', import.meta.url));
export function exampleDraft() {
  return {
    version: 1, title: 'POCKET CARD', name: 'Sample Reader',
    day: 'MONDAY / 16 NOVEMBER\nDaylight 07:30 - 17:00',
    walk: 'A short walk\n12:15 - 12:45 / synthetic dry forecast',
    meetings: 'Sample meetings\nFirst 09:00-09:30 / Last 15:00-15:30',
    joke: 'My to-do list asked for a day off.\nI put it on the list.',
    bottom: 'joke', difficulty: 'easy', seed: 17,
    order: [...sectionIds], enabled: Object.fromEntries(sectionIds.map(id => [id, true]))
  };
}
export function objectKeys(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new PreviewError('invalid_request', 'Unexpected or missing fields.');
  }
}
export function validateDraft(value) {
  objectKeys(value, ['version', 'title', 'name', 'day', 'walk', 'meetings', 'joke', 'bottom',
    'difficulty', 'seed', 'order', 'enabled']);
  if (value.version !== 1) throw new PreviewError('invalid_draft', 'Unsupported draft version.');
  for (const key of ['title', 'name', 'day', 'walk', 'meetings', 'joke']) {
    const limit = ['name', 'title'].includes(key) ? 128 : 2048;
    if (typeof value[key] !== 'string' || !value[key].trim() ||
        Buffer.byteLength(value[key]) > limit || value[key].includes('\0')) {
      throw new PreviewError('invalid_draft', `${key} must contain 1-${limit} UTF-8 bytes.`);
    }
  }
  if (!['joke', 'sudoku', 'art'].includes(value.bottom) || !['easy', 'medium'].includes(value.difficulty) ||
      !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) {
    throw new PreviewError('invalid_draft', 'Choose a supported bottom, difficulty and unsigned 32-bit seed.');
  }
  if (!Array.isArray(value.order) || value.order.length !== sectionIds.length ||
      new Set(value.order).size !== sectionIds.length || value.order.some(id => !sectionIds.includes(id))) {
    throw new PreviewError('invalid_draft', 'Section order must contain each section exactly once.');
  }
  objectKeys(value.enabled, sectionIds);
  if (sectionIds.some(id => typeof value.enabled[id] !== 'boolean') ||
      !Object.values(value.enabled).some(Boolean)) {
    throw new PreviewError('invalid_draft', 'Enable at least one section; section toggles must be booleans.');
  }
  return structuredClone(value);
}
export function templateFor(draft) {
  const value = validateDraft(draft);
  const text = (content, style = 'body') => ({ kind: 'text', text: content, style });
  const sections = {
    heading: [text(value.title, 'title'), text(value.name, 'heading')],
    day: [text(value.day)], walk: [text(value.walk)], meetings: [text(value.meetings)],
    bottom: value.bottom === 'joke' ? [text('JOKE', 'heading'), text(value.joke)] :
      value.bottom === 'art' ? [{ kind: 'art', name: 'garden' }] :
        [text(`SUDOKU / ${value.difficulty.toUpperCase()}`, 'heading'),
          { kind: 'sudoku', difficulty: value.difficulty, seed: value.seed }]
  };
  const blocks = [];
  for (const id of value.order.filter(id => value.enabled[id])) {
    if (blocks.length) blocks.push({ kind: 'rule' });
    blocks.push(...sections[id]);
  }
  return { version: 1, blocks };
}

export async function renderDraft(draft) {
  const input = JSON.stringify(templateFor(draft));
  const directory = await mkdtemp(join(tmpdir(), 'pocket-card-render-'));
  const output = join(directory, 'card.png');
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(rendererPath, ['-', output],
        { timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true }, error => {
          if (!error) { resolve(); return; }
          reject(new PreviewError('render_failed', error.code === 'ENOENT'
            ? 'Build the existing renderer first: swift build --product card-renderer.'
            : 'Rendering failed. Shorten text or reduce content; the current draft cannot be printed.'));
        });
      child.stdin.on('error', () => { /* The process callback reports the renderer failure. */ });
      child.stdin.end(input);
    });
    return await readLocalPng(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
