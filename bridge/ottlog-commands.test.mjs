import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOttlogCommands } from './ottlog-commands.mjs';
import { createOttlogClient } from './ottlog-client.mjs';
import { parseCommand, helpText } from './commands.mjs';
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
  assert.equal(parseCommand('/end').type, 'noteend');
  const help = helpText();
  const blogs = help.split('【博客工具】')[1].split('【帮助查询】')[0];
  const queries = help.split('【帮助查询】')[1].split('【其他操作】')[0];
  assert.ok(blogs.includes('/note') && !blogs.includes('/h '));
  assert.ok(queries.includes('/h note') && !queries.includes('/todo'));
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

test('today shows all eligible high-priority tasks and fills fewer than three by priority', async () => fixture(async (handler, data) => {
  data.todos.tasks = Array.from({ length: 4 }, (_, i) => task('high-' + i, '高任务' + i));
  data.todos.tasks.push(task('mid', '中任务', true, false), task('low', '低任务', false, true));
  let section = (await handler.handle('/today')).text.split('【优先任务】')[1].split('【今日未完成习惯】')[0];
  for (let i = 0; i < 4; i++) assert.ok(section.includes('高任务' + i));
  assert.ok(!section.includes('中任务') && !section.includes('低任务'));
  data.todos.tasks = data.todos.tasks.filter(t => t.id !== 'high-2' && t.id !== 'high-3');
  section = (await handler.handle('/today')).text.split('【优先任务】')[1].split('【今日未完成习惯】')[0];
  assert.equal((section.match(/\d+\./g) || []).length, 3);
  assert.ok(section.includes('中任务') && !section.includes('低任务'));
}));

test('note conversation appends to one note across restart and ends before another command', async () => fixture(async (handler, data, options) => {
  const opened = await handler.handle('/note 我的便签');
  assert.match(opened.text, /会话已开启/);
  const id = data.memos.notes[0].id;
  await handler.handle('第一段\n第二行');
  const recovered = await createOttlogCommands(options);
  assert.equal(recovered.noteMode, true);
  await recovered.handle('图片说明', { hasImages: true, readImages: async () => [{ id: 'img-1', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] });
  assert.equal(data.memos.notes.length, 1);
  assert.equal(data.memos.notes[0].id, id);
  assert.equal(data.memos.notes[0].body, '第一段\n第二行\n\n图片说明');
  assert.equal(data.memos.notes[0].images.length, 1);
  await recovered.prepareInput('/api add');
  assert.equal(recovered.noteMode, false);
  assert.equal((await recovered.handle('ordinary text')).handled, false);
  assert.equal(data.memos.notes[0].body.includes('ordinary'), false);
  await recovered.handle('/note 第二张');
  await recovered.handle('保存内容');
  assert.match((await recovered.handle('/end')).text, /会话已结束/);
  assert.equal(recovered.noteMode, false);
  assert.equal((await recovered.handle('next ordinary')).handled, false);
  assert.equal(data.memos.notes[0].body, '保存内容');
}));

test('note session expiration, deleted target and capacity errors do not corrupt saved notes', async () => fixture(async (handler, data, options) => {
  let time = Date.parse(stamp);
  const timed = await createOttlogCommands({ ...options, now: () => new Date(time) });
  await timed.handle('/note 超时便签');
  await timed.handle('到期前');
  time += 10 * 60 * 1000;
  assert.equal((await timed.handle('到期后')).handled, false);
  assert.equal(data.memos.notes[0].body, '到期前');
  await timed.handle('/note 图片上限');
  const target = data.memos.notes[0];
  target.images = Array.from({ length: 6 }, (_, i) => ({ id: 'image-' + i, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }));
  const snapshot = structuredClone(target);
  assert.match((await timed.handle('', { hasImages: true, readImages: async () => [{ id: 'extra', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] })).text, /本条未保存/);
  assert.deepEqual(data.memos.notes[0], snapshot);
  data.memos.notes = data.memos.notes.filter(n => n.id !== target.id);
  assert.match((await timed.handle('已删除不应重建')).text, /已被删除/);
  assert.equal(timed.noteMode, false);
}));

test('blog client refuses changed accounts and concurrent snapshot changes, never issuing unsafe PUT', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ottbot-client-'));
  const configFile = join(folder, 'config.json');
  await writeFile(configFile, JSON.stringify({ origin: 'https://blog.example', expectedUserName: 'owner', expectedAdmin: false, cookies: { session: 'test-not-real-cookie' } }));
  let puts = 0, username = 'other', authenticated = true;
  const client = await createOttlogClient(configFile, async (url, init) => {
    if (init.method === 'PUT') puts++;
    return new Response(JSON.stringify(url.pathname.endsWith('/session') ? { authenticated, userName: username, isAdmin: false, csrfToken: 'test-csrf' } : { data: { changed: true } }));
  });
  try {
    await assert.rejects(client.read('todos'), /账号不匹配/);
    authenticated = false; username = null;
    await assert.rejects(client.read('todos'), /登录已失效/);
    await assert.rejects(client.write('todos', {}, {}), /登录已失效/);
    authenticated = true;
    username = 'owner';
    await assert.rejects(client.write('todos', { old: true }, { next: true }), /其他设备修改/);
    assert.equal(puts, 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
