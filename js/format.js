// ฟังก์ชันจัดรูปแบบข้อความ/ไฟล์ที่ไม่ขึ้นกับสถานะแอป (แยกจาก app.js เพื่อทดสอบและแก้ไขง่าย)
import { UI } from './ui.js';

// แปลง Markdown แบบง่าย (หัวข้อ ##, รายการ -, ตัวหนา **) เป็น HTML ที่ escape แล้ว
export function markdown(value) {
  let html = '',
    inList = false;
  for (const raw of String(value).split('\n')) {
    const line = UI.escapeHtml(raw).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const bullet = /^\s*[-*•]\s+(.*)/.exec(line),
      heading = /^#{1,4}\s+(.*)/.exec(line);
    if (bullet) {
      if (!inList) html += '<ul>';
      inList = true;
      html += `<li>${bullet[1]}</li>`;
      continue;
    }
    if (inList) {
      html += '</ul>';
      inList = false;
    }
    if (heading) html += `<h4>${heading[1]}</h4>`;
    else if (line.trim()) html += `<p>${line}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}
export function audioExtension(type) {
  return type.includes('mp4')
    ? 'm4a'
    : type.includes('ogg')
      ? 'ogg'
      : type.includes('wav')
        ? 'wav'
        : type.includes('mpeg')
          ? 'mp3'
          : 'webm';
}
export const safeFilename = (title) =>
  (title || 'meeting').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
export function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export const transcriptText = (segs, speakerName) =>
  segs.map((g) => `[${UI.formatTime(g.t)}] ${speakerName(g.spk)}: ${g.text}`).join('\n');
