import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWorker, MODELS, normalizeRequest, parseCommand, authorized, buildPrompt } from './worker.mjs';

test('exact commands and authentication', () => {
  assert.deepEqual(parseCommand('/模型 luna'), { type: 'model', value: 'luna' });
  assert.deepEqual(parseCommand('/model SOL'), { type: 'model', value: 'sol' });
  assert.equal(parseCommand('文章里写了 /模型 luna'), null);
  assert.equal(authorized('Bearer secret', 'secret'), true);
  assert.equal(authorized('Bearer wrong', 'secret'), false);
});

test('only visible conversation is passed; wrong model, tool continuation and image URLs rejected', () => {
  const request = normalizeRequest({ model: 'codex-local', messages: [
    { role: 'system', content: 'SYSTEM_SECRET' }, { role: 'tool', content: 'TOOL_SECRET' },
    { role: 'assistant', content: 'previous answer' }, { role: 'user', content: 'hello' },
  ] });
  assert.equal(request.history.length, 1);
  assert.ok(!buildPrompt(request).includes('SYSTEM_SECRET'));
  assert.ok(!buildPrompt(request).includes('TOOL_SECRET'));
  assert.throws(() => normalizeRequest({ model: 'other', messages: [{ role: 'user', content: 'hello' }] }));
  assert.throws(() => normalizeRequest({ model: 'codex-local', messages: [{ role: 'tool', content: 'hello' }] }));
  assert.throws(() => normalizeRequest({ model: 'codex-local', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } }] }] }));
});

test('bounded history and image attachment', () => {
  const request = normalizeRequest({ model: 'codex-local', messages: [
    ...Array.from({ length: 30 }, () => ({ role: 'assistant', content: 'x'.repeat(6000) })),
    { role: 'user', content: [{ type: 'text', text: 'photo' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
  ] });
  assert.equal(request.images[0].extension, 'png');
  assert.ok(request.history.reduce((n, m) => n + m.text.length, 0) <= 20000);
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } };
  assert.throws(() => normalizeRequest({ model: 'codex-local', messages: [{ role: 'user', content: Array(5).fill(image) }] }), /四张/);
  const oversized = 'data:image/png;base64,' + Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => normalizeRequest({ model: 'codex-local', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: oversized } }] }] }), /10 MB/);
});

test('HTTP auth, model control without inference, persistence, SSE and backend failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ottbot-bridge-test-'));
  const config = { runtimeDirectory: dir, defaultModel: MODELS.sol, workerToken: 'test-token' };
  let calls = 0;
  const server = await createWorker(config, async (_config, request, model) => {
    calls++;
    if (request.text === 'fail') throw new Error('controlled backend failure');
    return `中文测试：${request.text} (${model})`;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const chat = (text, stream = false) => fetch(url + '/v1/chat/completions', { method: 'POST', headers,
    body: JSON.stringify({ model: 'codex-local', messages: [{ role: 'user', content: text }], stream }) });
  try {
    assert.equal((await fetch(url + '/health')).status, 401);
    assert.equal((await fetch(url + '/health', { headers })).status, 200);
    assert.equal((await (await chat('/模型 luna')).json()).choices[0].message.content.includes(MODELS.luna), true);
    assert.equal((await (await chat('/模型 invalid')).json()).choices[0].message.content.includes('没有这个模型'), true);
    assert.equal(calls, 0);
    const completion = await (await chat('hello')).json();
    assert.ok(completion.choices[0].message.content.includes('中文测试：hello'));
    assert.ok(completion.choices[0].message.content.includes(MODELS.luna));
    const sse = await (await chat('stream', true)).text();
    assert.ok(sse.includes('chat.completion.chunk'));
    assert.ok(sse.includes('data: [DONE]'));
    assert.equal((await chat('fail')).status, 502);
    const failedSse = await (await chat('fail', true)).text();
    assert.ok(failedSse.includes('codex_bridge_error'));
    const reloaded = await createWorker(config, async () => 'unused');
    reloaded.listen(0, '127.0.0.1');
    await once(reloaded, 'listening');
    assert.equal((await (await fetch(`http://127.0.0.1:${reloaded.address().port}/health`, { headers })).json()).model, MODELS.luna);
    await new Promise(resolve => reloaded.close(resolve));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('busy requests rejected; disconnected caller cancels Codex work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ottbot-bridge-busy-'));
  let aborted;
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const server = await createWorker({ runtimeDirectory: dir, workerToken: 'test-token' }, async (_c, _r, _m, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted();
    throw new Error('cancelled');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const init = { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'codex-local', stream: true, messages: [{ role: 'user', content: 'wait' }] }) };
  try {
    const abort = new AbortController();
    const response = await fetch(url, { ...init, signal: abort.signal });
    assert.equal((await fetch(url, init)).status, 429);
    abort.abort();
    await cancelled;
    await response.body.cancel().catch(() => {});
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
