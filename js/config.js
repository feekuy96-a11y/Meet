// ค่าเริ่มต้นของระบบ — เจ้าของแก้ไฟล์นี้ "ครั้งเดียว" แล้วทุกเครื่องที่เปิดเว็บไม่ต้องกรอกเอง
// ค่าทั้ง 3 ตัวนี้เปิดเผยได้ (ไม่ใช่ความลับ) เพราะสิทธิ์จริงถูกป้องกันด้วยการเข้าสู่ระบบ + RLS ใน Supabase
// ห้ามใส่ Gemini API key, service_role key หรือรหัสผ่านใด ๆ ลงในไฟล์นี้
export const DEFAULTS = Object.freeze({
  // Supabase > Project Settings > API > Project URL (ลงท้าย .supabase.co)
  sbUrl: 'https://vosuzearptqhumueljkr.supabase.co',
  // Supabase > Project Settings > API > anon public key (หรือ Publishable key)
  sbKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvc3V6ZWFycHRxaHVtdWVsamtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDkxNDQsImV4cCI6MjEwNzA4NTE0NH0.tv5RlUs2vz4swsCYCXZHDHO8es0f71tldCAFtUTY5EU',
  // Apps Script > Deploy > Web app URL (ลงท้าย /exec)
  gasUrl: 'https://script.google.com/macros/s/AKfycbw8XH0MWXZ7o-ch7DK60dbt7kCTMwE458qlFsmHEtnhMKWF1n7w8R-aFLQUaT6OCicX/exec'
});
