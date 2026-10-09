// ไคลเอนต์ Supabase แบบเบา (ไม่ใช้ไลบรารีภายนอก จึงไม่ต้องเปิดสิทธิ์ CDN ใน CSP)
// - เข้าสู่ระบบด้วยอีเมล/รหัสผ่าน (Supabase Auth) และต่ออายุโทเค็นอัตโนมัติ
// - SupabaseStore แปลงคำสั่ง cloudList/cloudGet/cloudSave/cloudDelete เป็นการเรียกฐานข้อมูล
//   โดยคืนรูปแบบผลลัพธ์เดียวกับ Code.gs เดิม ทำให้ตรรกะซิงก์ใน cloud.js ใช้ต่อได้ทั้งหมด
const SESSION_KEY = 'mn_sb';
export const CLOUD_MESSAGES = {
  CLOUD_CONFLICT: 'ข้อมูลบนอีกเครื่องเปลี่ยนแล้ว ต้องเลือกรุ่นที่จะใช้ก่อนซิงก์',
  CLOUD_NOT_FOUND: 'ไม่พบข้อมูลประชุมบนคลาวด์',
  CLOUD_DELETED: 'รายการนี้ถูกลบจากคลาวด์แล้ว',
  CLOUD_LIMIT: 'ข้อมูลซิงก์เกินขนาดที่รองรับ',
  IDEMPOTENCY: 'รหัสคำขอถูกใช้กับข้อมูลอื่น กรุณาเริ่มคำขอใหม่',
  INPUT: 'รูปแบบข้อมูลไม่ถูกต้องหรือเกินขนาด',
  SUPABASE_AUTH: 'เข้าสู่ระบบ Supabase ไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่'
};
export function validateSupabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Supabase Project URL ไม่ถูกต้อง');
  }
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9]{10,40}\.supabase\.co$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  )
    throw new Error('ใช้ Project URL รูปแบบ https://xxxxxxxx.supabase.co เท่านั้น');
  return url.origin;
}
export const validateSupabaseKey = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{20,600}$/.test(value))
    throw new Error('anon key ของ Supabase ไม่ถูกต้อง');
  return value;
};
const fail = (message, code, status) => Object.assign(new Error(message), { code, status });

export class SupabaseClient {
  constructor(storage = globalThis.localStorage, fetchFn = (...a) => globalThis.fetch(...a)) {
    this.storage = storage;
    this.fetch = fetchFn;
    this.url = '';
    this.key = '';
    this.session = null;
    this.refreshing = null;
    this.load();
  }
  configure(url, key) {
    const nextUrl = validateSupabaseUrl(url),
      nextKey = validateSupabaseKey(key);
    if (this.url && this.url !== nextUrl) this.clear(); // เปลี่ยนโปรเจกต์ = ต้องล็อกอินใหม่
    this.url = nextUrl;
    this.key = nextKey;
    if (this.session && this.session.url !== nextUrl) this.clear();
  }
  load() {
    try {
      const s = JSON.parse(this.storage?.getItem(SESSION_KEY) || 'null');
      if (
        s &&
        typeof s.refresh_token === 'string' &&
        typeof s.access_token === 'string' &&
        Number.isFinite(s.expires_at)
      )
        this.session = {
          url: String(s.url || ''),
          access_token: s.access_token,
          refresh_token: s.refresh_token,
          expires_at: s.expires_at,
          email: String(s.email || '')
        };
    } catch {
      this.session = null;
    }
  }
  store(session) {
    this.session = session;
    try {
      if (session) this.storage?.setItem(SESSION_KEY, JSON.stringify(session));
      else this.storage?.removeItem(SESSION_KEY);
    } catch {
      /* ใช้ต่อได้ในแท็บนี้ แต่ต้องล็อกอินใหม่เมื่อเปิดหน้าใหม่ */
    }
  }
  clear() {
    this.store(null);
  }
  signedIn() {
    return !!this.session && !!this.url && this.session.url === this.url;
  }
  email() {
    return this.session?.email || '';
  }
  async http(path, { method = 'GET', body, token, headers = {} } = {}) {
    if (!this.url || !this.key) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await this.fetch(this.url + path, {
        method,
        headers: {
          apikey: this.key,
          Authorization: 'Bearer ' + (token || this.key),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        const raw = String(data?.message || data?.msg || data?.error_description || data?.error || '');
        const code = /^[A-Z_]{4,40}$/.test(raw) ? raw : undefined;
        throw fail(
          CLOUD_MESSAGES[code] ||
            (response.status === 400 && /invalid login/i.test(raw)
              ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
              : raw.length && raw.length < 200
                ? raw
                : `Supabase ตอบกลับผิดพลาด (HTTP ${response.status})`),
          code,
          response.status
        );
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Supabase ไม่ตอบภายใน 30 วินาที');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  accept(data) {
    if (
      !data ||
      typeof data.access_token !== 'string' ||
      typeof data.refresh_token !== 'string' ||
      !Number.isFinite(data.expires_in)
    )
      throw new Error('Supabase ส่งข้อมูลเข้าสู่ระบบไม่ครบ');
    this.store({
      url: this.url,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
      email: String(data.user?.email || this.session?.email || '')
    });
  }
  async signIn(email, password) {
    this.accept(
      await this.http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } })
    );
  }
  async signUp(email, password) {
    const data = await this.http('/auth/v1/signup', { method: 'POST', body: { email, password } });
    if (data?.access_token) {
      this.accept(data);
      return { needsConfirm: false };
    }
    return { needsConfirm: true };
  }
  async signOut() {
    const token = this.session?.access_token;
    this.clear();
    if (token)
      try {
        await this.http('/auth/v1/logout', { method: 'POST', token });
      } catch {
        /* ออกจากระบบในเครื่องแล้ว */
      }
  }
  async getAccessToken() {
    if (!this.signedIn()) throw new Error('ยังไม่ได้เข้าสู่ระบบ');
    if (this.session.expires_at - Date.now() / 1000 > 60) return this.session.access_token;
    if (!this.refreshing)
      this.refreshing = this.http('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: this.session.refresh_token }
      })
        .then((data) => this.accept(data))
        .catch((error) => {
          if (error.status === 400 || error.status === 401) this.clear();
          throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
        })
        .finally(() => {
          this.refreshing = null;
        });
    await this.refreshing;
    return this.session.access_token;
  }
  async rpc(name, args) {
    return this.http('/rest/v1/rpc/' + name, { method: 'POST', body: args, token: await this.getAccessToken() });
  }
  async select(table, query) {
    return this.http(`/rest/v1/${table}?${query}`, { token: await this.getAccessToken() });
  }
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const id = (v) => {
  if (typeof v !== 'string' || !ID.test(v)) throw new Error(CLOUD_MESSAGES.INPUT);
  return v;
};
export class SupabaseStore {
  constructor(client) {
    this.sb = client;
  }
  async handle(p) {
    switch (p.action) {
      case 'cloudList': {
        const after = p.after ? `&id=gt.${encodeURIComponent(id(p.after))}` : '';
        const rows = await this.sb.select(
          'meetings',
          `select=id,version,deleted,title,updated_at&order=id.asc&limit=21${after}`
        );
        if (!Array.isArray(rows)) throw new Error('รายการคลาวด์ผิดรูปแบบ');
        const page = rows.slice(0, 20);
        return {
          ok: true,
          items: page.map((r) => ({
            id: r.id,
            version: r.version,
            deleted: r.deleted === true,
            title: typeof r.title === 'string' ? r.title : '',
            updatedAt: r.updated_at
          })),
          next: rows.length > 20 ? page[page.length - 1].id : null
        };
      }
      case 'cloudGet': {
        const rows = await this.sb.select(
          'meetings',
          `select=id,version,deleted,meeting,audio,updated_at&id=eq.${encodeURIComponent(id(p.id))}&limit=1`
        );
        const r = Array.isArray(rows) ? rows[0] : null;
        if (!r) throw fail(CLOUD_MESSAGES.CLOUD_NOT_FOUND, 'CLOUD_NOT_FOUND');
        if (r.deleted === true) return { ok: true, id: r.id, version: r.version, deleted: true };
        return {
          ok: true,
          id: r.id,
          version: r.version,
          deleted: false,
          meeting: r.meeting,
          audio: r.audio,
          updatedAt: r.updated_at,
          docUrl: null,
          docStatus: null,
          docError: null,
          docVersion: r.version
        };
      }
      case 'cloudSave': {
        const r = await this.sb.rpc('meetnote_save', {
          p_id: id(p.id),
          p_version: p.version,
          p_operation: id(p.operation),
          p_meeting: p.meeting,
          p_audio: p.audio
        });
        if (!r || r.ok !== true || !Number.isSafeInteger(r.version)) throw new Error('คลาวด์ตอบกลับผิดรูปแบบ');
        return { ...r, docUrl: null, docStatus: null, docError: null, docVersion: r.version };
      }
      case 'cloudDelete': {
        const r = await this.sb.rpc('meetnote_delete', {
          p_id: id(p.id),
          p_version: p.version,
          p_operation: id(p.operation)
        });
        if (!r || r.ok !== true) throw new Error('คลาวด์ตอบกลับผิดรูปแบบ');
        return r;
      }
      case 'cloudReport': // โหมด Supabase ไม่สร้าง Docs อัตโนมัติ ใช้ปุ่มสร้างรายงานเองแทน
        return { ok: true, version: p.version, docUrl: null, docStatus: null, docError: null, docVersion: p.version };
      default:
        throw new Error('ไม่รองรับคำสั่งนี้');
    }
  }
}
export const STORE_ACTIONS = new Set(['cloudList', 'cloudGet', 'cloudSave', 'cloudDelete', 'cloudReport']);
