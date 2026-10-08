import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { DB } from '../js/db.js';
import { newMeeting, validateMeeting, validateSummary } from '../js/model.js';
import { API, validateEndpoint } from '../js/api.js';
import { UI } from '../js/ui.js';
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
const summary = () => ({
  overview: 'ภาพรวม',
  exec: ['สรุป'],
  topics: [{ title: 'เรื่อง', detail: 'รายละเอียด' }],
  decisions: [],
  actions: [],
  followups: [],
  speakers: []
});
test('database persists snapshots, chunk order and atomic meeting/audio deletion', async () => {
  const m = newMeeting();
  await DB.saveMeeting(m);
  m.title = 'not saved';
  assert.equal((await DB.getMeeting(m.id)).title, '');
  await DB.saveAudio(`${m.id}:chunk:1:0000000001`, new Blob(['tail'], { type: 'audio/mp4' }));
  await DB.saveAudio(`${m.id}:chunk:1:0000000000`, new Blob(['header'], { type: 'audio/mp4' }));
  const part = await DB.getPart(m.id, 1);
  assert.equal(await part.text(), 'headertail');
  assert.equal(part.type, 'audio/mp4');
  assert.equal(
    await (await DB.getPart(m.id, 1, [{ seq: 2, blob: new Blob(['recovered']) }])).text(),
    'headertailrecovered'
  );
  await DB.saveAudio(`${m.id}other:full1`, new Blob(['keep']));
  await DB.deleteMeeting(m.id);
  assert.equal(await DB.getMeeting(m.id), undefined);
  assert.deepEqual(await DB.audioEntries(m.id + ':'), []);
  assert.equal(await (await DB.getAudio(`${m.id}other:full1`)).text(), 'keep');
});
test('legacy full recordings remain readable', async () => {
  await DB.saveAudio('legacy:full1', new Blob(['legacy'], { type: 'audio/webm' }));
  assert.equal(await (await DB.getPart('legacy', 1)).text(), 'legacy');
});
test('database abort rejects rather than hanging', async () => {
  await assert.rejects(DB.transaction(['meetings'], 'readwrite', (tx) => tx.abort()));
});
test('request URLs cannot exfiltrate a password to other hosts', () => {
  assert.match(
    validateEndpoint('https://script.google.com/macros/s/abc_123/exec'),
    /script.google.com/
  );
  for (const value of [
    'http://script.google.com/macros/s/a/exec',
    'https://evil.test',
    'https://script.google.com.evil.test/macros/s/a/exec',
    'https://x:secret@script.google.com/macros/s/a/exec',
    'https://script.google.com/macros/s/a/dev',
    'https://script.google.com/macros/s/a/exec?x=1'
  ])
    assert.throws(() => validateEndpoint(value));
});
test('API uses simple text POST, omits credentials, and token cannot be overridden', async () => {
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = options;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    await API.callGAS(
      { gasUrl: 'https://script.google.com/macros/s/a/exec', gasToken: 'real' },
      { token: 'fake', action: 'summarize' }
    );
    assert.equal(JSON.parse(request.body).token, 'real');
    assert.equal(request.credentials, 'omit');
    assert.match(request.headers['Content-Type'], /^text\/plain/);
  } finally {
    globalThis.fetch = original;
  }
});
test('API rejects non-JSON, HTTP errors and backend errors', async () => {
  const original = globalThis.fetch,
    cfg = { gasUrl: 'https://script.google.com/macros/s/a/exec', gasToken: 'real' };
  try {
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(API.callGAS(cfg, {}), /403/);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => {
        throw new Error('html');
      }
    });
    await assert.rejects(API.callGAS(cfg, {}), /JSON/);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: false, error: 'denied' })
    });
    await assert.rejects(API.callGAS(cfg, {}), /denied/);
  } finally {
    globalThis.fetch = original;
  }
});
test('summary schema rejects malformed AI output', () => {
  assert.deepEqual(validateSummary(summary()), summary());
  assert.throws(() => validateSummary({ ...summary(), actions: 'wrong' }));
  assert.throws(() => validateSummary({ ...summary(), topics: [null] }));
});
test('imports get new identity, discard recording/audio counts, and reject invalid references', () => {
  const m = newMeeting();
  m.part = 3;
  m.recording = true;
  const restored = validateMeeting(m, true);
  assert.notEqual(restored.id, m.id);
  assert.equal(restored.part, 0);
  assert.equal(restored.recording, false);
  assert.throws(() =>
    validateMeeting({ ...m, segs: [{ id: '1', spk: 'missing', t: 0, text: 'x' }] })
  );
  assert.throws(() => validateMeeting({ ...m, speakers: [m.speakers[0], m.speakers[0]] }));
  assert.throws(() => validateMeeting({ ...m, dur: NaN }));
  assert.throws(() => validateMeeting({ ...m, date: 'bad' }));
});
test('escape covers markup and attribute injection; time is finite', () => {
  assert.equal(UI.escapeHtml('<img src=x onerror="x">'), '&lt;img src=x onerror=&quot;x&quot;&gt;');
  assert.equal(UI.formatTime(Infinity), '00:00');
  assert.equal(UI.formatTime(3661), '01:01:01');
});

test('API timeout aborts request, clears timer and reports ambiguous server completion', async () => {
  const originalFetch = globalThis.fetch,
    originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  let cleared = false;
  globalThis.setTimeout = (fn, ms) => {
    assert.equal(ms, 90000);
    queueMicrotask(fn);
    return 42;
  };
  globalThis.clearTimeout = (id) => {
    assert.equal(id, 42);
    cleared = true;
  };
  globalThis.fetch = async (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => reject(new DOMException('aborted', 'AbortError')),
        { once: true }
      );
    });
  try {
    await assert.rejects(
      API.callGAS({ gasUrl: 'https://script.google.com/macros/s/a/exec', gasToken: 'real' }, {}),
      /90 วินาที/
    );
    assert.equal(cleared, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
