import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import crypto from 'node:crypto';
import { backend } from './helpers/gas.mjs';
import { CloudSync, digestBlob, BLOCK_BYTES } from '../js/cloud.js';
import { DB } from '../js/db.js';
import { newMeeting, validateMeeting, validateAudioManifest } from '../js/model.js';
import { API } from '../js/api.js';
globalThis.IDBKeyRange = IDBKeyRange;
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
API.blobToBase64 = async (blob) => Buffer.from(await blob.arrayBuffer()).toString('base64');
const cfg = {
  gasUrl: 'https://script.google.com/macros/s/mock/exec',
  gasToken: 't'.repeat(40),
  cloudSync: true
};
async function device() {
  DB.db = null;
  DB.opening = null;
  globalThis.indexedDB = new IDBFactory();
  await DB.init();
  return DB.db;
}
function client(b) {
  const sync = new CloudSync(() => cfg);
  sync.call = async (p) => {
    const r = b.post({ ...p, token: cfg.gasToken });
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
    return r;
  };
  return sync;
}
function meeting() {
  const m = newMeeting();
  m.title = 'ประชุม';
  m.cloudDirty = true;
  m.segs = [{ id: 'seg1', spk: m.speakers[0].id, text: 'ข้อความแรก', t: 0, tag: '' }];
  return m;
}
const authenticated = (b, p) => b.post({ ...p, token: cfg.gasToken });
test('Drive backend publishes metadata only after all verified blocks exist, then serves only referenced blocks', async () => {
  const b = backend(),
    m = meeting();
  m.part = 1;
  const bytes = Buffer.from('audio bytes'),
    hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const audio = [{ part: 1, mime: 'audio/webm', size: bytes.length, blocks: [hash] }];
  const save = {
    action: 'cloudSave',
    id: m.id,
    version: 0,
    operation: 'operation1',
    meeting: m,
    audio
  };
  assert.equal(authenticated(b, save).code, 'CLOUD_INTEGRITY');
  assert.equal(authenticated(b, { action: 'cloudGet', id: m.id }).code, 'CLOUD_NOT_FOUND');
  assert.equal(
    authenticated(b, { action: 'cloudPutBlock', id: m.id, hash, data: bytes.toString('base64') })
      .ok,
    true
  );
  assert.equal(authenticated(b, save).version, 1);
  assert.equal(authenticated(b, save).reused, true);
  const result = authenticated(b, { action: 'cloudGetBlock', id: m.id, version: 1, hash });
  assert.equal(Buffer.from(result.data, 'base64').toString(), 'audio bytes');
  assert.equal(
    authenticated(b, { action: 'cloudGetBlock', id: m.id, version: 1, hash: 'a'.repeat(64) }).ok,
    false
  );
  assert.equal(
    authenticated(b, { action: 'cloudGetBlock', id: m.id, version: 0, hash }).code,
    'CLOUD_CONFLICT'
  );
  assert.equal(
    authenticated(b, { ...save, operation: 'other', meeting: { ...m, title: 'changed' } }).code,
    'CLOUD_CONFLICT'
  );
  assert.equal(authenticated(b, { ...save, meeting: { ...m, title: 'changed' } }).ok, false);
});
test('cloud rejects unauthenticated requests, malformed IDs and bad checksums', () => {
  const b = backend();
  assert.equal(b.post({ action: 'cloudList', token: 'bad' }).ok, false);
  assert.equal(authenticated(b, { action: 'cloudGet', id: '../../other' }).ok, false);
  assert.equal(
    authenticated(b, { action: 'cloudPutBlock', id: 'meeting', hash: 'a'.repeat(64), data: 'YQ==' })
      .code,
    'CLOUD_INTEGRITY'
  );
});
test('two devices exchange complete text and audio and refuse concurrent overwrite', async () => {
  const b = backend(),
    sync = client(b);
  const a = await device(),
    m = meeting();
  m.part = 1;
  await DB.saveMeeting(m);
  const bytes = Buffer.alloc(BLOCK_BYTES + 31, 7);
  await DB.saveAudio(m.id + ':full1', new Blob([bytes], { type: 'audio/webm' }));
  assert.equal((await sync.sync()).conflicts.length, 0);
  const uploaded = await DB.getMeeting(m.id);
  assert.equal(uploaded.cloud.version, 1);
  assert.equal(uploaded.cloudDirty, false);
  const second = await device();
  assert.equal((await sync.sync()).conflicts.length, 0);
  const received = await DB.getMeeting(m.id);
  assert.equal(received.segs[0].text, 'ข้อความแรก');
  assert.equal(await DB.getPart(m.id, 1), null);
  const remoteAudio = await sync.audioPart(received, 1);
  assert.equal(await digestBlob(remoteAudio), await digestBlob(new Blob([bytes])));
  received.segs[0].text = 'แก้จากมือถือ';
  received.cloudDirty = true;
  await DB.saveMeeting(received);
  await sync.sync();
  assert.equal((await DB.getMeeting(m.id)).cloud.version, 2);
  DB.db = a;
  await sync.sync();
  const current = await DB.getMeeting(m.id);
  assert.equal(current.segs[0].text, 'แก้จากมือถือ');
  current.segs[0].text = 'แก้จากคอม';
  current.cloudDirty = true;
  await DB.saveMeeting(current);
  DB.db = second;
  const other = await DB.getMeeting(m.id);
  other.segs[0].text = 'แก้จากมือถืออีกรอบ';
  other.cloudDirty = true;
  await DB.saveMeeting(other);
  await sync.sync();
  DB.db = a;
  const result = await sync.sync();
  assert.equal(result.conflicts[0].reason, 'changed');
  assert.equal((await DB.getMeeting(m.id)).segs[0].text, 'แก้จากคอม');
  assert.equal((await sync.get(m.id)).meeting.segs[0].text, 'แก้จากมือถืออีกรอบ');
});
test('ambiguous save timeout keeps identity and recovers without creating another version', async () => {
  const b = backend(),
    sync = client(b);
  await device();
  const m = meeting();
  await DB.saveMeeting(m);
  let once = true;
  const call = sync.call.bind(sync);
  sync.call = async (p) => {
    const result = await call(p);
    if (p.action === 'cloudSave' && once) {
      once = false;
      throw new Error('simulated response lost');
    }
    return result;
  };
  await assert.rejects(sync.sync(), /response lost/);
  const failed = await DB.getMeeting(m.id);
  assert.ok(failed.cloudMutation);
  assert.equal(failed.cloudDirty, true);
  await sync.sync();
  const recovered = await DB.getMeeting(m.id);
  assert.equal(recovered.cloud.version, 1);
  assert.equal(recovered.cloudDirty, false);
  assert.equal(recovered.cloudMutation, null);
});
test('offline edits remain local; endpoint change never uploads them to another cloud', async () => {
  const b = backend(),
    sync = client(b);
  await device();
  const m = meeting();
  await DB.saveMeeting(m);
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  await assert.rejects(sync.sync(), /ออฟไลน์/);
  assert.equal((await DB.getMeeting(m.id)).segs[0].text, 'ข้อความแรก');
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  await sync.sync();
  const saved = await DB.getMeeting(m.id);
  saved.cloud.source = 'https://script.google.com/macros/s/other/exec';
  saved.cloudDirty = true;
  await DB.saveMeeting(saved);
  const result = await sync.sync();
  assert.equal(result.conflicts[0].reason, 'different-source');
  assert.equal((await sync.get(m.id)).version, 1);
});
test('checksum mismatch is rejected before downloaded audio is cached', async () => {
  const b = backend(),
    sync = client(b);
  await device();
  const m = meeting();
  m.part = 1;
  await DB.saveMeeting(m);
  await DB.saveAudio(m.id + ':full1', new Blob(['good'], { type: 'audio/mp4' }));
  await sync.sync();
  await device();
  await sync.sync();
  const received = await DB.getMeeting(m.id),
    original = sync.call.bind(sync);
  sync.call = async (p) =>
    p.action === 'cloudGetBlock'
      ? { ok: true, data: Buffer.from('evil').toString('base64') }
      : original(p);
  await assert.rejects(sync.audioPart(received, 1), /checksum/);
  assert.equal(await DB.getPart(m.id, 1), null);
});
test('cloud deletion tombstones are idempotent and prevent resurrection; dirty other device retains a conflict', async () => {
  const b = backend(),
    sync = client(b),
    a = await device(),
    m = meeting();
  await DB.saveMeeting(m);
  await sync.sync();
  const saved = await DB.getMeeting(m.id);
  const second = await device();
  await sync.sync();
  const stale = await DB.getMeeting(m.id);
  stale.cloudDirty = true;
  stale.segs[0].text = 'ยังไม่ส่ง';
  await DB.saveMeeting(stale);
  DB.db = a;
  await sync.deleteEverywhere(saved);
  assert.equal(await DB.getMeeting(m.id), undefined);
  DB.db = second;
  assert.equal((await sync.sync()).conflicts[0].reason, 'deleted');
  assert.equal((await DB.getMeeting(m.id)).segs[0].text, 'ยังไม่ส่ง');
  assert.equal(
    authenticated(b, { action: 'cloudPutBlock', id: m.id, hash: 'a'.repeat(64), data: 'YQ==' }).ok,
    false
  );
});
test('audio manifests cannot lie about sizes, hashes or duplicate parts; new imports drop cloud bindings', () => {
  assert.throws(() =>
    validateAudioManifest([{ part: 1, mime: 'audio/webm', size: 4, blocks: [] }], 1)
  );
  assert.throws(() =>
    validateAudioManifest([{ part: 1, mime: 'audio/webm', size: 4, blocks: ['bad'] }], 1)
  );
  const m = meeting();
  m.cloud = { source: cfg.gasUrl, version: 1, audio: [] };
  m.cloudDirty = false;
  const imported = validateMeeting(m, true);
  assert.equal(imported.cloud, null);
  assert.equal(imported.cloudDirty, true);
});

test('automatic reports reuse the same document and preserve synced data on Docs failure', () => {
  const b = backend(),
    m = meeting();
  const save = {
    action: 'cloudSave',
    id: m.id,
    version: 0,
    operation: 'report1',
    meeting: m,
    audio: [],
    autoDocs: true
  };
  const first = authenticated(b, save);
  assert.equal(first.ok, true);
  assert.equal(first.docStatus, 'ready');
  assert.equal(first.docVersion, 1);
  const second = authenticated(b, {
    ...save,
    version: 1,
    operation: 'report2',
    meeting: { ...m, title: 'Updated' }
  });
  assert.equal(second.docUrl, first.docUrl);
  assert.equal(second.docVersion, 2);
  assert.equal(
    authenticated(b, { action: 'cloudReport', id: m.id, version: 1 }).code,
    'CLOUD_CONFLICT'
  );
  const failing = backend();
  failing.setFailMove();
  const result = authenticated(failing, save);
  assert.equal(result.ok, true);
  assert.equal(result.docStatus, 'error');
  assert.equal(authenticated(failing, { action: 'cloudGet', id: m.id }).version, 1);
});
