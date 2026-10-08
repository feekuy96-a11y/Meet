# MeetNote TH

เว็บบันทึกการประชุมภาษาไทย: บันทึกเสียงลง IndexedDB, พิมพ์/ถอดเสียงผ่านเบราว์เซอร์, สรุปด้วย Gemini ผ่าน Google Apps Script และสร้าง Google Docs

- [คู่มือติดตั้งทีละขั้นสำหรับผู้เริ่มต้น](docs/INSTALL_TH.md)
- [รายงานข้อบกพร่อง ความปลอดภัย และข้อจำกัด](docs/AUDIT_TH.md)

## เปิดทดลองในเครื่อง

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

ใช้ Chrome/Edge เปิด localhost พอร์ต 8080 ไม่เปิด index.html แบบ file:// การบันทึกในเครื่องไม่ต้องใช้ API key ส่วน AI/Docs ต้องตั้ง Script Properties และ Deploy ตามคู่มือ ห้ามใส่ค่าลับในไฟล์เว็บ

## ทดสอบ

```sh
npm ci
npm test
npx playwright install chromium
# เปิดเซิร์ฟเวอร์ทดสอบใน Terminal อีกหน้าต่างก่อน
npm run test:browser
```

Node.js 22 ขึ้นไป สำหรับ Linux ที่มี Chromium อยู่แล้วตั้ง `CHROMIUM_PATH=/usr/bin/chromium` ก่อนรัน smoke test ได้ การรันเว็บตามปกติไม่ต้องใช้ Node.js

## ข้อจำกัดสำคัญ

ข้อมูลอยู่ในเบราว์เซอร์ ไม่ซิงก์ข้ามเครื่อง JSON ไม่รวมเสียง ต้องสำรองเสียงแยก เปิดหน้าจอไว้ขณะบันทึก ไม่รับประกันทำงานเมื่อปิดจอหรือพักเครื่อง ระบบเลือกผู้พูดด้วยตนเอง ไม่ใช่ speaker diarization ระบบ backend ใช้รหัสผ่านร่วม เหมาะกับเจ้าของคนเดียวหรือทีมที่ไว้ใจกัน ยังต้องทดสอบ Gemini และ Drive บนบัญชีจริงก่อนใช้งานจริง

## โครงสร้างเพื่อพัฒนาต่อ

- `js/app.js`: สถานะการบันทึกและ event handlers ของ UI
- `js/audio.js`: MediaRecorder และการเขียนเสียงเป็นช่วง พร้อมเก็บช่วงที่เขียนล้มเหลวไว้กู้คืน
- `js/db.js`: IndexedDB transactions และการอ่านเสียงเก่า/ใหม่
- `js/model.js`: ตรวจรูปแบบข้อมูลนำเข้าและสรุป AI
- `js/api.js`: HTTPS endpoint validation, timeout และเรียก Apps Script
- `js/ui.js`: ข้อความแจ้งเตือนและหน้าต่างยืนยัน
- `Code.gs`: ตรวจรหัส/ข้อมูล, จำกัดคำขอ, Gemini และ Docs พร้อมประวัติคำขอ
- `sw.js`: cache เฉพาะ static assets ไม่ cache คำขอ API
- `tests/`: ตรรกะระบบและ browser smoke test โดยไม่ใช้บัญชี Google จริง

`css/style.css` และ `js/worklet.js` คงไฟล์เดิมทุกไบต์ เพิ่มแก้ accessibility/print แยกใน `css/accessibility.css` และไม่เรียก worklet ที่อ้างการป้องกัน background throttling

ก่อนแก้โครงสร้าง IndexedDB ให้ทำ migration และทดสอบข้อมูลเดิม ห้ามลบฐานข้อมูลแก้ปัญหาโดยไม่มีสำรอง ทุกครั้งที่เปลี่ยนไฟล์ static ให้เปลี่ยนเวอร์ชัน `CACHE` ใน sw.js และทดสอบออฟไลน์ใหม่ ใช้ `npm run format` จัดรูปแบบไฟล์ (ยกเว้นสองไฟล์ที่คงเดิม) และ `npm run format:check` ตรวจรูปแบบ
