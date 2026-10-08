import { API } from './api.js';
import { DB } from './db.js';
import { validateMeeting, validateAudioManifest, uid } from './model.js';
export const BLOCK_BYTES = 1024 * 1024;
export async function digestBlob(blob) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function fromBase64(data) {
  if (
    typeof data !== 'string' ||
    data.length > Math.ceil(BLOCK_BYTES / 3) * 4 ||
    data.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    throw new Error('เสียงที่ดาวน์โหลดผิดรูปแบบ');
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
export function cloudReady(cfg) {
  return !!cfg.gasUrl && !!cfg.gasToken && cfg.cloudSync === true;
}
function wireMeeting(m) {
  const clean = validateMeeting(m);
  delete clean.cloud;
  delete clean.cloudDirty;
  delete clean.cloudMutation;
  delete clean.docRequest;
  delete clean.cloudDeleteOperation;
  delete clean.updatedAt;
  delete clean.revision;
  clean.recording = false;
  return clean;
}
export class CloudSync {
  constructor(cfg, status = () => {}) {
    this.cfg = cfg;
    this.status = status;
    this.running = false;
  }
  call(payload) {
    return API.callGAS(this.cfg(), payload);
  }
  async list() {
    let after = '',
      items = [];
    const seen = new Set();
    do {
      const result = await this.call({ action: 'cloudList', after });
      if (!Array.isArray(result.items) || result.items.length > 20)
        throw new Error('รายการคลาวด์ผิดรูปแบบ');
      for (const item of result.items) {
        if (
          !item ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) ||
          !Number.isSafeInteger(item.version) ||
          item.version < 1 ||
          seen.has(item.id)
        )
          throw new Error('รายการคลาวด์ผิดรูปแบบ');
        seen.add(item.id);
        items.push(item);
      }
      if (result.next !== null && (typeof result.next !== 'string' || result.next <= after))
        throw new Error('หน้ารายการคลาวด์ผิดรูปแบบ');
      after = result.next;
      if (items.length > 2000) throw new Error('ประชุมบนคลาวด์เกิน 2000 รายการ');
    } while (after);
    return items;
  }
  async get(id) {
    const result = await this.call({ action: 'cloudGet', id });
    if (result.id !== id || !Number.isSafeInteger(result.version) || result.version < 1)
      throw new Error('ข้อมูลคลาวด์ผิดรูปแบบ');
    if (result.deleted === true) return { id, version: result.version, deleted: true };
    const meeting = validateMeeting(result.meeting),
      audio = validateAudioManifest(result.audio, meeting.part);
    if (meeting.id !== id) throw new Error('รหัสประชุมบนคลาวด์ไม่ตรง');
    meeting.recording = false;
    meeting.cloudDirty = false;
    meeting.cloudMutation = null;
    meeting.cloud = {
      source: this.cfg().gasUrl,
      version: result.version,
      audio,
      docUrl: result.docUrl || null,
      docStatus: result.docStatus || null,
      docError: result.docError || null
    };
    return { meeting, version: result.version, deleted: false };
  }
  async pull(id) {
    const remote = await this.get(id);
    if (remote.deleted)
      throw Object.assign(new Error('รายการถูกลบจากคลาวด์แล้ว'), { code: 'CLOUD_DELETED' });
    await DB.replaceFromCloud(remote.meeting);
    return remote.meeting;
  }
  async audioPart(target, part) {
    const existing = await DB.getPart(target.id, part);
    if (existing) return existing;
    const cloud = target.cloud;
    if (!cloud || cloud.source !== this.cfg().gasUrl)
      throw new Error('ต้องเชื่อมต่อคลาวด์ต้นทางเพื่อโหลดเสียง');
    const manifest = cloud.audio.find((p) => p.part === part);
    if (!manifest) return null;
    const buffers = [];
    let size = 0;
    for (let i = 0; i < manifest.blocks.length; i++) {
      this.status(`กำลังโหลดเสียงช่วง ${part} (${i + 1}/${manifest.blocks.length})`);
      const hash = manifest.blocks[i],
        result = await this.call({
          action: 'cloudGetBlock',
          id: target.id,
          version: cloud.version,
          hash
        });
      const bytes = fromBase64(result.data),
        expected = Math.min(BLOCK_BYTES, manifest.size - i * BLOCK_BYTES),
        blob = new Blob([bytes]);
      if (bytes.length !== expected || (await digestBlob(blob)) !== hash)
        throw new Error('checksum เสียงไม่ตรง ไม่ใช้ไฟล์ที่ดาวน์โหลด');
      buffers.push(bytes);
      size += bytes.length;
    }
    if (size !== manifest.size) throw new Error('ไฟล์เสียงดาวน์โหลดไม่ครบ');
    const blob = new Blob(buffers, { type: manifest.mime });
    await DB.cacheRemotePart(target.id, cloud.source, cloud.version, part, blob);
    return blob;
  }
  async upload(target) {
    const source = this.cfg().gasUrl;
    if (target.recording) throw new Error('ต้องจบการบันทึกก่อนส่งเสียงขึ้นคลาวด์');
    if (target.cloud && target.cloud.source !== source)
      throw new Error('ข้อมูลนี้ผูกกับคลาวด์อื่น โปรดสำรอง/นำเข้าเป็นรายการใหม่ก่อนเปลี่ยนปลายทาง');
    const previous = target.cloud?.audio || [],
      audio = [];
    const entries = await DB.audioEntries(target.id + ':');
    const parts = [
      ...new Set([
        ...entries.map((e) => {
          const m = /:(?:full(\d+)|chunk:(\d+):)/.exec(e.key);
          return Number(m?.[1] || m?.[2] || 0);
        }),
        ...previous.map((p) => p.part)
      ])
    ]
      .filter((p) => p > 0)
      .sort((a, b) => a - b);
    for (const part of parts) {
      const blob = await DB.getPart(target.id, part),
        old = previous.find((p) => p.part === part);
      if (!blob) {
        if (old) audio.push(old);
        continue;
      }
      if (!blob.size) continue;
      if (blob.size > 256 * BLOCK_BYTES)
        throw new Error('เสียงหนึ่งช่วงเกิน 256 MB โปรดแบ่งการประชุม');
      const mime = blob.type.split(';')[0],
        blocks = [];
      for (let start = 0; start < blob.size; start += BLOCK_BYTES) {
        const block = blob.slice(start, start + BLOCK_BYTES),
          hash = await digestBlob(block);
        blocks.push(hash);
        // Existing committed immutable hashes need not be uploaded again.
        if (!old?.blocks.includes(hash)) {
          this.status(
            `กำลังส่งเสียงช่วง ${part} (${blocks.length}/${Math.ceil(blob.size / BLOCK_BYTES)})`
          );
          await this.call({
            action: 'cloudPutBlock',
            id: target.id,
            hash,
            data: await API.blobToBase64(block)
          });
        }
      }
      audio.push({ part, mime, size: blob.size, blocks });
    }
    validateAudioManifest(audio, target.part);
    const meeting = wireMeeting(target),
      version = target.cloud?.version || 0;
    const fingerprint = await digestBlob(
      new Blob([
        JSON.stringify({ meeting, audio, version, autoDocs: this.cfg().autoDocs === true })
      ])
    );
    let mutation = target.cloudMutation;
    if (mutation?.fingerprint !== fingerprint) mutation = { id: uid(), fingerprint };
    // Retain the operation identity before an ambiguous timeout.
    const current = await DB.getMeeting(target.id);
    if (!current) throw new Error('รายการถูกลบในเครื่องแล้ว');
    current.cloudMutation = mutation;
    await DB.saveMeeting(current);
    const result = await this.call({
      action: 'cloudSave',
      id: target.id,
      version,
      operation: mutation.id,
      meeting,
      audio,
      autoDocs: this.cfg().autoDocs === true
    });
    if (!Number.isSafeInteger(result.version) || result.version !== version + 1)
      throw new Error('รุ่นข้อมูลจากคลาวด์ผิดรูปแบบ');
    return {
      source,
      version: result.version,
      audio,
      docUrl: result.docUrl || null,
      docStatus: result.docStatus || null,
      docError: result.docError || null
    };
  }
  async sync() {
    if (this.running) throw new Error('กำลังซิงก์อยู่');
    if (!cloudReady(this.cfg()))
      throw new Error('ตั้งค่า URL รหัสเชื่อมต่อ และเปิดซิงก์ Drive ก่อน');
    if (navigator.onLine === false)
      throw new Error('ออฟไลน์ ข้อมูลยังอยู่ในเครื่อง ซิงก์ใหม่เมื่อออนไลน์');
    this.running = true;
    try {
      const remote = await this.list(),
        remoteById = new Map(remote.map((m) => [m.id, m]));
      const locals = await DB.getAllMeetings(),
        conflicts = [],
        documentWarnings = [];
      for (const stored of locals) {
        let m;
        try {
          m = validateMeeting(stored);
        } catch {
          conflicts.push({ id: stored.id, title: stored.title || '', reason: 'invalid' });
          continue;
        }
        const r = remoteById.get(m.id);
        if (m.recording) {
          conflicts.push({ id: m.id, title: m.title, reason: 'recording' });
          continue;
        }
        if (m.cloud && m.cloud.source !== this.cfg().gasUrl) {
          conflicts.push({ id: m.id, title: m.title, reason: 'different-source' });
          continue;
        }
        const dirty = m.cloudDirty !== false || !m.cloud;
        if (r?.deleted) {
          if (dirty) conflicts.push({ id: m.id, title: m.title, reason: 'deleted' });
          else await DB.deleteMeeting(m.id);
          continue;
        }
        if (r && m.cloud?.version !== r.version) {
          if (dirty) {
            if (m.cloudMutation) {
              try {
                const cloud = await this.upload(m);
                m.cloud = cloud;
                if (cloud.docError) documentWarnings.push({ id: m.id, error: cloud.docError });
                m.cloudDirty = false;
                m.cloudMutation = null;
                await DB.saveMeeting(m);
                continue;
              } catch (error) {
                if (!['CLOUD_CONFLICT', 'CLOUD_DELETED'].includes(error.code)) throw error;
              }
            }
            conflicts.push({ id: m.id, title: m.title, reason: 'changed' });
            continue;
          }
          await this.pull(m.id);
          continue;
        }
        if (!r && m.cloud) {
          conflicts.push({ id: m.id, title: m.title, reason: 'missing' });
          continue;
        }
        if (!dirty && this.cfg().autoDocs && m.cloud.docVersion < m.cloud.version) {
          try {
            const report = await this.call({
              action: 'cloudReport',
              id: m.id,
              version: m.cloud.version
            });
            m.cloud.docUrl = report.docUrl || null;
            m.cloud.docStatus = report.docStatus || null;
            m.cloud.docError = report.docError || null;
            m.cloud.docVersion = report.docVersion || 0;
            if (report.docError) documentWarnings.push({ id: m.id, error: report.docError });
            await DB.saveMeeting(m);
          } catch (error) {
            if (error.code === 'CLOUD_CONFLICT')
              conflicts.push({ id: m.id, title: m.title, reason: 'changed' });
            else throw error;
          }
        }
        if (dirty) {
          this.status('กำลังซิงก์ ' + (m.title || 'ไม่มีชื่อ'));
          try {
            const cloud = await this.upload(m);
            m.cloud = cloud;
            if (cloud.docError) documentWarnings.push({ id: m.id, error: cloud.docError });
            m.cloudDirty = false;
            m.cloudMutation = null;
            await DB.saveMeeting(m);
          } catch (error) {
            if (['CLOUD_CONFLICT', 'CLOUD_DELETED'].includes(error.code))
              conflicts.push({ id: m.id, title: m.title, reason: 'changed' });
            else throw error;
          }
        }
      }
      const localIds = new Set(locals.map((m) => m.id));
      for (const r of remote)
        if (!r.deleted && !localIds.has(r.id)) {
          this.status('กำลังโหลดประชุมจากคลาวด์');
          await this.pull(r.id);
        }
      return { conflicts, documentWarnings };
    } finally {
      this.running = false;
    }
  }
  async deleteEverywhere(target) {
    if (!target.cloud || target.cloud.source !== this.cfg().gasUrl)
      throw new Error('รายการนี้ยังไม่มีข้อมูลบนคลาวด์ต้นทาง');
    const operation = target.cloudDeleteOperation || uid();
    target.cloudDeleteOperation = operation;
    await DB.saveMeeting(target);
    await this.call({
      action: 'cloudDelete',
      id: target.id,
      version: target.cloud.version,
      operation
    });
    await DB.deleteMeeting(target.id);
  }
}
