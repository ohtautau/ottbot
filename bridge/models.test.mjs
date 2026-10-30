import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, apiConfig, runApi } from './models.mjs';

const config = { providers: { deepseek: { enabled: true, endpoint: 'https://api.deepseek.com/chat/completions', apiKey: 'test-private-key', maxTokens: 100 } } };
const request = { text: 'hello', history: [{ role: 'assistant', text: 'previous' }], images: [] };

test('Codex aliases, full model IDs and explicit API provider are distinct', () => {
  assert.equal(resolveModel('luna'), 'gpt-6-luna');
  assert.equal(resolveModel('1'), 'gpt-6-luna');
  assert.equal(resolveModel('2'), 'gpt-6.1-sol');
  assert.equal(resolveModel('3'), 'gpt-6.1-terra');
  assert.equal(resolveModel('4'), 'gpt-6-astra');
  assert.equal(resolveModel('5'), null);
  assert.equal(resolveModel('codex/sol'), 'gpt-6.1-sol');
  assert.equal(resolveModel('gpt-future-model'), 'gpt-future-model');
  assert.equal(resolveModel('deepseek/deepseek-flash'), 'deepseek/deepseek-flash');
  assert.equal(resolveModel('custom/vendor/model:version'), 'custom/vendor/model:version');
  for (const value of ['invalid', '--config=x', 'https://example.com', 'deepseek/model --flag', 'constructor']) assert.equal(resolveModel(value), null);
});

test('API missing key, unsafe endpoint or unsupported images fail before network access', async () => {
  await assert.rejects(apiConfig({}, 'deepseek/model'), /尚未配置/);
  assert.equal((await apiConfig(config, 'deepseek/vendor/model:version')).id, 'vendor/model:version');
  await assert.rejects(apiConfig({ providers: { deepseek: { ...config.providers.deepseek, endpoint: 'http://api.deepseek.com/chat/completions' } } }, 'deepseek/model'), /HTTPS/);
  let calls = 0;
  const transport = async () => { calls++; throw new Error('must not run'); };
  await assert.rejects(runApi({}, request, 'deepseek/model', undefined, transport), /尚未配置/);
  await assert.rejects(runApi(config, { ...request, images: [{ data: Buffer.from('x'), extension: 'png' }] }, 'deepseek/model', undefined, transport), /图片/);
  assert.equal(calls, 0);
});

test('only explicitly selected API receives bounded chat; error never retries another provider', async () => {
  let calls = 0;
  const reply = await runApi(config, request, 'deepseek/deepseek-flash', undefined, async (url, init) => {
    calls++;
    assert.equal(url, config.providers.deepseek.endpoint);
    assert.equal(init.headers.Authorization, 'Bearer test-private-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.max_tokens, 100);
    assert.equal(body.messages.at(-1).content, 'hello');
    assert.equal(body.tools, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'API reply' } }] }));
  });
  assert.equal(reply, 'API reply');
  assert.equal(calls, 1);
  await assert.rejects(runApi(config, request, 'deepseek/deepseek-flash', undefined, async () => {
    calls++;
    return new Response('private diagnostic test-private-key', { status: 401 });
  }), error => /HTTP 401/.test(error.message) && !error.message.includes('test-private-key'));
  assert.equal(calls, 2);
});
