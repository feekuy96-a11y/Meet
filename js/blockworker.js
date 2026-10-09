// Web Worker: คำนวณ SHA-256 และแปลง base64 ของบล็อกเสียงนอกเธรดหน้าเว็บ
// รับ Blob ตรง ๆ (ไม่คัดลอกข้อมูลเสียงทั้งก้อนผ่านเธรดหลัก) แล้วคืนเฉพาะผลลัพธ์ขนาดเล็ก
self.onmessage = async (event) => {
  const { id, op, blob } = event.data;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (op === 'hash') {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      let hex = '';
      for (const b of digest) hex += b.toString(16).padStart(2, '0');
      self.postMessage({ id, value: hex });
    } else if (op === 'b64') {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      self.postMessage({ id, value: btoa(binary) });
    } else throw new Error('unknown op');
  } catch (error) {
    self.postMessage({ id, error: String((error && error.message) || error) });
  }
};
