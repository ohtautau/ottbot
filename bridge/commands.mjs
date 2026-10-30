import { MODELS, MODEL_CHOICES } from './models.mjs';

// Single command registry shared by the channel, router and workers.
export const COMMANDS = Object.freeze([
  { type: 'help', aliases: ['帮助', 'help', 'h', '?'] },
  { type: 'status', aliases: ['状态', 'status', 'st'] },
  { type: 'model', aliases: ['模型', 'model', 'm'] },
  { type: 'reasoning', aliases: ['推理', '思考', 'reasoning', 'effort', 'r', 're'] },
  { type: 'target', aliases: ['执行', '执行端', 'target', 't', 'use'] },
  { type: 'server', aliases: ['服务器', 'server', 'srv', 's'] },
  { type: 'computer', aliases: ['电脑', '本机', 'computer', 'pc', 'c'] },
  { type: 'clear', aliases: ['清空', '清除', 'clear', 'cl'] },
  { type: 'api', aliases: ['接口', 'api', 'ap'] },
  { type: 'today', aliases: ['今日', 'today'] },
  { type: 'todo', aliases: ['任务', '待办', 'todo', 'todolist'] },
  { type: 'done', aliases: ['完成', 'done'] },
  { type: 'note', aliases: ['便签', 'note', 'notelist', 'node', 'nodelist'] },
  { type: 'noteimg', aliases: ['图片便签', 'noteimg', 'nodeimg'] },
]);
const lookup = new Map();
for (const item of COMMANDS) for (const alias of item.aliases) {
  if (lookup.has(alias)) throw new Error('Duplicate command alias: ' + alias);
  lookup.set(alias, item.type);
}

export function resolveTarget(value) {
  const name = String(value || '').toLowerCase();
  const type = lookup.get(name);
  return ['server', 'computer'].includes(type) ? type : null;
}

export function parseCommand(text) {
  const value = String(text || '').trim();
  if (/^hi$/i.test(value)) return { type: 'today' };
  if (!/^[\/／]/.test(value) || /^[\/／]{2}/.test(value)) return null;
  const match = value.match(/^[\/／]([^\s\/／]+)(?:\s+([\s\S]*))?$/);
  const type = lookup.get(match?.[1].toLowerCase());
  if (!type) return { type: 'error', message: '未知指令。发送 /帮助 或 /h 查看用法；发送以 // 开头的内容可作为普通聊天。' };
  let argument = (match[2] || '').trim();
  if (['today', 'todo', 'done', 'note', 'noteimg'].includes(type)) {
    if (type === 'note' && /^img$/i.test(argument)) return { type: 'noteimg' };
    if (['today', 'noteimg'].includes(type) && argument) return { type: 'error', message: '该指令不接受参数。' };
    return { type, value: argument };
  }
  if (type === 'api') return { type, value: argument };
  if (['server', 'computer'].includes(type)) return { type: 'route', target: type, text: argument };
  if (['status', 'clear'].includes(type)) {
    return argument ? { type: 'error', message: `/${match[1]} 不接受参数。发送 /h 查看用法。` } : { type };
  }
  if (argument && /\s/.test(argument)) return { type: 'error', message: '该设置指令只接受一个参数。示例：/m sol、/r 2、/t pc。' };
  if (type === 'help' && argument) {
    const name = argument.toLowerCase().replace(/^[\/／]/, '');
    const topic = ['a', 'alias', 'aliases', '别名'].includes(name) ? 'aliases' : lookup.get(name);
    return topic ? { type: 'help', value: topic } : { type: 'error', message: '未找到这个帮助主题。发送 /h 查看全部指令。' };
  }
  if (type === 'reasoning' || type === 'target' || /^(?:luna|sol|terra|astra|codex\/(?:luna|sol|terra|astra))$/i.test(argument)) argument = argument.toLowerCase();
  return argument ? { type, value: argument } : ['model', 'reasoning'].includes(type) ? { type, value: '' } : { type };
}

function displayWidth(value) {
  return [...value].reduce((width, char) => width + (/\p{Mark}/u.test(char) ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(char) || char.codePointAt(0) > 0xffff ? 2 : 1), 0);
}

export function textTable(headers, rows) {
  const clean = value => String(value).replace(/[\r\n│]/g, ' ').trim();
  const data = [...(headers ? [headers] : []), ...rows].map(row => row.map(clean));
  if (!data.length) return '';
  const width = Math.max(...data.map(row => displayWidth(row[0])));
  // Menu labels are Chinese: pad with ideographic spaces, not ASCII spaces.
  // Two ASCII spaces need not have the same rendered width as one CJK glyph.
  return data.map(row => row[0] + '\u3000'.repeat(Math.ceil((width - displayWidth(row[0])) / 2) + 2) + row[1]).join('\n');
}

export const compactRows = rows => textTable(null, rows);
export const commandRows = rows => compactRows(rows.map(([command, description]) => [description, command]));

// View builders supply their own sections. Do not guess structure from colons.
export function notice(title, ...sections) {
  return [`【${title}】`, ...sections.filter(Boolean).map(section => String(section).trim())].join('\n\n');
}

export function commandItem(command, description) {
  return commandRows([[command, description]]);
}

export function modelLabel(model = '') {
  const entry = Object.entries(MODELS).find(([, id]) => id === model);
  if (entry || !model.includes('/')) return `OpenAI · ${model}`;
  const index = model.indexOf('/');
  const provider = model.slice(0, index);
  const names = { deepseek: 'DeepSeek', qwen: 'Qwen', openai: 'OpenAI' };
  return `${Object.hasOwn(names, provider) ? names[provider] : provider} · ${model.slice(index + 1)}`;
}

function usageHelp(title, usage, purpose, parameters, examples, notes) {
  return notice(title, `用法：${usage}\n作用：${purpose}`, '参数：\n' + commandRows(parameters), '示例：\n' + commandRows(examples), '说明：' + notes);
}

export function settingNotice(label, value, note = '生效：下一条任务，重启保留。') {
  return notice('已设置', `${label}：${value}`, note);
}

export function statusText(state) {
  const login = state.authenticated === true ? '✓ 已登录' : state.authenticated === false ? '✗ 未登录' : '未验证';
  return notice('状态', compactRows([
    ['接收端', '✓ 在线'],
    ['服务器', state.serverOnline ? '✓ 在线' : '✗ 离线'],
    ['账号登录', login],
    ['电脑', state.computerOnline ? '✓ 在线' : '✗ 离线'],
  ]), `默认：${state.target === 'computer' ? '电脑' : '服务器'}\n模型：${modelLabel(state.model)}\n推理：${state.effortText}`);
}

export function helpText(topic = '', state = {}, detailed = false) {
  const model = state.model || '';
  const current = model ? `当前：${modelLabel(model)}` : '';
  const choices = Object.values(MODEL_CHOICES).map(alias => MODELS[alias]);
  if (topic === 'model') {
    const menu = compactRows(choices.map((id, index) => [`/m ${index + 1}`, modelLabel(id) + (id === model ? '  ← 当前' : '')]));
    if (detailed) return usageHelp('模型用法', '/m [模型]', '查看或切换后续对话模型。',
      [['省略', '查看模型菜单'], ['数字编号', '选择菜单中的模型'], ['提供商/模型ID', '已配置的 API 模型']],
      [['/m', '查看菜单'], ['/m 2', '切换模型'], ['/m qwen/qwen-plus', '选择已配置 API']],
      '[模型] 可选，括号不用输入。API 先用 /api add 配置；切换后按提供商计费，不自动回退。');
    const apis = (state.apiModels || []).map(item => [`/m ${item.number}`, modelLabel(item.model) + (item.model === model ? '  ← 当前' : '')]);
    return notice('模型', current, [menu, apis.length ? compactRows(apis) : ''].filter(Boolean).join('\n'));
  }
  if (topic === 'reasoning') return usageHelp('推理用法', '/r [档位]', '查看或修改后续任务的推理强度。',
    [['省略', '查看本模型可用档位'], ['0', '模型默认'], ['1 / 2 / 3', '低 / 中 / 高'], ['4 / 5 / 6', '超高 / 最大 / 极致']],
    [['/r', '查看档位'], ['/r 2', '设置中等'], ['/r auto', '使用模型默认']],
    '[档位] 可选，也可输入中文或英文名称。只接受本模型支持的档位；API 推理参数暂未接入。');
  if (topic === 'target' && detailed) return usageHelp('执行端用法', '/t [服务器|电脑]', '查看或设置后续任务的默认执行位置。',
    [['省略', '查看当前默认端'], ['服务器 / srv', '交给服务器'], ['电脑 / pc', '交给在线电脑']],
    [['/t', '查看默认端'], ['/t 电脑', '默认使用电脑'], ['/srv <任务>', '仅本次使用服务器']],
    '[参数] 可选，A|B 二选一，括号和 | 不用输入；<任务> 必填。');
  if (topic === 'target') return notice('默认执行端', state.target ? `当前：${state.target === 'computer' ? '电脑' : '服务器'}` : '',
    compactRows([['服务器', '/t srv' + (state.target === 'server' ? '  ← 当前' : '')], ['电脑', '/t pc' + (state.target === 'computer' ? '  ← 当前' : '')]]),
    detailed ? '用法：/t [服务器|电脑]\n说明：省略参数查看，填写时二选一。\n别名：/执行 服务器、/t 电脑。\n单次指定：/srv <任务> 或 /pc <任务>' : '单次指定：/srv <任务> 或 /pc <任务>');
  if (['route', 'server', 'computer'].includes(topic)) return notice('单次执行', commandRows([
    ['/srv <任务>', '交给服务器'], ['/pc <任务>', '交给电脑'],
  ]), '说明：可写多行任务；不改变默认执行端。');
  if (topic === 'status') return notice('状态用法', commandItem('/st', '查看连接与当前设置'), '说明：连接正常不代表模型额度充足。');
  if (topic === 'clear') return notice('清空用法', commandItem('/cl', '清空微信短期上下文'), '保留：微信聊天记录和博客数据。');
  if (['today', 'todo', 'done', 'note', 'noteimg'].includes(topic)) return notice('博客指令', '/today 或 hi：今日任务与习惯\n/todo <任务名>：增加高优先级任务\n/todo：四象限任务列表\n/done <编号或完整任务名>：完成任务\n/note <内容>：增加便签\n/note 或 /node：最近十条便签\n/noteimg 或 /nodeimg：保存后续图片为便签，发送非图片即退出');
  if (topic === 'api') return notice('API 配置', commandRows([
    ['/api add', '新增或修改提供商'], ['/api list', '查看已配置提供商'], ['/api delete <模型编号>', '确认后删除模型'], ['/api cancel', '取消配置'],
  ]), '说明：仅在绑定账号的微信私聊中配置。按提示填写提供商、接口、Key、模型；不回显 Key，不自动调用或切换。');
  if (topic === 'aliases') return notice('指令别名', commandRows(COMMANDS.map(item => {
    return [item.aliases.filter(alias => /^[a-z?]+$/.test(alias)).map(alias => '/' + alias).join('  '), item.aliases.filter(alias => /[\u4e00-\u9fff]/.test(alias)).join('、')];
  })), '说明：每行写法等价；英文命令忽略大小写。');
  return notice('帮助', commandRows([
    ['/st', '查看状态'], ['/m [模型]', '查看或切换模型'], ['/r [档位]', '查看或调整推理'], ['/t [执行端]', '查看或设置默认端'],
    ['/today', '今日任务习惯'], ['/todo [任务名]', '查看或新增任务'], ['/done <编号或任务名>', '完成任务'], ['/note [内容]', '查看或新增便签'], ['/noteimg', '图片保存到便签'],
    ['/srv <任务>', '服务器任务'], ['/pc <任务>', '电脑任务'], ['/cl', '清空上下文'],
    ['/api', '配置模型 API'], ['/h m', '模型用法'], ['/h r', '推理用法'], ['/h t', '执行端用法'], ['/h a', '指令别名'],
  ]));
}
