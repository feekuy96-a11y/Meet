// อ่าน/ตรวจการตั้งค่าที่เก็บในเบราว์เซอร์ (รหัสผ่านเชื่อมต่อแบบเดิมไม่เก็บถาวร)
import { DEFAULTS } from './config.js';
export function loadConfig(storage) {
  let cfg = {
    gasUrl: DEFAULTS.gasUrl,
    sbUrl: DEFAULTS.sbUrl,
    sbKey: DEFAULTS.sbKey,
    useAudio: false,
    theme: '',
    cloudSync: false,
    autoDocs: true
  };
  try {
    const stored = JSON.parse(storage.getItem('mn_cfg') || '{}');
    const text = (value, fallback) => (typeof value === 'string' && value ? value : fallback);
    cfg = {
      gasUrl: text(stored.gasUrl, DEFAULTS.gasUrl),
      sbUrl: text(stored.sbUrl, DEFAULTS.sbUrl),
      sbKey: text(stored.sbKey, DEFAULTS.sbKey),
      useAudio: stored.useAudio === true,
      cloudSync: stored.cloudSync === true,
      autoDocs: stored.autoDocs !== false,
      theme: ['dark', 'light'].includes(stored.theme) ? stored.theme : ''
    };
    // Remove legacy persistent passwords; require re-entry for this tab only.
    storage.setItem('mn_cfg', JSON.stringify(cfg));
    return { cfg, ok: true };
  } catch {
    return { cfg, ok: false };
  }
}
