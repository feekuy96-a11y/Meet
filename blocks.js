// งานหนักเกี่ยวกับเสียง (แฮช SHA-256 / base64) ย้ายไปทำใน Web Worker
// ถ้าเบราว์เซอร์ไม่มี Worker หรือ Worker ล้มเหลว จะกลับมาทำในเธรดหลักแบบเดิมอัตโนมัติ
let worker;
let seq = 0;
const waiting = new Map();
function getWorker() {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === 'undefined') return (worker = null);
    worker = new Worker(new URL('./blockworker.js', import.meta.url));
    worker.onmessage = (event) => {
      const entry = waiting.get(event.data.id);
      if (!entry) return;
      waiting.delete(event.data.id);
      if (event.data.error) entry.reject(new Error(event.data.error));
      else entry.resolve(event.data.value);
    };
    worker.onerror = () => {
      const pending = [...waiting.values()];
      waiting.clear();
      worker = null; // ครั้งต่อไปใช้เธรดหลัก
      for (const entry of pending) entry.reject(new Error('worker'));
    };
  } catch {
    worker = null;
  }
  return worker;
}
function viaWorker(op, blob, fallback) {
  const w = getWorker();
  if (!w) return fallback();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    try {
      w.postMessage({ id, op, blob });
    } catch (error) {
      waiting.delete(id);
      reject(error);
    }
  }).catch(() => fallback());
}
export const digestBlob = (blob) =>
  viaWorker('hash', blob, async () =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
export const blobToBase64 = (blob) =>
  viaWorker('b64', blob, async () => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
