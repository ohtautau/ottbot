import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOttlogCommands } from './ottlog-commands.mjs';
import { createOttlogClient } from './ottlog-client.mjs';
import { parseCommand } from './commands.mjs';
import { isTodoState, isMemoState } from './ottlog-shared.mjs';

const stamp = '2026-10-30T02:00:00.000Z';
const task = (id, title, important = true, urgent = true) => ({ id, title, important, urgent, categoryId: '', description: '', tags: [], subtasks: [], nextTasks: [], dueDate: '', completedAt: null, createdAt: stamp, updatedAt: stamp });
async function fixture(run) {
  const folder = await mkdtemp(join(tmpdir(), 'ottbot-ottlog-'));
  const data = { todos: { version: 1, tasks: [task('old', '已有任务', false, false)], categories: [], customField: 'preserve' }, memos: { version: 1, notes: [] }, reminders: { version: 1, items: [], done: {} } };
  const client = { owner: 'reader:test', read: async key => structuredClone(data[key]), write: async (key, previous, next) => { assert.deepEqual(previous, data[key]); data[key] = structuredClone(next); } };
  const options = { stateFile: join(folder, 'state.json'), clientFactory: async () => client, now: () => new Date(stamp) };
  try { await run(await createOttlogCommands(options), data, options, folder); } finally { await rm(folder, { recursive: true, force: true }); }
}

test('blog parser preserves text and supports hi, node/note spellings', () => {
  for (const text of ['hi', 'HI', 'Hi', ' hI ']) assert.equal(parseCommand(text).type, 'today');
  assert.equal(parseCommand('hi there'), null);
  assert.deepEqual(parseCommand('/todo 任务 名\n内容'), { type: 'todo', value: '任务 名\n内容' });
  for (const text of ['/nodeimg', '/node img', '/note img', '/noteimg']) assert.equal(parseCommand(text).type, 'noteimg');
  for (const text of ['/node', '/nodelist', '/node list', '/note', '/notelist']) assert.equal(parseCommand(text).type, 'note');
});

test('task numbers survive reload, duplicate names refuse completion, and shared recurrence logic is reused', async () => fixture(async (handler, data, options) => {
  await handler.handle('/todo 新任务');
  assert.equal(data.todos.tasks[0].important, true); assert.equal(data.todos.tasks[0].urgent, true);
  assert.equal(data.todos.tasks.length, 2); assert.equal(data.todos.customField, 'preserve'); assert.ok(isTodoState(data.todos));
  const menu = (await handler.handle('/todo list')).text;
  for (const title of ['高优先级', '中优先级', '低优先级', '无优先级']) assert.ok(menu.includes(title));
  const number = menu.match(/(\d+)\. 新任务/)[1];
  const recovered = await createOttlogCommands(options);
  await recovered.handle('/done ' + number);
  assert.ok(data.todos.tasks.find(t => t.title === '新任务').completedAt);
  data.todos.tasks.push(task('dup1', '重名'), task('dup2', '重名'));
  assert.match((await recovered.handle('/done 重名')).text, /同名/);
  assert.equal(data.todos.tasks.filter(t => t.title === '重名' && t.completedAt).length, 0);
  const cycle = task('cycle', '循环任务'); cycle.dueDate = '2026-10-30'; cycle.recurrence = { unit: 'day', interval: 1 };
  data.todos.tasks.push(cycle);
  await recovered.handle('/done 循环任务');
  assert.ok(data.todos.tasks.find(t => t.generatedFrom === 'cycle' && t.dueDate === '2026-10-31'));
}));

test('today uses UTC+8 and caps each section at three; reminders follow never-checked then longest gap', async () => fixture(async (handler, data) => {
  data.todos.tasks.push(task('high', '优先任务'), { ...task('future', '未来任务'), dueDate: '2026-11-10' });
  data.reminders.items = [
    ['night', '夜间习惯', 'night', 'high'], ['morning', '上午习惯', 'morning', 'low'], ['done', '已完成习惯', 'morning', 'high'], ['never', '从未打卡', 'free', 'none'], ['disabled', '停用习惯', 'morning', 'high'],
  ].map(([id, title, timePeriod, priority]) => ({ id, title, timePeriod, priority, kind: 'notes', group: '生活', note: '', minutes: 0, enabled: id !== 'disabled' }));
  data.reminders.done['2026-10-30'] = ['done'];
  const text = (await handler.handle('HI')).text;
  assert.ok(text.includes('2026-10-30') && text.includes('优先任务'));
  assert.ok(!text.includes('未来任务') && !text.includes('已完成习惯') && !text.includes('停用习惯'));
  const part = text.split('今日未完成习惯')[1].split('习惯提醒')[0];
  assert.ok(part.indexOf('上午习惯') < part.indexOf('夜间习惯'));
  assert.equal((part.match(/\d+\./g) || []).length, 3);
}));

test('notes preserve content, list ten, and image mode exits before processing non-image commands', async () => fixture(async (handler, data) => {
  await handler.handle('/note 标题\n正文');
  assert.equal(data.memos.notes[0].title, '标题'); assert.equal(data.memos.notes[0].body, '正文');
  assert.ok(isMemoState(data.memos));
  await handler.handle('/nodeimg'); assert.equal(handler.imageMode, true);
  await handler.handle('', { hasImages: true, readImages: async () => [{ id: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] });
  assert.equal(data.memos.notes[0].images.length, 1);
  assert.equal(handler.imageMode, true);
  await handler.handle('/todo 退出后新增'); assert.equal(handler.imageMode, false);
  assert.ok(data.todos.tasks.some(t => t.title === '退出后新增'));
  await handler.handle('/noteimg');
  assert.equal((await handler.handle('普通对话')).handled, false); assert.equal(handler.imageMode, false);
  for (let i = 0; i < 11; i++) await handler.handle('/note 便签' + i);
  const list = (await handler.handle('/node list')).text;
  assert.equal((list.match(/\d+\./g) || []).length, 10);
}));

test('blog client refuses changed accounts and concurrent snapshot changes, never issuing unsafe PUT', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ottbot-client-'));
  const configFile = join(folder, 'config.json');
  await writeFile(configFile, JSON.stringify({ origin: 'https://blog.example', expectedUserName: 'owner', expectedAdmin: false, cookies: { session: 'test-not-real-cookie' } }));
  let puts = 0, username = 'other';
  const client = await createOttlogClient(configFile, async (url, init) => {
    if (init.method === 'PUT') puts++;
    return new Response(JSON.stringify(url.pathname.endsWith('/session') ? { authenticated: true, userName: username, isAdmin: false, csrfToken: 'test-csrf' } : { data: { changed: true } }));
  });
  try {
    await assert.rejects(client.read('todos'), /账号不匹配/);
    username = 'owner';
    await assert.rejects(client.write('todos', { old: true }, { next: true }), /其他设备修改/);
    assert.equal(puts, 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
