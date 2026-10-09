// ค่าเริ่มต้นของระบบ — เจ้าของแก้ไฟล์นี้ "ครั้งเดียว" แล้วทุกเครื่องที่เปิดเว็บไม่ต้องกรอกเอง
// ค่าทั้ง 3 ตัวนี้เปิดเผยได้ (ไม่ใช่ความลับ) เพราะสิทธิ์จริงถูกป้องกันด้วยการเข้าสู่ระบบ + RLS ใน Supabase
// ห้ามใส่ Gemini API key, service_role key หรือรหัสผ่านใด ๆ ลงในไฟล์นี้
export const DEFAULTS = Object.freeze({
  // Supabase > Project Settings > API > Project URL (ลงท้าย .supabase.co)
  sbUrl: '',
  // Supabase > Project Settings > API > anon public key (หรือ Publishable key)
  sbKey: '',
  // Apps Script > Deploy > Web app URL (ลงท้าย /exec)
  gasUrl: ''
});
