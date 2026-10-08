export function validateEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Web App URL ไม่ถูกต้อง');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'script.google.com' ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error('ใช้ URL https://script.google.com/macros/s/…/exec จากการ Deploy เท่านั้น');
  }
  return url.href;
}
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const API = {
  async callGAS(cfg, payload) {
    if (!cfg.gasToken) throw new Error('กรุณาใส่รหัสผ่านเชื่อมต่อในตั้งค่า');
    const url = validateEndpoint(cfg.gasUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const body = JSON.stringify({ ...payload, token: cfg.gasToken });
      if (new TextEncoder().encode(body).byteLength > 12 * 1024 * 1024)
        throw new Error('ข้อมูลเกิน 12 MB โปรดส่งข้อความหรือแบ่งประชุม');
      const response = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`เชื่อมต่อไม่สำเร็จ (HTTP ${response.status})`);
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error('เซิร์ฟเวอร์ไม่ตอบ JSON โปรดตรวจ URL และสิทธิ์ Deploy');
      }
      if (!result || result.ok !== true) throw new Error(result?.error || 'เซิร์ฟเวอร์ปฏิเสธคำขอ');
      return result;
    } catch (error) {
      if (error.name === 'AbortError')
        throw new Error('รอนานเกิน 90 วินาที คำขออาจยังทำงานบนเซิร์ฟเวอร์ อย่าส่งซ้ำทันที');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  },
  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error || new Error('อ่านเสียงไม่สำเร็จ'));
      reader.onabort = () => reject(new Error('ยกเลิกการอ่านเสียง'));
      reader.readAsDataURL(blob);
    });
  }
};
