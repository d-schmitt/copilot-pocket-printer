import { objectKeys } from './draft.mjs';
import { PreviewError } from './png.mjs';

const shape = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const focusSchema = shape({ version: { const: 1 }, layout: { const: 'focus' },
  priorities: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', maxLength: 512 } } });
export const surpriseSchema = shape({ version: { const: 1 }, layout: { const: 'surprise' },
  message: { type: 'string', maxLength: 512 } });
export const templateNames = ['daily', 'focus', 'surprise'];
export function templateOf(document) {
  if (!document) return null;
  return document.layout === 'daily-card' ? 'daily' : ['focus', 'surprise'].includes(document.layout) ? document.layout : 'custom';
}
function line(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 512 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new PreviewError('invalid_document', 'Use a single line of at most 512 UTF-8 bytes for each priority or message.');
  }
}
export function validateTemplateDocument(document) {
  if (document.layout === 'focus') {
    objectKeys(document, ['version', 'layout', 'priorities']);
    if (!Array.isArray(document.priorities) || document.priorities.length !== 3) {
      throw new PreviewError('invalid_document', 'Focus list has exactly three priorities.');
    }
    document.priorities.forEach(line);
  } else {
    objectKeys(document, ['version', 'layout', 'message']);
    if (document.layout !== 'surprise') throw new PreviewError('invalid_document', 'Unknown template.');
    line(document.message);
  }
  if (document.version !== 1) throw new PreviewError('invalid_document', 'Use document version 1.');
}
// Original captions, not copied meme images or externally generated content.
const memes = [
  ['ONE SMALL PRINT', 'ONE GIANT TO-DO LIST'],
  ['I HAD ONE JOB', 'NOW IT IS ON PAPER'],
  ['PRINTING MY PLANS', 'REALITY SOLD SEPARATELY'],
  ['LESS SCROLLING', 'MORE PAPERWORK']
];
export function templateBlocks(document, seed) {
  validateTemplateDocument(document);
  const text = (value, style = 'heading') => ({ kind: 'text', text: value, style });
  if (document.layout === 'focus') return { version: 1, blocks: [
    text('FOCUS LIST', 'title'),
    ...document.priorities.map((value, index) => text(`${index + 1}. ${value.trim() ? value : '__________________________'}`))
  ] };
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new PreviewError('invalid_storage', 'Surprise needs a retained unsigned 32-bit draw seed.');
  }
  const blocks = seed % 2 === 0
    ? [text(memes[Math.floor(seed / 4) % memes.length][0], 'title'), { kind: 'art', name: 'printer' },
      text(memes[Math.floor(seed / 4) % memes.length][1], 'title')]
    : [text(`SUDOKU / ${Math.floor(seed / 2) % 2 === 0 ? 'Easy' : 'Medium'}`),
      { kind: 'sudoku', difficulty: Math.floor(seed / 2) % 2 === 0 ? 'easy' : 'medium', seed }];
  if (document.message.trim()) blocks.push(text(document.message));
  return { version: 1, blocks };
}
export function templateDocument(name) {
  if (name === 'focus') return { version: 1, layout: 'focus', priorities: ['', '', ''] };
  if (name === 'surprise') return { version: 1, layout: 'surprise', message: '' };
  if (name !== 'daily') throw new PreviewError('unknown_template', 'Choose Daily card, Focus list or Surprise.');
  const stamp = time => `2026-11-17T${time}:00+01:00`;
  return {
    version: 1, layout: 'daily-card',
    config: { location: 'Friedrichshafen', latitude: 47.65, longitude: 9.48, timezone: 'Europe/Berlin',
      work_start: '08:00', work_end: '17:00', lunch_start: '12:00', lunch_end: '13:00' },
    date: '2026-11-17', now: stamp('06:00'),
    calendar: { state: 'available', events: [
      { start: stamp('09:00'), end: stamp('09:30') }, { start: stamp('12:00'), end: stamp('12:30') },
      { start: stamp('15:00'), end: stamp('15:30') }
    ] },
    weather: { state: 'available', sunrise: stamp('07:30'), sunset: stamp('17:00'),
      hours: Array.from({ length: 24 }, (_, hour) => ({
        start: stamp(`${String(hour).padStart(2, '0')}:00`), cloud: hour === 12 ? 10 : 70, precipitation: 0
      })) },
    bottom: 'joke', seed: 17, synthetic: true
  };
}
