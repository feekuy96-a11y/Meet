import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { backend } from './helpers/gas.mjs';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8080/';
const b = backend(),
  errors = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
});
const contexts = [];
async function createDevice(mobile = false) {
  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: mobile
  });
  contexts.push(context);
  await context.route('https://script.google.com/**', async (route) => {
    const result = b.post(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(result)
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(base);
  await ready(page);
  return page;
}
async function ready(page) {
  await page.locator('#chip').filter({ hasText: 'พร้อม' }).waitFor();
}
async function confirm(page, name) {
  await page.locator('#ov:not(.hide) button').getByText(name, { exact: true }).click();
}
async function configure(page) {
  await page.click('#bSet');
  await page.fill('#cGas', 'https://script.google.com/macros/s/cloud_test/exec');
  await page.fill('#cGasTok', 't'.repeat(40));
  await page.locator('#cCloud').evaluate((e) => (e.checked = true));
  await confirm(page, 'บันทึก');
}
async function sync(page) {
  await page.waitForFunction(() => !document.querySelector('#bSync').disabled);
  await page.click('#bSync');
  await page
    .locator('#cloudStatus')
    .filter({ hasText: /ซิงก์ข้อความและเสียงแล้ว|รายการต้องเลือกรุ่น/ })
    .waitFor({ timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector('#bSync').disabled);
}
try {
  const a = await createDevice();
  await a.fill('#title', 'ประชุมข้ามเครื่อง');
  await a.fill('#man', 'บันทึกจากคอม');
  await a.click('#bMan');
  await a.locator('#stt').evaluate((e) => {
    e.checked = false;
    e.dispatchEvent(new Event('change'));
  });
  await a.click('#bStart');
  await a.locator('#chip').filter({ hasText: 'กำลังบันทึก' }).waitFor();
  await a.waitForTimeout(2200);
  await a.click('#bStop');
  await confirm(a, 'จบการประชุม');
  await ready(a);
  await configure(a);
  await sync(a);
  const original = await a.evaluate(async () => {
    const { DB } = await import('./js/db.js');
    return (await DB.getAllMeetings())[0];
  });
  assert.equal(original.cloud.version, 1);
  assert.equal(original.cloud.audio.length, 1);
  const phone = await createDevice(true);
  await configure(phone);
  await sync(phone);
  assert.equal(await phone.inputValue('#title'), 'ประชุมข้ามเครื่อง');
  assert.equal(await phone.locator('#list [data-edit]').textContent(), 'บันทึกจากคอม');
  await phone.getByText('ฟังเสียงช่วง 1', { exact: true }).click();
  await phone.locator('#fullA audio').waitFor();
  await phone.waitForFunction(() => document.querySelector('#fullA audio').readyState >= 1);
  await phone.locator('#list [data-edit]').fill('แก้จากมือถือ');
  await phone.click('#title');
  await sync(phone);
  await sync(a);
  assert.equal(await a.locator('#list [data-edit]').textContent(), 'แก้จากมือถือ');
  // Two devices edit the same starting revision; the later upload must conflict.
  await a.evaluate(() =>
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true })
  );
  await a.locator('#list [data-edit]').fill('แก้ในคอมที่ยังไม่ส่ง');
  await a.click('#title');
  await phone.locator('#list [data-edit]').fill('มือถือส่งก่อน');
  await phone.click('#title');
  await sync(phone);
  await a.evaluate(() =>
    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true })
  );
  await sync(a);
  await a.locator('#bConflicts:not(.hide)').waitFor();
  assert.equal(await a.locator('#list [data-edit]').textContent(), 'แก้ในคอมที่ยังไม่ส่ง');
  await a.click('#bConflicts');
  await confirm(a, 'ใช้รุ่นคลาวด์');
  await confirm(a, 'ใช้รุ่นคลาวด์');
  await a.locator('#list [data-edit]').filter({ hasText: 'มือถือส่งก่อน' }).waitFor();
  // Remote deletion appears on a clean second device and does not resurrect data.
  await phone.locator('[data-t=his]').click();
  await phone.locator('.hist [data-delete]').click();
  await confirm(phone, 'ลบจากทุกเครื่อง');
  await phone.waitForFunction(() => !document.querySelector('#bSync').disabled);
  await sync(a);
  assert.equal(await a.locator('#list [data-edit]').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: two browser devices share editable meetings and playable audio, enforce conflicts and propagate cloud deletion'
  );
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
