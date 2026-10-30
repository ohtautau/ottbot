import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWorker, MODELS } from './worker.mjs';
import { createHub, routingCommand } from './hub.mjs';

test('explicit target prefixes are exact and keep multiline tasks', () => {
  assert.deepEqual(routingCommand('/电脑 检查\n项目'), { target: 'computer', text: '检查\n项目' });
  assert.deepEqual(routingCommand('/server task'), { target: 'server', text: 'task' });
  assert.equal(routingCommand('解释 /电脑 的意思'), null);
});

test('server default, computer execution, persistent model selection and no offline fallback', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ottbot-hub-'));
  const token = 'test-private-token';
  const runs = [];
  const efforts = [];
  const startWorker = async target => {
    const worker = await createWorker({ runtimeDirectory: join(folder, target), workerToken: token }, async (_c, request, model) => {
      runs.push({ target, text: request.text, model });
      efforts.push(_c.reasoningEffort);
      return `${target}: ${request.text}`;
    });
    worker.listen(0, '127.0.0.1'); await once(worker, 'listening');
    return worker;
  };
  const remote = await startWorker('server');
  const computer = await startWorker('computer');
  const config = { workerToken: token, runtimeDirectory: join(folder, 'hub'),
    serverWorkerUrl: `http://127.0.0.1:${remote.address().port}`,
    computerWorkerUrl: `http://127.0.0.1:${computer.address().port}` };
  const hub = await createHub(config);
  hub.listen(0, '127.0.0.1'); await once(hub, 'listening');
  const base = `http://127.0.0.1:${hub.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const chat = (text, stream = false) => fetch(base + '/v1/chat/completions', { method: 'POST', headers,
    body: JSON.stringify({ model: 'codex-local', stream, messages: [{ role: 'user', content: text }] }) });
  let computerClosed = false;
  try {
    assert.equal((await fetch(base + '/health')).status, 401);
    for (const text of ['/unknown', '/st extra', '/h r', '/m', '/t missing']) {
      const result = await (await chat(text)).json();
      assert.match(result.choices[0].message.content, /【/);
      assert.equal(runs.length, 0);
    }
    const missingApi = await (await chat('/模型 deepseek/deepseek-flash')).json();
    assert.match(missingApi.choices[0].message.content, /尚未配置/);
    assert.equal((await (await fetch(base + '/health', { headers })).json()).model, MODELS.sol);
    await (await chat('/模型 luna')).body.cancel();
    await (await chat('/推理 3')).body.cancel();
    const invalidEffort = await (await chat('/推理 6')).json();
    assert.match(invalidEffort.choices[0].message.content, /不支持/);
    assert.equal(runs.length, 0);
    assert.ok((await (await chat('hello')).json()).choices[0].message.content.includes('server: hello'));
    assert.deepEqual(runs.at(-1), { target: 'server', text: 'hello', model: MODELS.luna });
    assert.equal(efforts.at(-1), 'high');
    const stream = await (await chat('/电脑 检查项目', true)).text();
    assert.ok(stream.includes('computer: 检查项目') && stream.includes('[DONE]'));
    assert.equal(runs.at(-1).target, 'computer');
    assert.equal(efforts.at(-1), 'high');
    await (await chat('/执行 电脑')).body.cancel();
    await new Promise(resolve => computer.close(resolve)); computerClosed = true;
    const count = runs.length;
    assert.equal((await chat('must stay on computer')).status, 503);
    assert.equal((await chat('/电脑 do not silently reroute')).status, 503);
    assert.equal(runs.length, count);
    assert.equal((await chat('/服务器 still works')).status, 200);
    assert.deepEqual(runs.at(-1), { target: 'server', text: 'still works', model: MODELS.luna });
    const status = await (await fetch(base + '/health', { headers })).json();
    assert.equal(status.computerOnline, false);
    assert.equal(status.serverOnline, true);
    assert.equal(status.target, 'computer');
    const reloaded = await createHub(config);
    reloaded.listen(0, '127.0.0.1'); await once(reloaded, 'listening');
    const saved = await (await fetch(`http://127.0.0.1:${reloaded.address().port}/health`, { headers })).json();
    assert.equal(saved.model, MODELS.luna);
    assert.equal(saved.target, 'computer');
    assert.equal(saved.reasoningEffort, 'high');
    await new Promise(resolve => reloaded.close(resolve));
  } finally {
    await new Promise(resolve => hub.close(resolve));
    if (!computerClosed) await new Promise(resolve => computer.close(resolve));
    await new Promise(resolve => remote.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
