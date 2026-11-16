import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, readdir, unlink, link } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PreviewError } from './png.mjs';
import { validateDraft, objectKeys } from './draft.mjs';

export const storeRoot = join(homedir(), 'Library', 'Application Support', 'Copilot Pocket Printer Canvas');
export const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function requireId(id) {
  if (typeof id !== 'string' || !uuidPattern.test(id)) throw new PreviewError('invalid_id', 'Expected a lowercase UUID.');
}
export async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new PreviewError('unsafe_storage', 'Private storage must be an owned 0700 directory, not a symlink.');
  }
}
export async function readRecord(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > limit) {
      throw new PreviewError('unsafe_storage', 'Stored record has unsafe permissions, type or size.');
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new PreviewError('unsafe_storage', 'Stored record is oversized.');
    try { return JSON.parse(buffer.subarray(0, length).toString('utf8')); }
    catch { throw new PreviewError('invalid_storage', 'Stored record is corrupt. No automatic recovery or replay.'); }
  } finally { await file.close(); }
}
export async function writeRecord(path, value, { exclusive = false } = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let published = false;
  try {
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    // link publishes an already-synced complete record without replacing an existing claim.
    if (exclusive) { await link(temporary, path); await unlink(temporary); }
    else await rename(temporary, path);
    published = true;
    const directory = await open(join(path, '..'), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (!published) {
      try { await unlink(temporary); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
export async function withStoreLock(root, operation) {
  await privateDirectory(root);
  const path = join(root, '.lock');
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new PreviewError('storage_locked', 'Storage is busy or was interrupted. No automatic lock recovery; inspect before continuing.');
    throw error;
  }
  try { return await operation(); }
  finally { await file.close(); await unlink(path); }
}

export function draftStore(root = storeRoot) {
  const directory = join(root, 'drafts');
  async function prepare() { await privateDirectory(root); await privateDirectory(directory); }
  async function load(id) {
    requireId(id); await prepare();
    const record = await readRecord(join(directory, `${id}.json`), 64 * 1024);
    objectKeys(record, ['id', 'revision', 'draft']);
    if (record.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 1) {
      throw new PreviewError('invalid_storage', 'Stored draft identity is invalid.');
    }
    return { ...record, draft: validateDraft(record.draft) };
  }
  return {
    load,
    async list() {
      await prepare();
      const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
      if (names.length > 20) throw new PreviewError('storage_limit', 'Draft storage exceeds its 20-draft limit.');
      return Promise.all(names.map(async name => {
        const record = await load(name.slice(0, -5));
        return { id: record.id, revision: record.revision, title: record.draft.title };
      }));
    },
    async save({ id, revision, draft }) {
      const value = validateDraft(draft);
      await prepare();
      return withStoreLock(directory, async () => {
        if (id !== null) {
          const previous = await load(id);
          if (revision !== previous.revision) throw new PreviewError('draft_conflict', 'This saved draft changed in another panel. Open it again or save a copy.');
        } else {
          if (revision !== null) throw new PreviewError('invalid_request', 'A new draft has no saved revision.');
          if ((await readdir(directory)).filter(name => name.endsWith('.json')).length >= 20) {
            throw new PreviewError('storage_limit', 'The 20-draft limit is reached. Update an existing draft instead.');
          }
          id = randomUUID();
        }
        const record = { id, revision: (revision ?? 0) + 1, draft: value };
        await writeRecord(join(directory, `${id}.json`), record);
        return record;
      });
    }
  };
}
