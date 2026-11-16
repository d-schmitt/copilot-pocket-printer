import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PrintLedger, Printing } from '../printing.mjs';
import { CardEditor, editorCanvas } from '../editor.mjs';
import { exampleDraft, renderDraft } from '../draft.mjs';
import { draftStore, writeRecord } from '../private-store.mjs';
import { inspectPng } from '../png.mjs';

const target = '11111111-2222-4333-8444-555555555555';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const original = await readFile(new URL('../sample.png', import.meta.url));

async function root(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pocket-print-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function fakeHelper() {
  const calls = [], receipts = new Map();
  const health = { bluetooth: 'ready', safety_blocked: false, confirmation_mode: 'ai_client',
    supports_expected_confirmation_mode: true };
  const helper = async (method, fields) => {
    calls.push({ method, fields });
    if (method === 'helper_status') return { health: { ...health } };
    if (method === 'inspect_png') {
      const png = Buffer.from(fields.png_base64, 'base64'), metadata = inspectPng(png);
      return { image: { sha256: hash(png), width: 384, height: metadata.height, png_bytes: png.length, clearance_dots: 80 },
        preview_png_base64: fields.png_base64 };
    }
    if (method === 'submit_png') {
      assert.equal(fields.expected_confirmation_mode, health.confirmation_mode);
      const receipt = { job_id: fields.job_id, device_id: fields.device_id, image_sha256: hash(Buffer.from(fields.png_base64, 'base64')),
        height: inspectPng(Buffer.from(fields.png_base64, 'base64')).height,
        state: 'submitted_only', paper_confirmed: false, confirmation_mode: health.confirmation_mode,
        message: 'INERT: no physical operation' };
      receipts.set(fields.job_id, receipt); return { receipt };
    }
    if (method === 'job_status') {
      if (!receipts.has(fields.job_id)) throw Object.assign(new Error('Missing receipt'), { code: 'job_not_found' });
      return { receipt: receipts.get(fields.job_id) };
    }
    throw new Error(`Unexpected operation ${method}`);
  };
  return { helper, calls, receipts, health };
}
async function prepared(t, options = {}) {
  const fixture = fakeHelper(), directory = await root(t);
  const ledger = new PrintLedger(directory);
  const service = new Printing({ ledger, helper: options.helper ?? fixture.helper });
  const result = await service.inspect({ original, target, revision: 1, current() {} });
  return { ...result, ...fixture, directory, ledger, service };
}
function approval(editor) {
  const value = editor.state(true).prepared;
  return { revision: value.revision, jobId: value.jobId, target: value.target, digest: value.digest,
    bitmapDigest: value.bitmapDigest, inspectionId: value.inspectionId, approvalToken: value.approvalToken, paperApproved: true };
}

test('inspection binds original bytes, exact bitmap, explicit target and stable identity without submission', async t => {
  const value = await prepared(t);
  assert.deepEqual(value.calls.map(call => call.method), ['helper_status', 'inspect_png']);
  const same = await value.service.inspect({ original, target, revision: 9, current() {} });
  assert.equal(same.intent.jobId, value.intent.jobId, 'Same image/target/mode reuses durable identity across revisions');
  assert.equal(same.intent.original, original.toString('base64'));
  assert.equal(same.intent.digest, hash(original));
  assert.equal((await stat(value.ledger.path(value.intent.key, 'intent'))).mode & 0o777, 0o600);
  assert.equal((await stat(value.ledger.directory)).mode & 0o777, 0o700);
  const malformed = new Printing({ ledger: value.ledger, helper: async (method, fields) => {
    const result = await value.helper(method, fields);
    if (method === 'inspect_png') result.image.sha256 = '0'.repeat(64);
    return result;
  } });
  await assert.rejects(malformed.inspect({ original, target, revision: 1, current() {} }), /metadata/);
  value.health.supports_expected_confirmation_mode = false;
  await assert.rejects(value.service.inspect({ original, target, revision: 1, current() {} }), /update/);
});

test('duplicate dispatch and restart query the original receipt without resubmitting', async t => {
  const value = await prepared(t);
  const first = await value.service.dispatch(value.intent, () => {});
  assert.equal(first.state, 'submitted_only'); assert.equal(first.paperConfirmed, false);
  const restarted = new Printing({ ledger: new PrintLedger(value.directory), helper: value.helper });
  assert.equal((await restarted.dispatch(value.intent, () => {})).state, 'submitted_only');
  assert.equal(value.calls.filter(call => call.method === 'submit_png').length, 1);
});

test('lost replies, missing receipts and crash claims block retry and replacement jobs', async t => {
  const value = await prepared(t);
  const lost = new Printing({ ledger: value.ledger, helper: async (method, fields) => {
    if (method === 'submit_png') throw Object.assign(new Error('Lost'), { code: 'ipc_timeout' });
    return value.helper(method, fields);
  } });
  const result = await lost.dispatch(value.intent, () => {});
  assert.equal(result.state, 'uncertain');
  assert.equal((await lost.dispatch(value.intent, () => {})).state, 'uncertain');
  const otherImage = await renderDraft(exampleDraft());
  await assert.rejects(lost.inspect({ original: otherImage, target, revision: 2, current() {} }), /no verifiable receipt/);
  assert.equal((await value.ledger.keys()).length, 1, 'No replacement UUID was created');
  assert.equal(value.calls.filter(call => call.method === 'submit_png').length, 0);
  const crashed = await prepared(t);
  await writeRecord(crashed.ledger.path(crashed.intent.key, 'claim'),
    { jobId: crashed.intent.jobId, digest: crashed.intent.digest, target }, { exclusive: true });
  assert.equal((await crashed.service.dispatch(crashed.intent, () => {})).state, 'uncertain');
  assert.equal(crashed.calls.filter(call => call.method === 'submit_png').length, 0);
});

test('mode changes and native unsafe/active states fail before the claim', async t => {
  const value = await prepared(t);
  for (const [field, changed] of [['confirmation_mode', 'native'], ['safety_blocked', true],
    ['bluetooth', 'off'], ['active_job_id', randomUUID()], ['supports_expected_confirmation_mode', false],
    ['confirmation_preference_error', { code: 'failed' }]]) {
    const previous = value.health[field]; value.health[field] = changed;
    await assert.rejects(value.service.dispatch(value.intent, () => {}), /state or confirmation mode changed/);
    value.health[field] = previous;
    assert.equal(await value.ledger.claimed(value.intent), false);
  }
});

test('only an authenticated submit rejection settles an unadmitted job, never a status/transport error', async t => {
  const value = await prepared(t);
  const rejecting = new Printing({ ledger: value.ledger, helper: async (method, fields) => {
    if (method === 'submit_png') throw Object.assign(new Error('Native busy'), { code: 'busy', helperReported: true });
    return value.helper(method, fields);
  } });
  assert.equal((await rejecting.dispatch(value.intent, () => {})).state, 'rejected_before_admission');
  assert.equal((await rejecting.dispatch(value.intent, () => {})).state, 'rejected_before_admission');
  const next = await value.service.inspect({ original: await renderDraft(exampleDraft()), target, revision: 2, current() {} });
  await value.service.dispatch(next.intent, () => {});
  const closing = new Printing({ ledger: value.ledger, helper: async () => {
    throw Object.assign(new Error('Native closing'), { code: 'helper_closing', helperReported: true });
  } });
  assert.equal((await closing.status(next.intent.jobId)).state, 'uncertain');
  assert.equal(await value.ledger.rejected(next.intent), null, 'A status failure does not prove no admission');
  const uncertain = await prepared(t);
  const transport = new Printing({ ledger: uncertain.ledger, helper: async (method, fields) => {
    if (method === 'submit_png') throw Object.assign(new Error('Untrusted busy'), { code: 'busy' });
    return uncertain.helper(method, fields);
  } });
  assert.equal((await transport.dispatch(uncertain.intent, () => {})).state, 'uncertain');
  assert.equal(await uncertain.ledger.rejected(uncertain.intent), null);
});

test('draft edits, target invalidation, stale async inspection and close invalidate approval', async t => {
  const value = await prepared(t);
  const editor = new CardEditor({ render: async () => original, printing: value.service });
  await editor.refresh();
  await editor.inspectForPrint({ revision: 1, target });
  assert.equal(editor.state().prepared.approvalToken, undefined, 'SDK state never returns the browser approval token');
  let token = approval(editor);
  await editor.update({ revision: 1, draft: { ...exampleDraft(), title: 'EDITED' } });
  await assert.rejects(editor.confirmPrint(token), /approval/);
  await editor.inspectForPrint({ revision: editor.revision, target });
  token = approval(editor);
  editor.invalidatePrint();
  await assert.rejects(editor.confirmPrint(token), /approval/);
  await editor.inspectForPrint({ revision: editor.revision, target });
  token = approval(editor);
  editor.close();
  await assert.rejects(editor.confirmPrint(token), /approval/);
  assert.equal(value.calls.filter(call => call.method === 'submit_png').length, 0);
  let finish;
  const waiting = new Printing({ ledger: value.ledger, helper: async (method, fields) => {
    if (method === 'inspect_png') await new Promise(resolve => { finish = resolve; });
    return value.helper(method, fields);
  } });
  const stale = new CardEditor({ render: async () => original, printing: waiting });
  await stale.refresh();
  const inspecting = stale.inspectForPrint({ revision: 1, target });
  await new Promise(resolve => setImmediate(resolve));
  stale.invalidatePrint(); finish();
  await assert.rejects(inspecting, /changed during inspection/);
  assert.equal(stale.prepared, null);
});

test('confirmation binds every value and consumes one approval before dispatch', async t => {
  const value = await prepared(t);
  const editor = new CardEditor({ render: async () => original, printing: value.service });
  await editor.refresh(); await editor.inspectForPrint({ revision: 1, target });
  const token = approval(editor);
  for (const [key, changed] of [['paperApproved', false], ['target', randomUUID()], ['digest', '0'.repeat(64)],
    ['bitmapDigest', '0'.repeat(64)], ['revision', 3], ['approvalToken', 'a'.repeat(64)], ['jobId', randomUUID()]]) {
    await assert.rejects(editor.confirmPrint({ ...token, [key]: changed }), /approval/);
  }
  const first = editor.confirmPrint(token);
  await assert.rejects(editor.confirmPrint(token), /approval/);
  await assert.rejects(editor.update({ revision: 1, draft: exampleDraft() }), /Wait before changing/);
  await first;
  assert.equal(value.calls.filter(call => call.method === 'submit_png').length, 1);
});

test('two separate provider processes admit at most one dispatch', async t => {
  const value = await prepared(t);
  const log = join(value.directory, 'inert-submissions.log');
  const script = `
    import { Printing, PrintLedger } from ${JSON.stringify(new URL('../printing.mjs', import.meta.url).href)};
    import { appendFile } from 'node:fs/promises';
    const ledger = new PrintLedger(${JSON.stringify(value.directory)});
    const intent = await ledger.read(${JSON.stringify(value.intent.key)});
    const receipt = {job_id:intent.jobId,device_id:intent.target,image_sha256:intent.digest,height:288,state:'submitted_only',paper_confirmed:false,confirmation_mode:'ai_client'};
    const service = new Printing({ledger,helper:async(method)=>{
      if(method==='helper_status')return {health:{bluetooth:'ready',safety_blocked:false,confirmation_mode:'ai_client',supports_expected_confirmation_mode:true}};
      if(method==='submit_png') await appendFile(${JSON.stringify(log)}, 'inert\\n', {mode:0o600});
      return {receipt};
    }});
    try { await service.dispatch(intent,()=>{}); } catch(error) { if(error.code!=='storage_locked')throw error; }
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error += data; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([run(), run()]);
  assert.equal(await readFile(log, 'utf8'), 'inert\n');
  await run();
  assert.equal(await readFile(log, 'utf8'), 'inert\n');
});

test('corrupt/orphaned claims and abandoned locks fail closed', async t => {
  const value = await prepared(t);
  await writeFile(value.ledger.path(value.intent.key, 'claim'), '{broken', { mode: 0o600 });
  await assert.rejects(value.service.dispatch(value.intent, () => {}), /corrupt/);
  await rm(value.ledger.path(value.intent.key, 'intent'));
  await assert.rejects(value.ledger.keys(), /orphaned/);
  const other = await prepared(t);
  await writeFile(join(other.ledger.directory, '.lock'), '', { mode: 0o600 });
  await assert.rejects(other.service.dispatch(other.intent, () => {}), /Storage is busy/);
});

test('native-only recovery gates new jobs until the original uncertain outcome is acknowledged', async t => {
  const value = await prepared(t);
  const another = await value.service.inspect({ original: await renderDraft(exampleDraft()), target, revision: 2, current() {} });
  await value.service.dispatch(value.intent, () => {});
  const receipt = value.receipts.get(value.intent.jobId);
  receipt.state = 'uncertain'; receipt.outcome_acknowledged = false;
  await assert.rejects(value.service.inspect({ original: Buffer.from(another.intent.original, 'base64'), target, revision: 2, current() {} }),
    /active or uncertain/, 'Deduplicated unclaimed intents still check unresolved prior jobs');
  await assert.rejects(value.service.dispatch(another.intent, () => {}), /active or uncertain/);
  receipt.outcome_acknowledged = true;
  assert.equal((await value.service.dispatch(another.intent, () => {})).state, 'submitted_only');
});

test('bounded retained intents allow explicit unsubmitted cleanup, never claimed job removal', async t => {
  const value = await prepared(t);
  for (let index = 1; index < 64; index++) {
    await value.ledger.create({ original, preview: original, target: randomUUID(), revision: index, mode: 'native' });
  }
  assert.equal((await value.ledger.list()).length, 64);
  assert.equal((await value.ledger.find(value.intent.jobId)).key, value.intent.key);
  const create = () => value.ledger.create({ original, preview: original, target: randomUUID(), revision: 1, mode: 'native' });
  await assert.rejects(create(), /64-intent limit/);
  const disposable = (await value.ledger.list()).find(intent => intent.jobId !== value.intent.jobId);
  await value.ledger.discardUnsubmitted(disposable.jobId);
  await assert.rejects(value.ledger.find(disposable.jobId), /No retained intent/);
  await create();
  await value.service.dispatch(value.intent, () => {});
  await assert.rejects(value.ledger.discardUnsubmitted(value.intent.jobId), /never be deleted/);
  assert.equal((await value.ledger.list()).length, 64);
  assert.equal(value.calls.filter(call => call.method === 'submit_png').length, 1);
});

test('create-only records publish whole contents without replacement or temporary-file leaks', async t => {
  const directory = await root(t), path = join(directory, 'claim.json');
  const values = [{ jobId: randomUUID(), content: 'a'.repeat(65536) }, { jobId: randomUUID(), content: 'b'.repeat(65536) }];
  const results = await Promise.allSettled(values.map(value => writeRecord(path, value, { exclusive: true })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'EEXIST');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), values[results.findIndex(result => result.status === 'fulfilled')]);
  assert.deepEqual(await readdir(directory), ['claim.json']);
  const value = await prepared(t);
  await writeFile(value.ledger.path(value.intent.key, 'intent'), Buffer.alloc(3 * 1024 * 1024 + 1));
  await assert.rejects(value.ledger.read(value.intent.key), /size/);
});

test('print endpoint is not an SDK action and rejects cross-origin/malformed requests', async t => {
  const directory = await root(t), fixture = fakeHelper();
  const canvas = editorCanvas(undefined, { render: async () => original, store: draftStore(directory),
    printing: () => new Printing({ ledger: new PrintLedger(directory), helper: fixture.helper }) });
  assert.ok(!canvas.actions.some(action => /confirm|submit|discard/.test(action.name)));
  const ctx = { instanceId: 'print-boundary' };
  const { url } = await canvas.open(ctx);
  t.after(() => canvas.onClose(ctx));
  const origin = new URL(url).origin;
  const post = (name, body, Origin = origin) => fetch(url + name, { method: 'POST',
    headers: { Origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(fixture.calls.length, 0, 'Open does not inspect or contact the helper');
  assert.equal((await post('confirm_print', {}, 'null')).status, 403);
  assert.equal((await post('confirm_print', {}, 'https://attacker.invalid')).status, 403);
  assert.equal((await post('confirm_print', {})).status, 400);
  const inspected = await (await post('inspect_for_print', { revision: 1, target })).json();
  assert.ok(inspected.prepared.approvalToken);
  const prepared = inspected.prepared;
  assert.equal((await post('discard_unsubmitted', { jobId: prepared.jobId, confirmed: true }, 'https://attacker.invalid')).status, 403);
  assert.equal((await post('discard_unsubmitted', { jobId: prepared.jobId, confirmed: false })).status, 400);
  const token = Object.fromEntries(['revision', 'jobId', 'target', 'digest', 'bitmapDigest', 'inspectionId', 'approvalToken'].map(key => [key, prepared[key]]));
  token.paperApproved = true;
  assert.equal((await post('confirm_print', { ...token, extra: true })).status, 400);
  assert.equal((await fetch(url + 'confirm_print')).status, 404);
  assert.equal((await post('confirm_print', token)).status, 200);
  assert.equal((await post('discard_unsubmitted', { jobId: prepared.jobId, confirmed: true })).status, 400);
  assert.equal(fixture.calls.filter(call => call.method === 'submit_png').length, 1);
  await canvas.onClose(ctx);
  assert.equal(fixture.calls.filter(call => call.method === 'submit_png').length, 1);
});
