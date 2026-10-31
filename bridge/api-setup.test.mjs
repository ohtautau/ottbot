import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiSetup } from './api-setup.mjs';
import { configuredApiModels, resolveConfiguredModel, runApi, assignApiModelNumbers } from './models.mjs';
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
  assert.ok(!(await setup.handle('/api')).text.includes(secret));
  assert.equal(await resolveConfiguredModel(paths, 'qwen'), 'qwen/qwen-plus');
  assert.equal(await resolveConfiguredModel(paths, '5'), 'qwen/qwen-plus');
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

test('empty provider placeholders are hidden; assigned API model numbers survive additions', async () => fixture(async paths => {
  const providers = {
    deepseek: { enabled: false, apiKey: '' },
    qwen: { enabled: true, apiKey: 'test-private-not-real', defaultModel: 'qwen-plus', models: ['qwen-plus'] },
  };
  await writeFile(paths.providersFile, JSON.stringify(providers));
  const setup = await createApiSetup(paths);
  const list = (await setup.handle('/api')).text;
  assert.ok(!list.includes('deepseek'));
  assert.match(list, /\/m 5[^\n]*qwen[^\n]*qwen-plus/);
  assert.ok(!list.includes('Key未填写') && !list.includes('切换：/m 提供商'));
  const saved = JSON.parse(await readFile(paths.providersFile, 'utf8'));
  assert.equal(saved.qwen.modelNumbers['qwen-plus'], 5);
  saved.deepseek = { enabled: true, apiKey: 'test-private-other-not-real', defaultModel: 'deepseek-flash' };
  saved.qwen.models.push('qwen-new');
  saved.qwen.defaultModel = 'qwen-new';
  const rows = assignApiModelNumbers(saved);
  assert.equal(rows.find(item => item.model === 'qwen/qwen-plus').number, 5);
  assert.equal(new Set(rows.map(item => item.number)).size, rows.length);
  await writeFile(paths.providersFile, JSON.stringify(saved));
  const updatedList = (await setup.handle('/api')).text;
  for (const row of rows) {
    assert.ok(updatedList.split('\n').some(line => new RegExp(`^/m ${row.number}\\s`).test(line) && line.includes(row.provider) && line.includes(row.id)));
  }
  assert.equal(await resolveConfiguredModel(paths, '5'), 'qwen/qwen-plus');
  assert.equal(await resolveConfiguredModel(paths, 'qwen'), 'qwen/qwen-new');
}));

test('single API deletion requires confirmation, keeps other numbers and blocks deleted model calls', async () => fixture(async paths => {
  const secret = 'test-delete-private-not-real';
  await writeFile(paths.providersFile, JSON.stringify({ qwen: { enabled: true, apiKey: secret, endpoint: 'https://api.example.com/v1/chat/completions', models: ['qwen-plus', 'qwen-turbo'], defaultModel: 'qwen-plus' } }));
  const setup = await createApiSetup(paths);
  const initial = await readFile(paths.providersFile, 'utf8');
  for (const command of ['/api delete', '/api delete openai', '/api delete 2', '/api delete 999']) {
    assert.equal((await setup.handle(command)).handled, true);
    assert.equal(await readFile(paths.providersFile, 'utf8'), initial);
    await assert.rejects(access(paths.pendingFile));
  }
  const confirmation = (await setup.handle('/api delete 5')).text;
  assert.match(confirmation, /确认删除 API/);
  assert.ok(!confirmation.includes(secret));
  assert.equal(await readFile(paths.providersFile, 'utf8'), initial);
  assert.ok(!(await readFile(paths.pendingFile, 'utf8')).includes(secret));
  await setup.handle('/api cancel');
  assert.equal(await readFile(paths.providersFile, 'utf8'), initial);
  await setup.handle('/接口 删除 5');
  assert.equal((await setup.handle('/m 2')).handled, true);
  assert.match((await setup.handle('确认')).text, /API 已删除/);
  const rows = await configuredApiModels(paths);
  assert.deepEqual(rows.map(row => [row.number, row.id]), [[6, 'qwen-turbo']]);
  assert.equal(await resolveConfiguredModel(paths, '5'), null);
  let calls = 0;
  await assert.rejects(runApi(paths, { text: 'hello', history: [], images: [] }, 'qwen/qwen-plus', undefined, async () => { calls++; }), /已删除/);
  assert.equal(calls, 0);
  let saved = JSON.parse(await readFile(paths.providersFile, 'utf8'));
  assert.equal(saved.qwen.defaultModel, 'qwen-turbo');
  assert.equal(saved.qwen.apiKey, secret);
  await setup.handle('/ap rm 6');
  await setup.handle('/api save');
  assert.deepEqual(await configuredApiModels(paths), []);
  saved = JSON.parse(await readFile(paths.providersFile, 'utf8'));
  assert.equal(saved.qwen.enabled, false);
  assert.equal(saved.qwen.apiKey, secret);
  await assert.rejects(access(paths.pendingFile));
  for (const input of ['/api add', 'qwen', 'https://api.example.com/v1/chat/completions', secret, 'qwen-plus', '确认']) await setup.handle(input);
  assert.equal(await resolveConfiguredModel(paths, '5'), 'qwen/qwen-plus');
  assert.ok(!JSON.parse(await readFile(paths.providersFile, 'utf8')).qwen.deletedModels.includes('qwen-plus'));
}));

test('pending deletion cannot replace a setup draft or survive expiry and restart as confirmation', async () => fixture(async paths => {
  await writeFile(paths.providersFile, JSON.stringify({ qwen: { enabled: true, apiKey: 'test-private-not-real', defaultModel: 'qwen-plus' } }));
  let time = 1000;
  const setup = await createApiSetup({ ...paths, now: () => time });
  await setup.handle('/api add');
  assert.match((await setup.handle('/api delete 5')).text, /先 \/api cancel/);
  await setup.handle('/api cancel');
  await setup.handle('/api delete 5');
  time += 11 * 60 * 1000;
  assert.match((await setup.handle('确认')).text, /已中断/);
  assert.equal((await configuredApiModels(paths)).length, 1);
  const recovered = await createApiSetup(paths);
  assert.match((await recovered.handle('确认')).text, /已中断/);
  await recovered.handle('/api cancel');
  assert.equal((await recovered.handle('hello')).handled, false);
  assert.equal((await configuredApiModels(paths)).length, 1);
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
