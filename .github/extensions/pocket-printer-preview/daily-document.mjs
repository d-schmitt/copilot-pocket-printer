import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { objectKeys } from './draft.mjs';
import { PreviewError } from './png.mjs';

const shape = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const timestamp = string(40);
const unavailable = shape({ state: { const: 'unavailable' } });
export const dailyDocumentSchema = shape({
  version: { const: 1 }, layout: { const: 'daily-card' },
  config: shape({
    location: string(80), latitude: number(-90, 90), longitude: number(-180, 180), timezone: string(128),
    work_start: string(5), work_end: string(5), lunch_start: string(5), lunch_end: string(5)
  }),
  date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, now: timestamp,
  calendar: { oneOf: [unavailable, shape({
    state: { const: 'available' },
    events: { type: 'array', maxItems: 500, items: shape({ start: timestamp, end: timestamp }) }
  })] },
  weather: { oneOf: [unavailable, shape({
    state: { const: 'available' }, sunrise: timestamp, sunset: timestamp,
    hours: { type: 'array', maxItems: 26, items: shape({
      start: timestamp, cloud: number(0, 100), precipitation: number(0, 500)
    }) }
  })] },
  bottom: { enum: ['joke', 'sudoku-easy', 'sudoku-medium'] },
  seed: { type: 'integer', minimum: 0, maximum: 0xffffffff },
  synthetic: { type: 'boolean' }
});

function invalid(message) { throw new PreviewError('invalid_daily_card', message); }
function bounded(value, limit) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || /[\x00-\x1f\x7f]/.test(value)) {
    invalid(`Daily-card labels and timestamps must contain 1-${limit} UTF-8 bytes without control characters.`);
  }
}
function numeric(value, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid('Daily-card numeric data is outside its supported range.');
  }
}
export function validateDailyDocument(value) {
  objectKeys(value, Object.keys(dailyDocumentSchema.properties));
  if (value.version !== 1 || value.layout !== 'daily-card' || typeof value.synthetic !== 'boolean' ||
      !['joke', 'sudoku-easy', 'sudoku-medium'].includes(value.bottom) ||
      !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) {
    invalid('Use version 1, daily-card layout, explicit synthetic flag, joke/Sudoku bottom and an unsigned 32-bit seed.');
  }
  objectKeys(value.config, Object.keys(dailyDocumentSchema.properties.config.properties));
  bounded(value.config.location, 80); bounded(value.config.timezone, 128);
  numeric(value.config.latitude, -90, 90); numeric(value.config.longitude, -180, 180);
  for (const key of ['work_start', 'work_end', 'lunch_start', 'lunch_end']) bounded(value.config[key], 5);
  bounded(value.date, 10); bounded(value.now, 40);
  for (const key of ['calendar', 'weather']) {
    const data = value[key];
    if (!data || !['available', 'unavailable'].includes(data.state)) invalid('Specify calendar and weather availability explicitly.');
    if (data.state === 'unavailable') { objectKeys(data, ['state']); continue; }
    if (key === 'calendar') {
      objectKeys(data, ['state', 'events']);
      if (!Array.isArray(data.events) || data.events.length > 500) invalid('Calendar needs at most 500 times-only events.');
      for (const event of data.events) {
        objectKeys(event, ['start', 'end']); bounded(event.start, 40); bounded(event.end, 40);
      }
    } else {
      objectKeys(data, ['state', 'sunrise', 'sunset', 'hours']);
      bounded(data.sunrise, 40); bounded(data.sunset, 40);
      if (!Array.isArray(data.hours) || data.hours.length > 26) invalid('Weather needs at most 26 numeric hourly observations.');
      for (const hour of data.hours) {
        objectKeys(hour, ['start', 'cloud', 'precipitation']);
        bounded(hour.start, 40); numeric(hour.cloud, 0, 100); numeric(hour.precipitation, 0, 500);
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 60 * 1024) invalid('Daily-card document exceeds 60 KiB.');
}

const dailyRoot = fileURLToPath(new URL('../../../', import.meta.url));
// Import the original offline model/template from a fixed root, never the network-capable CLI.
const bootstrap = 'import sys; sys.path.insert(0, sys.argv[1]); from daily_card.canvas import main; raise SystemExit(main())';
export async function dailyDocumentTemplate(document) {
  validateDailyDocument(document);
  const output = await new Promise((resolve, reject) => {
    const child = execFile('python3', ['-I', '-B', '-c', bootstrap, dailyRoot],
      { timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return; }
        const reason = typeof stderr === 'string' && stderr.startsWith('[invalid_daily_card] ')
          ? stderr.slice('[invalid_daily_card] '.length).trim().slice(0, 512) : null;
        reject(new PreviewError('invalid_daily_card', error.code === 'ENOENT'
          ? 'Python 3 is required for the original daily-card layout. Generic text/checklists still work.'
          : reason ?? 'The offline daily-card generator failed. Check Python 3 and the supplied dates, times and numeric data.'));
      });
    child.stdin.on('error', () => { /* The process callback reports the failure. */ });
    child.stdin.end(JSON.stringify(document));
  });
  try { return JSON.parse(output); }
  catch { throw new PreviewError('invalid_daily_card', 'The offline daily-card generator returned invalid JSON.'); }
}
