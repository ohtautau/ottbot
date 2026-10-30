import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiSetup } from './api-setup.mjs';
import { configuredApiModels, resolveConfiguredModel, runApi } from './models.mjs';
import { helpText } from './commands.mjs';

async function fixture(run) {
  const folder = await mkdtemp(join(tmpdir(), 'ottbot-api-setup-'));
  const paths = { providersFile: join(folder, 'providers.json'), pendingFile: join(folder, 'pending.json') };
  try { await run(paths); } finally { await rm(folder, { recursive: true, force: true }); }
}

test('owner configuration workflow never echoes keys; confirm saves and explicit selection uses configured API', async () => fixture(async paths => {
  const setup = await createApiSetup(paths);
  const secret = 'test-private-api-value-not-real';
  assert.equal((await setup.handle('hello')).handled, false);
  for (const input of ['/api add', 'Qwen', 'https://api.example.com/v1/chat/completions', secret, 'qwen-plus']) {
    const reply = await setup.handle(input);
    assert.equal(reply.handled, true);
    assert.ok(!reply.text.includes(secret));
    assert.ok(!(await readFile(paths.pendingFile, 'utf8')).includes(secret));
  }
  await assert.rejects(access(paths.providersFile));
  const saved = await setup.handle('确认');
  assert.ok(!saved.text.includes(secret));
  assert.match(saved.text, /尚未切换/);
  const config = JSON.parse(await readFile(paths.providersFile, 'utf8'));
  assert.equal(config.qwen.apiKey, secret);
  assert.equal(config.qwen.defaultModel, 'qwen-plus');
  if (process.platform !== 'win32') assert.equal((await stat(paths.providersFile)).mode & 0o777, 0o600);
  await assert.rejects(access(paths.pendingFile));
  assert.equal((await setup.handle('普通对话')).handled, false);
  assert.ok(!(await setup.handle('/api list')).text.includes(secret));
  assert.equal(await resolveConfiguredModel(paths, 'qwen'), 'qwen/qwen-plus');
  const models = await configuredApiModels(paths);
  const view = helpText('model', { apiModels: models });
  assert.match(view, /Qwen · qwen-plus/);
  assert.ok(!view.includes(secret));
  let calls = 0;
  const answer = await runApi(paths, { text: 'hello', history: [], images: [] }, 'qwen/qwen-plus', undefined, async (url, init) => {
    calls++;
    assert.equal(url, config.qwen.endpoint);
    assert.equal(init.headers.Authorization, 'Bearer ' + secret);
    assert.equal(JSON.parse(init.body).model, 'qwen-plus');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'mock API answer' } }] }));
  });
  assert.equal(answer, 'mock API answer');
  assert.equal(calls, 1);
}));

test('cancel, expiry and restart cannot forward pending configuration values as chat', async () => fixture(async paths => {
  let time = 1000;
  const setup = await createApiSetup({ ...paths, now: () => time });
  await setup.handle('/api add');
  await setup.handle('deepseek');
  time += 11 * 60 * 1000;
  assert.equal((await setup.handle('sensitive-value')).handled, true);
  const recovered = await createApiSetup(paths);
  assert.equal((await recovered.handle('late-key-after-restart')).handled, true);
  await recovered.handle('/api cancel');
  assert.equal((await recovered.handle('hello')).handled, false);
  await assert.rejects(access(paths.providersFile));
  await assert.rejects(access(paths.pendingFile));
}));

test('invalid fields, attachments and other slash commands stay inside the wizard', async () => fixture(async paths => {
  const setup = await createApiSetup(paths);
  await setup.handle('/接口 新增');
  assert.match((await setup.handle('constructor')).text, /输入有误/);
  await setup.handle('custom');
  for (const endpoint of ['http://example.com/chat/completions', 'https://secret@example.com/chat/completions', 'https://example.com/chat/completions?key=secret']) {
    const reply = await setup.handle(endpoint);
    assert.match(reply.text, /输入有误/);
    assert.ok(!reply.text.includes(endpoint));
  }
  assert.equal((await setup.handle('/m 2')).handled, true);
  assert.equal((await setup.handle('photo', true)).handled, true);
  await setup.handle('/api cancel');
  await assert.rejects(access(paths.providersFile));
}));
