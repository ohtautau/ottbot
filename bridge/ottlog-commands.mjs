import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { notice, parseCommand } from './commands.mjs';
import { createOttlogClient } from './ottlog-client.mjs';
import { createTodo, completeTodo, todoQuadrants, isTodoState, isMemoState, initialTodoState, initialMemoState,
  cleanState, isReminderState, emptyReminderState, habitTimePeriod, habitTimePeriods, habitTimePeriodLabels,
  habitPriorities, longestUncheckedHabits, hasHabitDay, habitDayIndex, noteStateFits, validNoteImages } from './ottlog-shared.mjs';

const taskRank = task => { const rank = todoQuadrants.findIndex(q => q.important === task.important && q.urgent === task.urgent); return rank < 0 ? 3 : rank; };
const clip = (text, n = 220) => String(text || '').replace(/\s+/g, ' ').slice(0, n);
const dayKey = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const commands = ['today', 'todo', 'done', 'note', 'noteimg', 'noteend'];

export async function createOttlogCommands({ configFile, stateFile, clientFactory = () => createOttlogClient(configFile), compressImages, now = () => new Date() }) {
  let state = { numbers: {}, nextNumber: 1, imageUntil: 0 };
  try { state = { ...state, ...JSON.parse(await readFile(stateFile, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const persist = async () => { await writeFile(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 }); await rename(stateFile + '.tmp', stateFile); };
  async function bind(client) {
    if (state.owner !== client.owner) { state = { owner: client.owner, numbers: {}, nextNumber: 1, imageUntil: 0 }; await persist(); }
  }
  function ordered(tasks) { return tasks.filter(t => !t.completedAt).sort((a, b) => taskRank(a) - taskRank(b) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || (a.dueTime || '23:59').localeCompare(b.dueTime || '23:59') || a.createdAt.localeCompare(b.createdAt)); }
  async function number(tasks) {
    for (const task of tasks) if (!Object.hasOwn(state.numbers, task.id)) state.numbers[task.id] = state.nextNumber++;
    await persist();
  }
  const line = task => `${state.numbers[task.id]}. ${clip(task.title, 70)}${task.dueDate ? '（' + task.dueDate + (task.dueTime ? ' ' + task.dueTime : '') + '）' : ''}`;
  const taskCard = task => `${state.numbers[task.id]}. ${clip(task.title, 80)}${task.dueDate ? '（' + task.dueDate + (task.dueTime ? ' ' + task.dueTime : '') + '）' : ''}`;
  async function load(client, key, empty, validate) {
    const raw = await client.read(key);
    const data = raw === null ? structuredClone(empty) : raw;
    if (!validate(data)) throw new Error('博客数据格式不兼容，已停止读写，原数据保留。');
    return { raw, data };
  }
  async function note(client, text, images = []) {
    const { raw, data } = await load(client, 'memos', initialMemoState, isMemoState);
    const stamp = now().toISOString(), first = text.split('\n')[0];
    const item = { id: 'bot-' + randomUUID(), title: first.slice(0, 80), body: first.length > 80 ? text : text.split('\n').slice(1).join('\n'),
      color: 'sand', priority: 'none', tags: [], pinned: false, images, createdAt: stamp, updatedAt: stamp };
    const next = { ...data, notes: [item, ...data.notes] };
    if (!validNoteImages(images) || !noteStateFits(next)) throw new Error('便签图片或总容量过大，请压缩图片或整理旧便签。');
    await client.write('memos', raw, next);
    return { item, text: notice('便签已保存', images.length ? `图片：${images.length} 张` : `内容：${clip(text)}`) };
  }
  async function prepareInput(text, { hasImages = false } = {}) {
    let changed = false;
    const command = parseCommand(text);
    if (!hasImages && state.imageUntil && command?.type !== 'noteend') { state.imageUntil = 0; changed = true; }
    if (state.noteSession && (state.noteSession.until <= now().getTime() || command && command.type !== 'noteend')) {
      delete state.noteSession; changed = true;
    }
    if (changed) await persist();
  }
  return {
    prepareInput,
    handles(text) { return commands.includes(parseCommand(text)?.type); },
    get imageMode() { return state.imageUntil > now().getTime(); },
    get noteMode() { return state.noteSession?.until > now().getTime(); },
    async handle(text, { hasImages = false, readImages } = {}) {
      let command = parseCommand(text);
      await prepareInput(text, { hasImages });
      if (command?.type === 'noteend') {
        const active = Boolean(state.noteSession || state.imageUntil);
        delete state.noteSession; state.imageUntil = 0; await persist();
        return { handled: true, text: notice('便签会话已结束', active ? '内容：已保存的文字和图片保留。' : '当前：没有正在编辑的便签。') };
      }
      if (!commands.includes(command?.type) && !this.imageMode && !this.noteMode) return { handled: false };
      try {
        const client = await clientFactory(); await bind(client);
        if (!command && !this.imageMode && !this.noteMode) return { handled: true, text: notice('便签会话已退出', '账号已变化，请重新开始。') };
        if (this.noteMode) {
          if (!text.trim() && !hasImages) throw new Error('便签会话支持文字和图片，请重新发送。');
          const { raw, data } = await load(client, 'memos', initialMemoState, isMemoState);
          const current = data.notes.find(n => n.id === state.noteSession.id);
          if (!current) { delete state.noteSession; await persist(); throw new Error('正在编辑的便签已被删除，会话已结束。'); }
          const images = hasImages ? await readImages() : [];
          const compressed = compressImages ? await compressImages(images) : images;
          const item = { ...current, body: [current.body, text.trim()].filter(Boolean).join('\n\n'), images: [...(current.images || []), ...compressed], updatedAt: now().toISOString() };
          const next = { ...data, notes: data.notes.map(n => n.id === item.id ? item : n) };
          if (!validNoteImages(item.images) || !noteStateFits(next)) throw new Error('便签最多6张图片且总容量有限；本条未保存，原内容保留。');
          await client.write('memos', raw, next);
          return { handled: true, text: notice('便签已追加', `便签：${clip(item.title, 80)}\n内容：${hasImages ? '图片已保存' : '文字已保存'}`, '结束：/end') };
        }
        if (this.imageMode && hasImages) {
          const images = await readImages();
          const compressed = compressImages ? await compressImages(images) : images;
          return { handled: true, text: (await note(client, text, compressed)).text };
        }
        if (command?.type === 'noteimg') {
          state.imageUntil = now().getTime() + 10 * 60 * 1000; await persist();
          return { handled: true, text: notice('保存图片到便签', '请发送图片，每条图片消息保存为一条便签。\n退出：发送任意非图片消息，会退出并正常处理该消息。\n有效期：10分钟。') };
        }
        if (hasImages) throw new Error('此指令请单独发送文字；保存图片先发 /noteimg。');
        if (command.type === 'note') {
          if (command.value && command.value.toLowerCase() !== 'list') {
            if (command.value.split('\n')[0].length > 80) throw new Error('便签名最多80字。');
            const saved = await note(client, command.value);
            state.imageUntil = 0; state.noteSession = { id: saved.item.id, until: now().getTime() + 10 * 60 * 1000 };
            await persist();
            return { handled: true, text: notice('便签会话已开启', `便签：${saved.item.title}\n后续：直接发送文字或图片，将追加到这张便签。`, '保存：每条消息立即保存。\n结束：/end、其他指令或10分钟到期。') };
          }
          const { data } = await load(client, 'memos', initialMemoState, isMemoState);
          const notes = [...data.notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
          return { handled: true, text: notice('最近便签', notes.length ? notes.map((n, i) => `${i + 1}. ${clip([n.title, n.body].filter(Boolean).join(' · '))}${n.images?.length ? '（图片' + n.images.length + '张）' : ''}`).join('\n\n') : '当前：暂无便签。') };
        }
        const { raw, data } = await load(client, 'todos', initialTodoState, isTodoState);
        const tasks = ordered(data.tasks); await number(tasks);
        if (command.type === 'todo') {
          if (command.value && command.value.toLowerCase() !== 'list') {
            if (command.value.length > 80) throw new Error('任务名最多80字。');
            if (data.tasks.length >= 200) throw new Error('任务数量已达上限，请先整理任务。');
            const task = { ...createTodo('do', now()), title: command.value };
            await client.write('todos', raw, { ...data, tasks: [task, ...data.tasks] }); await number([task]);
            return { handled: true, text: notice('任务已添加', line(task), '优先级：高 · 重要且紧急') };
          }
          return { handled: true, text: notice('任务列表', ...todoQuadrants.map(q => `【${q.title}】\n\n${tasks.filter(t => t.important === q.important && t.urgent === q.urgent).map(taskCard).join('\n\n') || '暂无任务'}`)) };
        }
        if (command.type === 'done') {
          if (!command.value) throw new Error('用法：/done <任务编号或完整任务名>');
          const matches = tasks.filter(t => /^\d+$/.test(command.value) ? state.numbers[t.id] === Number(command.value) : t.title.trim().toLowerCase() === command.value.toLowerCase());
          if (!matches.length) throw new Error('未找到未完成任务，发送 /todo 查看编号。');
          if (matches.length > 1) return { handled: true, text: notice('存在同名任务', matches.map(line).join('\n'), '请使用编号：/done <编号>') };
          const next = completeTodo(data, matches[0].id, now());
          await client.write('todos', raw, next);
          return { handled: true, text: notice('任务已完成', line(matches[0])) };
        }
        const { data: savedHabits } = await load(client, 'reminders', emptyReminderState, isReminderState);
        const habits = cleanState(savedHabits), day = dayKey(now()), ordinal = habitDayIndex(day);
        const done = Object.hasOwn(habits.done, day) ? new Set(habits.done[day]) : null;
        const unfinished = habits.items.filter(h => h.enabled && !(done ? done.has(h.id) : hasHabitDay(habits.completionHistory?.[h.id], ordinal)));
        const scheduled = [...unfinished].sort((a, b) => habitTimePeriods.indexOf(habitTimePeriod(a)) - habitTimePeriods.indexOf(habitTimePeriod(b)) || habitPriorities.indexOf(a.priority || 'none') - habitPriorities.indexOf(b.priority || 'none')).slice(0, 3);
        const reminders = longestUncheckedHabits(habits, now().getTime()).slice(0, 3);
        const candidates = tasks.filter(t => !t.dueDate || t.dueDate <= day);
        const todayTasks = candidates.slice(0, Math.max(3, candidates.filter(t => taskRank(t) === 0).length));
        const habitLine = (h, i) => `${i + 1}. ${clip(h.title, 70)}（${habitTimePeriodLabels[habitTimePeriod(h)]} · ${{ high: '高', medium: '中', low: '低', none: '无' }[h.priority || 'none']}）`;
        return { handled: true, text: notice('今日 · ' + day, '【优先任务】\n\n' + (todayTasks.map(line).join('\n') || '暂无待办任务'),
          '【今日未完成习惯】\n\n' + (scheduled.map(habitLine).join('\n') || '今天的习惯已完成或暂无习惯'),
          '【习惯提醒】\n\n' + (reminders.map(habitLine).join('\n') || '暂无提醒')) };
      } catch (error) { return { handled: true, text: notice('未完成', error.message) }; }
    },
  };
}
