import test from 'node:test';
import assert from 'node:assert/strict';
import { backend } from './helpers/gas.mjs';
const request = (testAI = false) => ({ action: 'diagnostics', token: 't'.repeat(40), testAI });
const check = (r, id) => r.checks.find((c) => c.id === id);
test('diagnostics authenticates before probes, rejects invalid options, and never returns credentials', () => {
  const b = backend();
  assert.equal(b.post({ ...request(), token: 'wrong' }).ok, false);
  assert.equal(b.calls.length, 0);
  assert.equal(b.files.size, 0);
  assert.equal(b.post({ ...request(), testAI: 'yes' }).ok, false);
  const r = b.post(request());
  assert.equal(r.ok, true);
  for (const id of ['server', 'drive', 'docs', 'gemini']) assert.equal(check(r, id).status, 'pass');
  assert.equal(check(r, 'generation').status, 'skip');
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].options.method, 'get');
  assert.equal(b.calls[0].options.payload, undefined);
  assert.equal(JSON.stringify(r).includes('test-key'), false);
  const artifacts = [...b.files.values()];
  assert.equal(artifacts.length, 2);
  assert.ok(artifacts.every((f) => f.trashed));
});
test('diagnostics isolates Drive failure, cleans Docs partial failures, and skips unconfigured Gemini', () => {
  const b = backend();
  const folder = b.ctx.cloudRoot_(b.ctx.PropertiesService.getScriptProperties());
  folder.createFile = () => {
    throw new Error('SECRET INTERNAL ERROR');
  };
  b.properties.delete('GEMINI_API_KEY');
  const r = b.post(request(true));
  assert.equal(check(r, 'drive').status, 'fail');
  assert.equal(check(r, 'docs').status, 'pass');
  assert.equal(check(r, 'gemini').status, 'fail');
  assert.equal(check(r, 'generation').status, 'skip');
  assert.equal(b.calls.length, 0);
  assert.equal(JSON.stringify(r).includes('SECRET'), false);
  const failing = backend();
  failing.setFailMove();
  const failed = failing.post(request());
  assert.equal(check(failed, 'docs').status, 'fail');
  assert.ok([...failing.files.values()].every((f) => f.trashed));
});
test('optional AI probe uses only synthetic text and reports API or quota failure without raw bodies', () => {
  const b = backend();
  const r = b.post(request(true));
  assert.equal(check(r, 'generation').status, 'pass');
  assert.equal(b.calls.length, 2);
  const payload = JSON.parse(b.calls[1].options.payload);
  assert.equal(payload.contents[0].parts.length, 1);
  assert.equal(payload.contents[0].parts[0].text, 'Connection test. Reply OK.');
  const original = b.ctx.UrlFetchApp.fetch;
  b.ctx.UrlFetchApp.fetch = (url, options) =>
    options.method === 'get'
      ? original(url, options)
      : { getResponseCode: () => 429, getContentText: () => 'PRIVATE RAW TOKEN' };
  const fail = b.post(request(true));
  assert.equal(check(fail, 'gemini').status, 'pass');
  assert.equal(check(fail, 'generation').status, 'fail');
  assert.equal(JSON.stringify(fail).includes('PRIVATE'), false);
  b.ctx.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 403,
    getContentText: () => 'PRIVATE RAW TOKEN'
  });
  const denied = b.post(request(true));
  assert.equal(check(denied, 'gemini').status, 'fail');
  assert.equal(check(denied, 'generation').status, 'skip');
});
