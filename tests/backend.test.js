import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const source = fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const summary = {
  overview: 'ภาพรวม',
  exec: ['ข้อสรุป'],
  topics: [{ title: 'เรื่อง', detail: 'รายละเอียด' }],
  decisions: ['มติ'],
  actions: [{ owner: 'คน', task: 'งาน', due: 'ไม่ระบุ' }],
  followups: ['ติดตาม'],
  speakers: [{ name: 'คน', points: ['ประเด็น'] }]
};
function backend() {
  const properties = new Map([
      ['APP_TOKEN', 't'.repeat(40)],
      ['GEMINI_API_KEY', 'test-key']
    ]),
    files = new Map(),
    docs = [],
    calls = [];
  let counter = 0,
    locked = false,
    failMove = false;
  const props = {
    getProperty: (k) => properties.get(k) || null,
    setProperty: (k, v) => properties.set(k, v),
    deleteProperty: (k) => properties.delete(k),
    getProperties: () => Object.fromEntries(properties)
  };
  function file(id) {
    return files.get(id);
  }
  const folder = {
    getId: () => 'folder',
    createFile: (blob) => {
      const id = 'audio' + ++counter,
        f = {
          getId: () => id,
          getUrl: () => `https://drive.google.com/file/d/${id}/view`,
          setTrashed: () => {
            f.trashed = true;
          },
          moveTo: () => {}
        };
      files.set(id, f);
      return f;
    }
  };
  const ctx = vm.createContext({
    Date,
    JSON,
    Number,
    String,
    Array,
    Object,
    Error,
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ setMimeType: () => JSON.parse(text) })
    },
    PropertiesService: { getScriptProperties: () => props },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          locked = true;
          return true;
        },
        hasLock: () => locked,
        releaseLock: () => {
          locked = false;
        }
      })
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        calls.push({ url, options });
        return {
          getResponseCode: () => 200,
          getContentText: () =>
            JSON.stringify({
              candidates: [
                { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(summary) }] } }
              ]
            })
        };
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (a, s) => [...crypto.createHash('sha256').update(s).digest()],
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
      newBlob: (data, mime, name) => ({ data, mime, name })
    },
    DriveApp: {
      createFolder: () => folder,
      getFolderById: () => folder,
      getFileById: (id) => file(id)
    },
    DocumentApp: {
      ParagraphHeading: { HEADING1: 'h1', HEADING2: 'h2' },
      create: (title) => {
        const id = 'doc' + ++counter,
          lines = [],
          body = {
            appendParagraph: (t) => {
              lines.push(t);
              return { setHeading: () => {} };
            },
            appendListItem: (t) => lines.push(t)
          };
        const f = {
          getId: () => id,
          getUrl: () => `https://docs.google.com/document/d/${id}/edit`,
          moveTo: () => {
            if (failMove) throw new Error('fail');
          },
          setTrashed: () => {
            f.trashed = true;
          }
        };
        files.set(id, f);
        const doc = {
          getId: () => id,
          getUrl: f.getUrl,
          getBody: () => body,
          saveAndClose: () => {}
        };
        docs.push({ title, lines, doc });
        return doc;
      }
    }
  });
  vm.runInContext(source, ctx);
  return {
    ctx,
    properties,
    files,
    docs,
    calls,
    setFailMove: () => {
      failMove = true;
    },
    post: (p) => ctx.doPost({ postData: { contents: JSON.stringify(p) } })
  };
}
const request = () => ({
  token: 't'.repeat(40),
  action: 'summarize',
  title: 'ประชุม',
  date: '2026-10-07T12:00:00Z',
  transcript: 'ข้อมูล',
  audio: []
});
test('backend requires authentication and does not leak provider credentials', () => {
  const b = backend();
  assert.equal(b.post({ ...request(), token: 'wrong' }).ok, false);
  assert.equal(b.calls.length, 0);
  const result = b.post(request());
  assert.equal(result.ok, true);
  assert.equal(result.usedAudio, false);
  assert.equal(b.calls.length, 1);
  assert.match(b.calls[0].url, /gemini-2.5-flash/);
  assert.equal(b.calls[0].options.headers['x-goog-api-key'], 'test-key');
  assert.equal(JSON.stringify(result).includes('test-key'), false);
});
test('untrusted model cannot choose an endpoint and unexpected actions are rejected', () => {
  const b = backend();
  assert.equal(b.post({ ...request(), action: 'deleteEverything' }).ok, false);
  assert.equal(b.post({ ...request(), model: 'evil/endpoint' }).ok, true);
  assert.match(b.calls[0].url, /gemini-2.5-flash/);
});
test('malformed requests, MIME, base64 and schema are rejected before provider use', () => {
  const b = backend();
  for (const change of [
    { date: 'invalid' },
    { title: 'x'.repeat(201) },
    { transcript: '', audio: [] },
    { audio: [{ mime: 'text/html', data: 'YQ==' }] },
    { audio: [{ mime: 'audio/webm', data: 'bad!' }] }
  ])
    assert.equal(b.post({ ...request(), ...change }).ok, false);
  assert.equal(b.ctx.doPost({ postData: { contents: '{bad' } }).ok, false);
  assert.equal(b.calls.length, 0);
});
test('provider failure is sanitized, blocked/truncated and invalid summaries fail', () => {
  const b = backend();
  b.ctx.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 403,
    getContentText: () => 'SECRET KEY RAW BODY'
  });
  const result = b.post(request());
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  b.ctx.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () =>
      JSON.stringify({
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }]
      })
  });
  assert.equal(b.post(request()).ok, false);
});
test('both mode creates two complete docs and retries with same ID reuse them', () => {
  const b = backend(),
    p = {
      ...request(),
      action: 'createDoc',
      mode: 'both',
      requestId: 'request_123456789012345',
      summary,
      segments: [{ t: '00:01', speaker: 'คน', text: 'ข้อความ' }],
      audio: [{ mime: 'audio/mp4', data: 'YQ==' }],
      duration: '01:00'
    };
  const result = b.post(p);
  assert.equal(result.ok, true);
  assert.equal(result.urls.length, 2);
  assert.equal(b.docs.length, 2);
  for (const heading of [
    'ภาพรวม',
    'ประเด็นสำคัญ',
    'มติและข้อตกลง',
    'สิ่งที่ต้องดำเนินการ',
    'ประเด็นที่ต้องติดตาม',
    'สรุปรายบุคคล'
  ])
    assert.ok(b.docs[0].lines.includes(heading));
  assert.ok(b.docs[1].lines.some((s) => s.includes('ข้อความ')));
  assert.ok(b.docs[1].lines.some((s) => s.includes('drive.google.com')));
  assert.equal(b.post(p).reused, true);
  assert.equal(b.docs.length, 2);
  assert.equal(b.post({ ...p, title: 'changed' }).ok, false);
  assert.equal(b.docs.length, 2);
});
test('partial document failure attempts cleanup and will not duplicate retry', () => {
  const b = backend();
  b.setFailMove();
  const p = {
    ...request(),
    action: 'createDoc',
    mode: 'full',
    requestId: 'request_failed_123456',
    summary: null,
    segments: [{ t: '0', speaker: 'คน', text: 'ข้อความ' }]
  };
  assert.equal(b.post(p).ok, false);
  assert.equal([...b.files.values()][0].trashed, true);
  assert.equal(b.post(p).ok, false);
  assert.equal(b.docs.length, 1);
});
test('authenticated rate limit blocks excess billable requests', () => {
  const b = backend();
  for (let i = 0; i < 20; i++) assert.equal(b.post(request()).ok, true);
  assert.equal(b.post(request()).ok, false);
  assert.equal(b.calls.length, 20);
});
