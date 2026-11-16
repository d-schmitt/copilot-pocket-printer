import { createHash, randomUUID } from 'node:crypto';
import { readdir, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { callHelper } from '../../../bridge/ipc.mjs';
import { PreviewError, inspectPng, MAX_PNG } from './png.mjs';
import { storeRoot, privateDirectory, readRecord, writeRecord, withStoreLock, requireId } from './private-store.mjs';
import { objectKeys } from './draft.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const modes = ['native', 'ai_client'];
const MAX_RECORD = 3 * 1024 * 1024;
const MAX_INTENTS = 64;
const keyPattern = /^[a-f0-9]{64}$/;
const states = ['awaiting_approval', 'in_progress', 'cancelling', 'submitted_only', 'cancelled_before_submission', 'uncertain'];
const noAdmissionCodes = new Set(['busy', 'discovery_busy', 'safety_blocked', 'confirmation_mode_changed',
  'helper_closing', 'invalid_request', 'paper_approval_required', 'invalid_image', 'preview_failed',
  'bluetooth_permission_pending', 'bluetooth_denied', 'bluetooth_restricted', 'bluetooth_off',
  'bluetooth_unsupported', 'bluetooth_unknown', 'bluetooth_not_determined']);
function pngBytes(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PNG / 3) * 4 ||
      Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new PreviewError('invalid_helper_preview', 'Expected bounded canonical PNG bytes.');
  }
  const bytes = Buffer.from(value, 'base64');
  inspectPng(bytes);
  return bytes;
}
function validHealth(health) {
  if (!health || !modes.includes(health.confirmation_mode) || typeof health.safety_blocked !== 'boolean' ||
      typeof health.bluetooth !== 'string') {
    throw new PreviewError('invalid_helper_status', 'Helper returned invalid status.');
  }
  return health;
}
function validReceipt(receipt, intent) {
  if (!receipt || receipt.job_id?.toLowerCase() !== intent.jobId ||
      receipt.device_id?.toLowerCase() !== intent.target || receipt.image_sha256 !== intent.digest ||
      receipt.height !== inspectPng(pngBytes(intent.original)).height ||
      receipt.confirmation_mode !== intent.mode || !states.includes(receipt.state) || typeof receipt.paper_confirmed !== 'boolean' ||
      (receipt.outcome_acknowledged !== undefined && typeof receipt.outcome_acknowledged !== 'boolean')) {
    throw new PreviewError('invalid_receipt', 'Helper receipt does not match the approved job. Outcome remains uncertain.');
  }
  return receipt;
}
function terminal(receipt) {
  return ['submitted_only', 'cancelled_before_submission'].includes(receipt.state) ||
    (receipt.state === 'uncertain' && receipt.outcome_acknowledged === true);
}
function intentKey(inputDigest, target, mode) { return digest(`${inputDigest}:${target}:${mode}`); }

export class PrintLedger {
  constructor(root = storeRoot) { this.root = root; this.directory = join(root, 'print-intents'); }
  async prepare() { await privateDirectory(this.root); await privateDirectory(this.directory); }
  path(key, kind) {
    if (!keyPattern.test(key)) throw new PreviewError('invalid_intent', 'Invalid print intent key.');
    return join(this.directory, `${key}.${kind}.json`);
  }
  async keys() {
    await this.prepare();
    const names = await readdir(this.directory);
    if (names.some(name => name !== '.lock' && !/^[a-f0-9]{64}\.(intent|claim|rejected)\.json$/.test(name))) {
      throw new PreviewError('unsafe_storage', 'Print storage contains interrupted or unexpected files. Inspect it before printing.');
    }
    const keys = names.filter(name => name.endsWith('.intent.json')).map(name => name.slice(0, 64));
    if (names.some(name => /\.(claim|rejected)\.json$/.test(name) && !keys.includes(name.slice(0, 64)))) {
      throw new PreviewError('invalid_storage', 'An orphaned dispatch claim exists. Do not remove it or create a replacement job.');
    }
    if (keys.length > MAX_INTENTS) throw new PreviewError('storage_limit', 'Print storage exceeds its 64-intent limit.');
    return keys;
  }
  async read(key) {
    const record = await readRecord(this.path(key, 'intent'), MAX_RECORD);
    objectKeys(record, ['version', 'key', 'jobId', 'target', 'digest', 'bitmapDigest', 'original', 'preview', 'revision', 'mode']);
    requireId(record.jobId); requireId(record.target);
    const original = pngBytes(record.original), preview = pngBytes(record.preview);
    if (record.version !== 1 || record.key !== key || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
        !modes.includes(record.mode) || digest(original) !== record.digest || digest(preview) !== record.bitmapDigest ||
        intentKey(record.digest, record.target, record.mode) !== key ||
        inspectPng(original).height !== inspectPng(preview).height) {
      throw new PreviewError('invalid_storage', 'Print intent is corrupt. No automatic recovery or replay.');
    }
    return record;
  }
  async claimed(intent) {
    let record;
    try { record = await readRecord(this.path(intent.key, 'claim'), 4096); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    objectKeys(record, ['jobId', 'digest', 'target']);
    if (record.jobId !== intent.jobId || record.digest !== intent.digest || record.target !== intent.target) {
      throw new PreviewError('invalid_storage', 'Dispatch claim does not match its immutable intent.');
    }
    return true;
  }
  async rejected(intent) {
    let record;
    try { record = await readRecord(this.path(intent.key, 'rejected'), 4096); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    objectKeys(record, ['jobId', 'digest', 'target', 'code']);
    if (record.jobId !== intent.jobId || record.digest !== intent.digest || record.target !== intent.target ||
        !noAdmissionCodes.has(record.code) || !await this.claimed(intent)) {
      throw new PreviewError('invalid_storage', 'Rejection record does not match a claimed intent.');
    }
    return record;
  }
  async create({ original, preview, target, revision, mode }, beforeCreate = async () => {}) {
    requireId(target);
    inspectPng(original); inspectPng(preview);
    if (!modes.includes(mode) || !Number.isSafeInteger(revision) || revision < 1) {
      throw new PreviewError('invalid_intent', 'Invalid preview revision or confirmation mode.');
    }
    await this.prepare();
    return withStoreLock(this.directory, async () => {
      const key = intentKey(digest(original), target, mode);
      const keys = await this.keys();
      await beforeCreate();
      if (keys.includes(key)) return this.read(key);
      if (keys.length >= MAX_INTENTS) throw new PreviewError('storage_limit', 'The private 64-intent limit is reached. Inspect retained jobs; nothing is automatically deleted.');
      const record = { version: 1, key, jobId: randomUUID(), target, digest: digest(original),
        bitmapDigest: digest(preview), original: original.toString('base64'), preview: preview.toString('base64'), revision, mode };
      if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD) throw new PreviewError('storage_limit', 'Print intent exceeds its private record limit.');
      await writeRecord(this.path(key, 'intent'), record, { exclusive: true });
      return record;
    });
  }
  async find(jobId) {
    requireId(jobId);
    for (const key of await this.keys()) {
      const intent = await this.read(key);
      if (intent.jobId === jobId) return intent;
    }
    throw new PreviewError('unknown_intent', 'No retained intent for this job ID. Do not invent a replacement ID.');
  }
  async list() {
    const result = [];
    for (const key of await this.keys()) {
      const intent = await this.read(key);
      result.push({ jobId: intent.jobId, target: intent.target, digest: intent.digest, claimed: await this.claimed(intent) });
    }
    return result;
  }
  async discardUnsubmitted(jobId) {
    await this.prepare();
    return withStoreLock(this.directory, async () => {
      const intent = await this.find(jobId);
      if (await this.claimed(intent)) throw new PreviewError('claimed_intent', 'A claimed intent must never be deleted or reset.');
      await unlink(this.path(intent.key, 'intent'));
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return { discarded: jobId };
    });
  }
}

export class Printing {
  constructor({ ledger = new PrintLedger(), helper = callHelper } = {}) {
    this.ledger = ledger;
    this.helper = helper;
  }
  async health() { return validHealth((await this.helper('helper_status', {})).health); }
  async discovery(method, scanId) {
    requireId(scanId);
    try {
      if (method === 'start_discovery' && (await this.health()).supports_printer_discovery !== true) {
        throw new PreviewError('helper_upgrade_required', 'Update and independently reopen the helper to use the printer picker.');
      }
      const { discovery } = await this.helper(method, { scan_id: scanId });
      if (!discovery || discovery.scan_id?.toLowerCase() !== scanId ||
          !['scanning', 'stopping', 'stopped', 'unavailable', 'permission_required', 'error'].includes(discovery.state) ||
          typeof discovery.message !== 'string' || discovery.message.length > 512 ||
          !Array.isArray(discovery.devices) || discovery.devices.length > 32) {
        throw new PreviewError('invalid_discovery', 'The helper returned an invalid discovery response.');
      }
      const seen = new Set();
      const devices = discovery.devices.map(device => {
        const id = device.id?.toLowerCase(); requireId(id);
        if (seen.has(id) || device.name !== 'Mini Pocket Printer_BLE' ||
            (device.rssi !== undefined && (!Number.isInteger(device.rssi) || device.rssi < -127 || device.rssi > 20))) {
          throw new PreviewError('invalid_discovery', 'The helper returned invalid printer details.');
        }
        seen.add(id);
        return { id, name: device.name, rssi: device.rssi ?? null };
      });
      return { scanId, state: discovery.state, devices, message: discovery.message };
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      const messages = {
        helper_not_running: 'Open Pocket Printer Helper independently, then choose Scan for printers.',
        busy: 'Finish or resolve the current print job before scanning.',
        discovery_busy: 'Another scan is running. Stop it or wait for it to finish.',
        unknown_scan: 'This scan is no longer available. Choose Scan for printers again.',
        ipc_timeout: 'The helper did not answer. A scan may still be running for up to 10 seconds; use Stop scan.',
        unsafe_socket: 'The helper connection has unsafe permissions. Inspect the helper setup before continuing.'
      };
      throw new PreviewError('discovery_failed', messages[error.code] ?? 'Printer discovery failed. Check the helper and Bluetooth permissions, then scan again.');
    }
  }
  async assertSettled() {
    for (const key of await this.ledger.keys()) {
      const previous = await this.ledger.read(key);
      if (!await this.ledger.claimed(previous)) continue;
      if (await this.ledger.rejected(previous)) continue;
      let receipt;
      try { receipt = validReceipt((await this.helper('job_status', { job_id: previous.jobId })).receipt, previous); }
      catch { throw new PreviewError('unresolved_dispatch', 'A previous dispatch has no verifiable receipt. No new job or retry; inspect the original job.'); }
      if (!terminal(receipt)) throw new PreviewError('unresolved_dispatch', 'A previous job is active or uncertain. Use the helper for native recovery.');
    }
  }
  async inspect({ original, target, revision, current }) {
    requireId(target);
    const metadata = inspectPng(original);
    const health = await this.health();
    const result = await this.helper('inspect_png', { png_base64: original.toString('base64') });
    const preview = pngBytes(result.preview_png_base64);
    if (result.image?.sha256 !== digest(original) || result.image.width !== 384 ||
        result.image.height !== metadata.height || result.image.png_bytes !== original.length ||
        result.image.clearance_dots !== 80 || inspectPng(preview).height !== metadata.height) {
      throw new PreviewError('invalid_helper_preview', 'Helper preview metadata does not match the original PNG.');
    }
    current();
    if (health.supports_expected_confirmation_mode !== true) {
      throw new PreviewError('helper_upgrade_required', 'This helper can inspect images but needs the confirmation-mode guard update before canvas printing. Update and independently reopen it after approval.');
    }
    const intent = await this.ledger.create({ original, preview, target, revision, mode: health.confirmation_mode }, async () => {
      await this.assertSettled(); current();
    });
    current();
    // Reinspection must agree with the retained bitmap; do not silently approve changed rasterization.
    if (intent.bitmapDigest !== digest(preview)) throw new PreviewError('bitmap_changed', 'The helper bitmap changed for this original image. Inspect retained intent; no automatic replacement job.');
    return { intent, health, claimed: await this.ledger.claimed(intent) };
  }
  async status(jobId) {
    const intent = await this.ledger.find(jobId);
    if (!await this.ledger.claimed(intent)) return { jobId, state: 'not_dispatched', paperConfirmed: false };
    const rejected = await this.ledger.rejected(intent);
    if (rejected) return { jobId, state: 'rejected_before_admission', paperConfirmed: false,
      message: `The helper explicitly rejected this job before admission (${rejected.code}). This ID will not be retried.` };
    try {
      const receipt = validReceipt((await this.helper('job_status', { job_id: jobId })).receipt, intent);
      return { jobId, state: receipt.state, paperConfirmed: receipt.paper_confirmed,
        outcomeAcknowledged: receipt.outcome_acknowledged === true, mode: receipt.confirmation_mode,
        message: receipt.message };
    } catch (error) {
      return { jobId, state: 'uncertain', paperConfirmed: false,
        message: 'A dispatch claim exists but its receipt cannot be verified. No retry or replacement ID.',
        error: error.code ?? 'receipt_unavailable' };
    }
  }
  async dispatch(intent, current) {
    await this.ledger.prepare();
    return withStoreLock(this.ledger.directory, async () => {
      intent = await this.ledger.read(intent.key);
      if (await this.ledger.claimed(intent)) return this.status(intent.jobId);
      // Unknown claims block new IDs too, even if a lost request never reached the helper.
      await this.assertSettled();
      const health = await this.health();
      if (health.supports_expected_confirmation_mode !== true || health.confirmation_mode !== intent.mode ||
          health.confirmation_preference_error || health.safety_blocked || health.active_job_id ||
          health.discovery_active || health.bluetooth !== 'ready') {
        throw new PreviewError('helper_not_ready', 'Helper state or confirmation mode changed. Inspect again; no job was dispatched.');
      }
      current();
      await writeRecord(this.ledger.path(intent.key, 'claim'),
        { jobId: intent.jobId, digest: intent.digest, target: intent.target }, { exclusive: true });
      // The synced claim is the admission boundary. Close/restart must never replay it.
      try {
        const result = await this.helper('submit_png', { job_id: intent.jobId, device_id: intent.target,
          png_base64: intent.original, paper_approved: true, expected_confirmation_mode: intent.mode });
        const receipt = validReceipt(result.receipt, intent);
        return { jobId: intent.jobId, state: receipt.state, paperConfirmed: receipt.paper_confirmed,
          mode: receipt.confirmation_mode, message: receipt.message };
      } catch (error) {
        if (error.helperReported === true && noAdmissionCodes.has(error.code)) {
          await writeRecord(this.ledger.path(intent.key, 'rejected'),
            { jobId: intent.jobId, digest: intent.digest, target: intent.target, code: error.code }, { exclusive: true });
          return this.status(intent.jobId);
        }
        return { jobId: intent.jobId, state: 'uncertain', paperConfirmed: false,
          message: 'Dispatch was claimed but submission could not be verified. Query this same job; do not retry.',
          error: error.code ?? 'submission_unavailable' };
      }
    });
  }
}
