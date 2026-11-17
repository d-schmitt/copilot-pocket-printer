import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dailyDocumentTemplate, validateDailyDocument } from '../daily-document.mjs';
import { renderDocument } from '../document.mjs';
import { renderTemplate } from '../draft.mjs';
import { dailyFixture } from './daily-fixture.mjs';

async function original(document) {
  const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
from daily_card.model import Config, Day, normalize_calendar, normalize_weather
from daily_card.template import template
raw = json.load(sys.stdin)
config = Config.parse(raw["config"])
day = Day.create(raw["date"], config.timezone, raw["now"])
assert "daily_card.providers" not in sys.modules
print(json.dumps(template(config, day, normalize_calendar(raw["calendar"], day),
                         normalize_weather(raw["weather"], day), raw["bottom"], raw["seed"], raw["synthetic"])))
`;
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-I', '-B', '-c', script,
      fileURLToPath(new URL('../../../../', import.meta.url))], { timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error);
      else { try { resolve(JSON.parse(stdout)); } catch (failure) { reject(failure); } }
    });
    child.stdin.end(JSON.stringify(document));
  });
}

test('daily V2 is byte-identical to the original daily template, including typography, compact rows and seeded Sudoku', async () => {
  for (const bottom of ['joke', 'sudoku-easy', 'sudoku-medium']) {
    const document = dailyFixture(bottom);
    const reference = await original(document);
    assert.deepEqual(await dailyDocumentTemplate(document), reference);
    assert.deepEqual(await renderDocument(document), await renderTemplate(reference),
      `${bottom}: every original pixel is preserved`);
    assert.deepEqual(reference.blocks[0], { kind: 'header', left: 'DAILY CARD', right: '06:00' });
    assert.deepEqual(reference.blocks[1].items.map(item => item.style), ['heading', 'body']);
    assert.equal(reference.blocks.filter(block => block.kind === 'rule').length, 4);
    for (const title of ['DAYLIGHT', 'WALK / remaining daylight', 'MEETINGS / whole day']) {
      assert.equal(reference.blocks.find(block => block.text === title).style, 'heading');
    }
    assert.equal(reference.blocks.find(block => block.text === '07:30 - 17:00').style, 'body');
    assert.ok(reference.blocks.some(block => block.kind === 'compact' && block.items[0].text === 'First 09:00-09:30'));
    if (bottom.startsWith('sudoku')) {
      assert.ok(reference.blocks.some(block => block.kind === 'sudoku' && block.seed === 17));
    }
  }
});

test('daily boundary rejects arbitrary prose, styles, providers and invalid timing without changing generic defaults', async () => {
  const valid = dailyFixture();
  for (const mutate of [
    value => { value.calendar.events[0].subject = 'DO NOT RETAIN PRIVATE METADATA'; },
    value => { value.weather.url = 'https://example.invalid'; },
    value => { value.style = 'small'; },
    value => { value.bottom = 'art'; },
    value => { value.seed = -1; },
    value => { value.synthetic = 'true'; },
    value => { value.weather.hours[0].cloud = Infinity; }
  ]) {
    const value = structuredClone(valid); mutate(value);
    assert.throws(() => validateDailyDocument(value));
  }
  for (const mutate of [
    value => { value.date = '2026-02-30'; },
    value => { value.config.timezone = 'Unknown/Zone'; },
    value => { value.calendar.events[0].end = value.calendar.events[0].start; },
    value => { value.weather.sunset = value.weather.sunrise; }
  ]) {
    const value = structuredClone(valid); mutate(value);
    await assert.rejects(renderDocument(value), error => error.code === 'invalid_daily_card');
  }
  await assert.rejects(renderDocument({ ...valid,
    config: { ...valid.config, location: 'Unbroken'.repeat(10) } }), /unbroken word/);
  const generic = { version: 1, blocks: [{ kind: 'heading', text: 'HEADING' },
    { kind: 'text', text: 'Ordinary body' }, { kind: 'checklist', items: [{ text: 'Item', checked: false }] }] };
  assert.deepEqual(await renderDocument(generic), await renderTemplate({ version: 1, blocks: [
    { kind: 'text', text: 'HEADING', style: 'title' },
    { kind: 'text', text: 'Ordinary body', style: 'heading' },
    { kind: 'text', text: '[ ] Item', style: 'heading' }
  ] }));
});
