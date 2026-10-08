// Keep the original database and stores so existing meetings remain readable.
export const DB = {
  db: null,
  opening: null,
  async init() {
    if (this.db) return;
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const req = indexedDB.open('meetnote_v2', 1);
      req.onupgradeneeded = () => {
        for (const name of ['meetings', 'audio']) {
          if (!req.result.objectStoreNames.contains(name)) {
            req.result.createObjectStore(name, name === 'meetings' ? { keyPath: 'id' } : undefined);
          }
        }
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('โปรดปิดแท็บ MeetNote อื่น แล้วเปิดใหม่'));
      req.onsuccess = () => {
        this.db = req.result;
        this.db.onversionchange = () => {
          this.db.close();
          this.db = null;
          this.opening = null;
        };
        resolve();
      };
    });
    try {
      await this.opening;
    } catch (error) {
      this.opening = null;
      throw error;
    }
  },
  async transaction(stores, mode, operation) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('ไม่สามารถบันทึกข้อมูลได้'));
      tx.onerror = () => {}; // onabort carries the final transaction outcome.
      try {
        operation(tx, (value) => {
          result = value;
        });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  },
  saveMeeting(meeting) {
    const snapshot = structuredClone(meeting);
    return this.transaction(['meetings'], 'readwrite', (tx) =>
      tx.objectStore('meetings').put(snapshot)
    );
  },
  getAllMeetings() {
    return this.transaction(['meetings'], 'readonly', (tx, done) => {
      tx.objectStore('meetings').getAll().onsuccess = (e) =>
        done(
          e.target.result.sort(
            (a, b) => Date.parse(b.updatedAt || b.date) - Date.parse(a.updatedAt || a.date)
          )
        );
    });
  },
  getMeeting(id) {
    return this.transaction(['meetings'], 'readonly', (tx, done) => {
      tx.objectStore('meetings').get(id).onsuccess = (e) => done(e.target.result);
    });
  },
  deleteMeeting(id) {
    return this.transaction(['meetings', 'audio'], 'readwrite', (tx) => {
      tx.objectStore('meetings').delete(id);
      tx.objectStore('audio').delete(IDBKeyRange.bound(id + ':', id + ':\uffff'));
    });
  },
  saveAudio(key, blob) {
    return this.transaction(['audio'], 'readwrite', (tx) => tx.objectStore('audio').put(blob, key));
  },
  getAudio(key) {
    return this.transaction(['audio'], 'readonly', (tx, done) => {
      tx.objectStore('audio').get(key).onsuccess = (e) => done(e.target.result);
    });
  },
  audioEntries(prefix) {
    return this.transaction(['audio'], 'readonly', (tx, done) => {
      const entries = [];
      const req = tx.objectStore('audio').openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return done(entries);
        entries.push({ key: cursor.key, blob: cursor.value });
        cursor.continue();
      };
    });
  },
  async getPart(id, part, recovery = []) {
    const old = await this.getAudio(`${id}:full${part}`);
    const prefix = `${id}:chunk:${part}:`;
    const entries = await this.audioEntries(prefix);
    const chunks = new Map(entries.map((e) => [Number(e.key.slice(prefix.length)), e.blob]));
    for (const e of recovery) chunks.set(e.seq, e.blob);
    if (!chunks.size) return old || null;
    const ordered = [...chunks.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    return new Blob(ordered, { type: ordered[0].type || 'audio/webm' });
  },
  deleteAudioPrefix(prefix) {
    return this.transaction(['audio'], 'readwrite', (tx) =>
      tx.objectStore('audio').delete(IDBKeyRange.bound(prefix, prefix + '\uffff'))
    );
  }
};
