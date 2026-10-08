import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
});
const context = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true });
let page = await context.newPage();
const errors = [];
const instrument = (p) => {
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
};
instrument(page);
const ready = async () => {
  await page.goto(base);
  await page.locator('#chip').filter({ hasText: 'พร้อม' }).waitFor();
};
const confirm = async (label) => {
  await page.locator('#ov:not(.hide) button').getByText(label, { exact: true }).click();
};
const tab = async (name) => page.locator(`.tabs [data-t=${name}]`).click();
const note = async (text) => {
  await page.fill('#man', text);
  await page.click('#bMan');
  await page.locator('#list').getByText(text, { exact: true }).waitFor();
};
const summary = {
  overview: 'ภาพรวม',
  exec: ['ข้อสรุป'],
  topics: [],
  decisions: [],
  actions: [],
  followups: [],
  speakers: []
};
let apiRequests = 0,
  docsSucceed = false;
const documentIds = [];
await context.route('https://script.google.com/**', async (route) => {
  apiRequests++;
  const p = route.request().postDataJSON();
  if (p.action === 'createDoc') documentIds.push(p.requestId);
  const result =
    p.action === 'summarize'
      ? { ok: true, data: summary, usedAudio: p.audio.length > 0 }
      : docsSucceed
        ? { ok: true, urls: ['https://docs.google.com/document/d/test_document/edit'] }
        : { ok: false, error: '<img src=x onerror="window.pwned=true">' };
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(result)
  });
});
try {
  await ready();
  assert.equal(await page.locator('#auto').isDisabled(), true);
  await page.fill('#title', 'ทดสอบระบบ');
  await note('ข้อความแรก');
  await page.click('#theme');
  const theme = await page.getAttribute('html', 'data-theme');
  await page.reload();
  await page.locator('#chip').filter({ hasText: 'พร้อม' }).waitFor();
  assert.equal(await page.getAttribute('html', 'data-theme'), theme);
  assert.equal(await page.inputValue('#title'), 'ทดสอบระบบ');
  assert.equal(await page.locator('#list [data-edit]').textContent(), 'ข้อความแรก');
  await page.locator('#list [data-edit]').fill('แก้ไขข้อความ');
  await page.click('#title');
  await page.waitForFunction(() =>
    document.querySelector('#list').textContent.includes('แก้ไขข้อความ')
  );
  await page.click('#bSet');
  await page.fill('#cGas', 'https://evil.test');
  await confirm('บันทึก');
  assert.equal(await page.locator('#ov').evaluate((e) => e.classList.contains('hide')), false);
  await page.fill('#cGas', 'https://script.google.com/macros/s/test_deployment/exec');
  await page.fill('#cGasTok', 't'.repeat(40));
  await confirm('บันทึก');
  assert.equal(await page.evaluate(() => localStorage.getItem('mn_cfg').includes('tttttt')), false);
  await tab('sum');
  await page.click('#bAI');
  await confirm('ส่งข้อมูล');
  await page.locator('#sumBox').getByText('ภาพรวม', { exact: true }).last().waitFor();
  assert.equal(apiRequests, 1);
  await page.click('#bDocs');
  await confirm('สร้างเอกสาร');
  await page.locator('.toast.err').filter({ hasText: '<img' }).waitFor();
  assert.equal(await page.locator('#toasts img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  // Ambiguous document failures keep a request ID across reload; token is not retained.
  await page.reload();
  await page.locator('#chip').filter({ hasText: 'พร้อม' }).waitFor();
  await page.click('#bSet');
  assert.equal(await page.inputValue('#cGasTok'), '');
  await page.fill('#cGasTok', 't'.repeat(40));
  await confirm('บันทึก');
  docsSucceed = true;
  await tab('sum');
  await page.click('#bDocs');
  await confirm('สร้างเอกสาร');
  await page.locator('#ov a').waitFor();
  assert.equal(await page.locator('#ov a').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(documentIds[0], documentIds[1]);
  await confirm('ปิด');
  // Real Chromium MediaRecorder with fake input: pause/resume and durable final chunk.
  await tab('rec');
  await page.locator('#stt').evaluate((e) => {
    e.checked = false;
    e.dispatchEvent(new Event('change'));
  });
  await page.click('#bStart');
  await page.locator('#chip').filter({ hasText: 'กำลังบันทึก' }).waitFor();
  await page.waitForTimeout(2300);
  await page.click('#bPause');
  await page.locator('#chip').filter({ hasText: 'พักอยู่' }).waitFor();
  const paused = await page.locator('#timer').textContent();
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('#timer').textContent(), paused);
  await page.click('#bPause');
  await page.waitForTimeout(1000);
  await page.click('#bStop');
  await confirm('จบการประชุม');
  await page.locator('#chip').filter({ hasText: 'พร้อม' }).waitFor();
  await page.getByText('ฟังเสียงช่วง 1', { exact: true }).click();
  await page.locator('#fullA audio').waitFor();
  const playable = await page.locator('#fullA audio').evaluate(async (el) => {
    await new Promise((resolve, reject) => {
      if (el.readyState >= 1) return resolve();
      el.addEventListener('loadedmetadata', resolve, { once: true });
      el.addEventListener('error', reject, { once: true });
    });
    return el.readyState >= 1;
  });
  assert.equal(playable, true);
  const [audioDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByText('ดาวน์โหลดช่วง 1', { exact: true }).click()
  ]);
  assert.match(audioDownload.suggestedFilename(), /\.webm$/);
  // Markdown, HTML Word and print/PDF export contain the actual meeting text.
  await tab('sum');
  for (const [format, ext] of [
    ['md', '.md'],
    ['docx', '.doc']
  ]) {
    await page.selectOption('#fmt', format);
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#bDl')]);
    assert.ok(d.suggestedFilename().endsWith(ext));
    assert.ok((await fs.readFile(await d.path(), 'utf8')).includes('แก้ไขข้อความ'));
  }
  await page.evaluate(() => {
    window.print = () => {};
  });
  await page.selectOption('#fmt', 'pdf');
  await page.click('#bDl');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('#printReport').isVisible(), true);
  assert.ok((await page.locator('#printReport').textContent()).includes('แก้ไขข้อความ'));
  await page.emulateMedia({ media: 'screen' });
  // Export is real downloadable content, then import verifies fresh ID and safe rendering.
  await tab('sum');
  await page.selectOption('#fmt', 'json');
  const [jsonDownload] = await Promise.all([page.waitForEvent('download'), page.click('#bDl')]);
  const backup = JSON.parse(await fs.readFile(await jsonDownload.path(), 'utf8'));
  assert.equal(backup.format, 'meetnote-text-v2');
  assert.equal(backup.meeting.segs[0].text, 'แก้ไขข้อความ');
  backup.meeting.title = '<img src=x onerror="window.pwned=true">';
  backup.meeting.speakers[0].id = 'id" onmouseover="evil';
  backup.meeting.segs[0].spk = backup.meeting.speakers[0].id;
  await tab('his');
  await page.locator('#importFile').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup))
  });
  await page.waitForFunction(() => document.querySelector('#title').value.startsWith('<img'));
  assert.equal(await page.locator('#list img,#spks img,#hl img').count(), 0);
  const imported = await page.evaluate(async () => {
    const { DB } = await import('./js/db.js');
    return (await DB.getAllMeetings()).find((m) => m.title.startsWith('<img'));
  });
  assert.notEqual(imported.id, backup.meeting.id);
  assert.equal(imported.part, 0);
  // Simulate abrupt tab closure after at least one persisted audio chunk.
  await page.locator('#stt').evaluate((e) => {
    e.checked = false;
    e.dispatchEvent(new Event('change'));
  });
  await page.click('#bStart');
  await page.locator('#chip').filter({ hasText: 'กำลังบันทึก' }).waitFor();
  await page.waitForTimeout(2300);
  await page.close();
  page = await context.newPage();
  instrument(page);
  await ready();
  await page.getByText('ฟังเสียงช่วง 1', { exact: true }).waitFor();
  assert.ok(await page.locator('.toast').filter({ hasText: 'ถูกขัดจังหวะ' }).count());
  // Quota failure stops the recording and exposes recoverable audio, without hanging.
  await page.evaluate(async () => {
    const { DB } = await import('./js/db.js');
    const real = DB.saveAudio;
    DB.saveAudio = async () => {
      throw new DOMException('quota full', 'QuotaExceededError');
    };
    window.restoreAudio = () => (DB.saveAudio = real);
  });
  await page.locator('#stt').evaluate((e) => {
    e.checked = false;
    e.dispatchEvent(new Event('change'));
  });
  await page.click('#bStart');
  await page
    .locator('#ov:not(.hide)')
    .filter({ hasText: 'ต้องกู้ไฟล์เสียง' })
    .waitFor({ timeout: 15000 });
  assert.equal(await page.isDisabled('#bStart'), true);
  await page.evaluate(() => window.restoreAudio());
  await confirm('ลองบันทึกอีกครั้ง');
  await page.locator('#chip').filter({ hasText: 'พร้อม' }).waitFor();
  assert.equal(await page.isDisabled('#bStart'), false);
  // Offline app shell can load after the worker takes control.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.locator('#chip').filter({ hasText: 'พร้อม' }).waitFor();
  await context.setOffline(true);
  await page.reload();
  await page.locator('#chip').filter({ hasText: 'พร้อม' }).waitFor();
  const failed = await page.evaluate(async () => {
    try {
      await fetch('./offline-probe-' + Date.now());
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(failed, true);
  assert.equal(
    await page.locator('#net').textContent(),
    await page.evaluate(() => (navigator.onLine ? '🟢 มีเครือข่าย' : '🔴 ออฟไลน์'))
  );
  await context.setOffline(false);
  // A malformed stored meeting cannot prevent access to other meetings or backups.
  await page.evaluate(async () => {
    const { DB } = await import('./js/db.js');
    await DB.saveMeeting({
      id: 'corrupt-record',
      title: 'เสียรูปแบบ',
      date: new Date().toISOString(),
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      segs: 'not-an-array',
      speakers: [],
      dur: 0,
      part: 0
    });
  });
  await page.reload();
  await page.locator('#chip').filter({ hasText: 'พร้อม' }).waitFor();
  await page.locator('.toast').filter({ hasText: 'รูปแบบไม่ถูกต้อง' }).waitFor();
  await tab('his');
  const corrupt = page.locator('.hist').filter({ hasText: 'เสียรูปแบบ' });
  const [rawBackup] = await Promise.all([
    page.waitForEvent('download'),
    corrupt.locator('[data-backup]').click()
  ]);
  assert.equal(
    JSON.parse(await fs.readFile(await rawBackup.path(), 'utf8')).meeting.segs,
    'not-an-array'
  );
  const other = await context.newPage();
  instrument(other);
  await other.goto(base);
  await other.locator('#chip').filter({ hasText: 'ฐานข้อมูลใช้ไม่ได้' }).waitFor();
  assert.equal(await other.isDisabled('#bStart'), true);
  await other.close();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: browser persistence, editing, API safety, recording/pause/resume/playback, downloads/import, crash/quota recovery and offline shell'
  );
} finally {
  await context.close();
  await browser.close();
}
