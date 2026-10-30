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
  if (!/^[\/／]/.test(value) || /^[\/／]{2}/.test(value)) return null;
  const match = value.match(/^[\/／]([^\s\/／]+)(?:\s+([\s\S]*))?$/);
  const type = lookup.get(match?.[1].toLowerCase());
  if (!type) return { type: 'error', message: '未知指令。发送 /帮助 或 /h 查看用法；发送以 // 开头的内容可作为普通聊天。' };
  let argument = (match[2] || '').trim();
  if (['server', 'computer'].includes(type)) return { type: 'route', target: type, text: argument };
  if (['status', 'clear'].includes(type)) {
    return argument ? { type: 'error', message: `/${match[1]} 不接受参数。发送 /h 查看用法。` } : { type };
  }
  if (argument && /\s/.test(argument)) return { type: 'error', message: '该设置指令只接受一个参数。示例：/m sol、/r 2、/t pc。' };
  if (type === 'help' && argument) {
    const name = argument.toLowerCase().replace(/^[\/／]/, '');
    const topic = ['a', 'alias', 'aliases', '别名'].includes(name) ? 'aliases'
      : ['syntax', 'notation', '语法', '约定'].includes(name) ? 'syntax' : lookup.get(name);
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
  return entry ? entry[0][0].toUpperCase() + entry[0].slice(1) : model;
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
  ]), `默认：${state.target === 'computer' ? '电脑' : '服务器'}\n模型：${modelLabel(state.model)}\n推理：${state.effortText}`, commandItem('/h', '帮助'));
}

export function helpText(topic = '', state = {}, detailed = false) {
  const model = state.model || '';
  const current = model ? `当前：${modelLabel(model)}` : '';
  const choices = Object.values(MODEL_CHOICES).map(alias => MODELS[alias]);
  if (topic === 'syntax') return notice('用法约定', commandRows([
    ['<参数>', '必填'], ['[参数]', '可选'], ['选项A|选项B', '二选一'],
  ]), commandRows([
    ['/srv <任务>', '必须填写任务'], ['/h [主题]', '省略主题查看总帮助'], ['/t [服务器|电脑]', '填写时二选一，省略则查看'],
  ]), '说明：括号不用输入；| 两侧只选一个。\n示例：/srv 查看目录、/h、/h m、/t 电脑');
  if (topic === 'model') {
    const menu = compactRows(choices.map((id, index) => [`模型${['一', '二', '三', '四'][index]}`, `/m ${index + 1}  ${modelLabel(id)}${id === model ? '  ← 当前' : ''}`]));
    return detailed ? notice('模型用法', current, menu,
      '用法：/m [模型]\n说明：省略参数查看，填写参数切换。\n同一选择可用：/m 2、/m sol、/模型 2',
      '其他 Codex 模型：/m <模型ID>\n已配置的 API：/m <提供商>/<模型ID>\n示例：/m qwen/qwen-plus',
      '说明：API 需先配置 Key，按提供商计费；不自动回退。')
      : notice('模型', current, menu, '示例：/m 2 选择 Sol\n英文参数与 API：/h m');
  }
  if (topic === 'reasoning') return notice('推理用法', commandRows([
    ['/r', '查看本模型可用档位'], ['/r 2', '中等推理'], ['/r auto', '模型默认'],
  ]), '用法：/r [档位]\n参数：支持中文、英文，例如 /推理 中、/r medium。\n编号：固定；不支持的档位不会保存。\n限制：API 通道的推理参数暂未接入。');
  if (topic === 'target') return notice('默认执行端', state.target ? `当前：${state.target === 'computer' ? '电脑' : '服务器'}` : '',
    compactRows([['服务器', '/t srv' + (state.target === 'server' ? '  ← 当前' : '')], ['电脑', '/t pc' + (state.target === 'computer' ? '  ← 当前' : '')]]),
    detailed ? '用法：/t [服务器|电脑]\n说明：省略参数查看，填写时二选一。\n别名：/执行 服务器、/t 电脑。\n说明：只影响后续任务；电脑离线不转交其他机器。\n单次指定：/srv <任务> 或 /pc <任务>' : '单次指定：/srv <任务> 或 /pc <任务>\n说明：电脑离线不转交其他机器。');
  if (['route', 'server', 'computer'].includes(topic)) return notice('单次执行', commandRows([
    ['/srv <任务>', '交给服务器'], ['/pc <任务>', '交给电脑'],
  ]), '说明：可写多行任务；不改变默认执行端。');
  if (topic === 'status') return notice('状态用法', commandItem('/st', '查看连接与当前设置'), '说明：连接正常不代表模型额度充足。');
  if (topic === 'clear') return notice('清空用法', commandItem('/cl', '清空微信短期上下文'), '保留：微信聊天记录和博客数据。');
  if (topic === 'aliases') return notice('指令别名', commandRows(COMMANDS.map(item => {
    return [item.aliases.filter(alias => /^[a-z?]+$/.test(alias)).map(alias => '/' + alias).join('  '), item.aliases.filter(alias => /[\u4e00-\u9fff]/.test(alias)).join('、')];
  })), '说明：每行写法等价；英文命令忽略大小写。');
  return notice('帮助', commandRows([
    ['/st', '查看状态'], ['/m [模型]', '查看或切换模型'], ['/r [档位]', '查看或调整推理'], ['/t [执行端]', '查看或设置默认端'],
    ['/srv <任务>', '服务器任务'], ['/pc <任务>', '电脑任务'], ['/cl', '清空上下文'],
    ['/h m', '模型用法'], ['/h r', '推理用法'], ['/h t', '执行端用法'], ['/h 语法', '参数约定'],
  ]), '示例：/m 2、/r 2、/t pc\n中文 / 英文 / 缩写：/h a');
}
