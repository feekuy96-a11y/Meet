// เข้าสู่ระบบอัตโนมัติด้วย "ลิงก์ส่วนตัว" (เหมาะกับใช้คนเดียว): เปิดลิงก์ครั้งแรกบนเครื่องใหม่ครั้งเดียว
// แล้วเครื่องนั้นจำการเข้าสู่ระบบไว้ ไม่ต้องพิมพ์รหัสผ่านอีก
// ข้อมูลอยู่หลังเครื่องหมาย # ของลิงก์ ซึ่งเบราว์เซอร์ไม่ส่งไปที่เซิร์ฟเวอร์ใด (GitHub ก็ไม่เห็น)
// และแอพลบส่วนนี้ออกจากแถบที่อยู่ทันทีหลังอ่าน
const PREFIX = 'login=';
const b64url = (text) =>
  btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (value) =>
  decodeURIComponent(escape(atob(value.replace(/-/g, '+').replace(/_/g, '/'))));
export const validEmail = (email) => /^[^\s@]{1,64}@[^\s@]{1,200}$/.test(email);
export const validPassword = (password) => password.length >= 8 && password.length <= 200;
export function encodeLogin(email, password) {
  if (!validEmail(email) || !validPassword(password)) throw new Error('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  return PREFIX + b64url(JSON.stringify({ e: email, p: password }));
}
// คืน {email,password} หรือ null ถ้าไม่ใช่ลิงก์เข้าสู่ระบบ/ข้อมูลเสีย
export function decodeLogin(hash) {
  const text = String(hash || '').replace(/^#/, '');
  if (!text.startsWith(PREFIX) || text.length > 1000) return null;
  try {
    const data = JSON.parse(fromB64url(text.slice(PREFIX.length)));
    return typeof data?.e === 'string' &&
      typeof data?.p === 'string' &&
      validEmail(data.e) &&
      validPassword(data.p)
      ? { email: data.e, password: data.p }
      : null;
  } catch {
    return null;
  }
}
