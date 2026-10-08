import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { backend } from './helpers/gas.mjs';
const b = backend(),
  requests = [],
  errors = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox']
});
try {
  const context = await browser.newContext();
  await context.route('https://script.google.com/**', async (route) => {
    const p = route.request().postDataJSON();
    requests.push(p);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(b.post(p))
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8080/');
  await page.locator('#chip').filter({ hasText: 'พร้อม' }).waitFor();
  const button = (name) => page.locator('#ov:not(.hide) button').getByText(name, { exact: true });
  await page.click('#bSet');
  await page.fill('#cGas', 'https://script.google.com/macros/s/check_test/exec');
  await page.fill('#cGasTok', 't'.repeat(40));
  await button('บันทึก').click();
  await page.fill('#man', 'private meeting text not for diagnostics');
  await page.click('#bMan');
  await page.click('#bCheck');
  assert.equal(await page.locator('#checkAI').isChecked(), false);
  await button('เริ่มตรวจ').click();
  await page.getByRole('heading', { name: 'ผลตรวจการเชื่อมต่อ', exact: true }).waitFor();
  assert.match(await page.locator('#connectionStatus').textContent(), /ยังไม่ทดสอบคำตอบ AI/);
  assert.equal(requests[0].testAI, false);
  assert.equal(JSON.stringify(requests).includes('private meeting text'), false);
  await button('ปิด').click();
  await page.click('#bCheck');
  await page.locator('label:has(#checkAI)').click();
  assert.equal(await page.locator('#checkAI').isChecked(), true);
  await button('เริ่มตรวจ').click();
  await page.getByRole('heading', { name: 'ผลตรวจการเชื่อมต่อ', exact: true }).waitFor();
  assert.equal(await page.locator('#connectionStatus').textContent(), 'ตรวจบริการผ่าน');
  await button('ปิด').click();
  b.properties.delete('GEMINI_API_KEY');
  await page.click('#bCheck');
  await button('เริ่มตรวจ').click();
  await page.getByRole('heading', { name: 'ผลตรวจการเชื่อมต่อ', exact: true }).waitFor();
  assert.match(await page.locator('#mb').textContent(), /ยังไม่ได้ตั้ง GEMINI_API_KEY/);
  assert.match(await page.locator('#connectionStatus').textContent(), /ตรวจพบปัญหา/);
  await button('ปิด').click();
  await page.click('#bSet');
  await page.fill('#cGasTok', 'wrong');
  await button('บันทึก').click();
  await page.click('#bCheck');
  await button('เริ่มตรวจ').click();
  await page.getByRole('heading', { name: 'ตรวจการเชื่อมต่อไม่สำเร็จ', exact: true }).waitFor();
  assert.match(await page.locator('#mb').textContent(), /รหัสผ่านเชื่อมต่อไม่ถูกต้อง/);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: browser diagnostics show separate service results, optional AI probe, missing-key and authentication failures without meeting uploads'
  );
} finally {
  await browser.close();
}
