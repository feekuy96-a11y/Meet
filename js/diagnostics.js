// ตรวจและจัดรูปแบบผลปุ่ม "ตรวจการเชื่อมต่อ" (แยกจาก app.js)
import { UI } from './ui.js';
export const CHECK_NAMES = {
  server: 'Apps Script และการเข้าสู่ระบบ',
  drive: 'Google Drive',
  docs: 'Google Docs',
  gemini: 'Gemini: key และโมเดล',
  generation: 'Gemini: สร้างคำตอบ'
};
export function validateDiagnostics(result) {
  if (
    !Array.isArray(result.checks) ||
    result.checks.length !== 5 ||
    Object.keys(CHECK_NAMES).some((id) => result.checks.filter((c) => c?.id === id).length !== 1) ||
    result.checks.some(
      (c) =>
        !['pass', 'fail', 'skip'].includes(c.status) ||
        typeof c.message !== 'string' ||
        c.message.length > 500
    )
  )
    throw new Error('ผลตรวจไม่ถูกต้อง โปรดอัปเดต Code.gs และ Deploy รุ่นใหม่');
  return result.checks;
}
export function diagnosticsStatus(checks) {
  const failed = checks.filter((c) => c.status === 'fail').length,
    skipped = checks.filter((c) => c.status === 'skip').length;
  return failed
    ? `ตรวจพบปัญหา ${failed} บริการ`
    : skipped
      ? 'ตรวจพื้นฐานผ่าน · ยังไม่ทดสอบคำตอบ AI'
      : 'ตรวจบริการผ่าน';
}
export function diagnosticsHtml(checks, when = new Date()) {
  const icon = { pass: '✅ ผ่าน', fail: '❌ ไม่ผ่าน', skip: '➖ ยังไม่ทดสอบ' };
  return (
    '<p>ผล ณ ' +
    UI.escapeHtml(when.toLocaleString('th-TH')) +
    ' · ตรวจใหม่ได้เมื่อเปลี่ยนการตั้งค่า</p>' +
    checks
      .map(
        (c) =>
          '<p><b>' +
          icon[c.status] +
          ' — ' +
          UI.escapeHtml(CHECK_NAMES[c.id]) +
          '</b><br>' +
          UI.escapeHtml(c.message) +
          '</p>'
      )
      .join('') +
    '<p>การตรวจนี้ไม่ใช้ข้อมูลประชุม และไม่แทนการทดลองซิงก์คอมกับมือถือจริง</p>'
  );
}
