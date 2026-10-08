import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const source = fs.readFileSync(new URL('../../Code.gs', import.meta.url), 'utf8');
const summary = {
  overview: 'ภาพรวม',
  exec: ['ข้อสรุป'],
  topics: [{ title: 'เรื่อง', detail: 'รายละเอียด' }],
  decisions: ['มติ'],
  actions: [{ owner: 'คน', task: 'งาน', due: 'ไม่ระบุ' }],
  followups: ['ติดตาม'],
  speakers: [{ name: 'คน', points: ['ประเด็น'] }]
};
export function backend() {
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
  function iterator(items) {
    let i = 0;
    return { hasNext: () => i < items.length, next: () => items[i++] };
  }
  const folders = new Map();
  function makeFolder(name, id = 'folder' + ++counter) {
    const children = [],
      members = [];
    const folder = {
      getId: () => id,
      getName: () => name,
      createFolder: (name) => {
        const child = makeFolder(name);
        children.push(child);
        return child;
      },
      getFolders: () => iterator(children),
      getFoldersByName: (name) => iterator(children.filter((f) => f.getName() === name)),
      getFilesByName: (name) => iterator(members.filter((f) => !f.trashed && f.getName() === name)),
      createFile: (blob, content, mime) => {
        if (typeof blob === 'string') blob = { name: blob, data: content, mime };
        const fid = 'file' + ++counter;
        let data = typeof blob.data === 'string' ? Buffer.from(blob.data) : Buffer.from(blob.data);
        const f = {
          getId: () => fid,
          getName: () => blob.name,
          getSize: () => data.length,
          getUrl: () => `https://drive.google.com/file/d/${fid}/view`,
          getBlob: () => ({
            getBytes: () => [...data],
            getDataAsString: () => data.toString('utf8')
          }),
          setContent: (value) => {
            data = Buffer.from(value);
          },
          setTrashed: () => {
            f.trashed = true;
          },
          moveTo: () => {}
        };
        files.set(fid, f);
        members.push(f);
        return f;
      }
    };
    folders.set(id, folder);
    return folder;
  }
  const folder = makeFolder('MeetNote', 'folder');
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
      computeDigest: (a, s) => [
        ...crypto
          .createHash('sha256')
          .update(typeof s === 'string' ? s : Buffer.from(s))
          .digest()
      ],
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      newBlob: (data, mime, name) => ({ data, mime, name })
    },
    DriveApp: {
      createFolder: () => folder,
      getFolderById: (id) => {
        if (!folders.has(id)) throw new Error('missing folder');
        return folders.get(id);
      },
      getFileById: (id) => file(id)
    },
    DocumentApp: {
      openById: (id) => {
        const found = docs.find((d) => d.doc.getId() === id);
        if (!found) throw new Error('missing doc');
        return found.doc;
      },
      ParagraphHeading: { HEADING1: 'h1', HEADING2: 'h2' },
      create: (title) => {
        const id = 'doc' + ++counter,
          lines = [],
          body = {
            clear: () => {
              lines.length = 0;
            },
            appendParagraph: (t) => {
              lines.push(t);
              return { setHeading: () => {} };
            },
            appendListItem: (t) => lines.push(t)
          };
        const parents = [];
        const f = {
          getId: () => id,
          getParents: () => iterator(parents),
          getUrl: () => `https://docs.google.com/document/d/${id}/edit`,
          moveTo: () => {
            if (failMove) throw new Error('fail');
            parents.splice(0, parents.length, folder);
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
    folders,
    docs,
    calls,
    setFailMove: () => {
      failMove = true;
    },
    post: (p) => ctx.doPost({ postData: { contents: JSON.stringify(p) } })
  };
}
