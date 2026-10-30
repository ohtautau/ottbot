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
    const topic = lookup.get(argument.toLowerCase().replace(/^[\/／]/, ''));
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
  const data = [headers, ...rows].map(row => row.map(clean));
  const width = Math.max(...data.map(row => displayWidth(row[0])));
  const line = row => row[0] + ' '.repeat(width - displayWidth(row[0])) + ' │ ' + row[1];
  return [line(data[0]), '─'.repeat(width + 1) + '┼────────', ...data.slice(1).map(line)].join('\n');
}

function tableSection(section) {
  if (section.includes('│')) return section;
  const lines = section.split('\n');
  const parts = [];
  let rows = [], kind = '';
  const flush = () => {
    if (rows.length) parts.push(textTable(kind === 'command' ? ['指令', '说明'] : ['项目', '内容'], rows));
    rows = []; kind = '';
  };
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const command = lines[i].match(/^指令：(.*)$/);
    const description = lines[i + 1]?.match(/^说明：(.*)$/);
    if (command && description) {
      if (kind && kind !== 'command') flush();
      kind = 'command'; rows.push([command[1], description[1]]); i++; continue;
    }
    const field = lines[i].match(/^([^：]{1,16})：(.+)$/);
    if (field) {
      if (kind && kind !== 'field') flush();
      kind = 'field'; rows.push([field[1], field[2]]); continue;
    }
    flush(); parts.push(lines[i]);
  }
  flush();
  return parts.join('\n\n');
}

export function notice(title, ...sections) {
  return `【${title}】\n\n${sections.filter(Boolean).map(tableSection).join('\n\n────────\n\n')}`;
}

export function commandItem(command, description) {
  return `指令：${command}\n说明：${description}`;
}

export function helpText(topic = '', state = '') {
  const entries = {
    model: ['模型选择',
      [commandItem('/m 1', '选择 Luna；也可发送 /m luna'), commandItem('/m 2', '选择 Sol；也可发送 /m sol'), commandItem('/m 3', '选择 Terra；也可发送 /m terra'), commandItem('/m 4', '选择 Astra；也可发送 /m astra')].join('\n\n'),
      commandItem('/m', '查看当前模型和可用参数。/模型、/model 与 /m 等价。'),
      [commandItem('/m 完整模型ID', '指定其他 Codex 模型。'), commandItem('/m 提供商/模型ID', '使用已配置的 API，例如 /m qwen/qwen-plus。')].join('\n\n'),
      'API 需先在服务器配置 Key；明确切换后计费，不自动回退。'],
    reasoning: ['推理设置',
      [commandItem('/r', '查看当前模型可用编号。'), commandItem('/r 2', '将推理强度设为中等。')].join('\n\n'),
      textTable(['参数', '说明'], [['0', '模型默认'], ['1', '低'], ['2', '中'], ['3', '高'], ['4', '超高'], ['5', '最大'], ['6', '极致']]),
      '编号固定，只能选择当前模型支持的档位；API 推理参数暂未接入。'],
    target: ['默认执行端',
      [commandItem('/t 服务器', '后续任务默认在服务器执行；英文参数为 srv。'), commandItem('/t 电脑', '后续任务默认在电脑执行；英文参数为 pc。'), commandItem('/t', '查看当前默认执行端。')].join('\n\n'),
      '切换默认只影响后续任务；电脑离线不会转交服务器。'],
    route: ['单次执行', [commandItem('/srv 任务内容', '本次交给服务器执行。'), commandItem('/pc 任务内容', '本次交给电脑执行。')].join('\n\n'), '支持多行任务；仅影响本次，不改变默认执行端。'],
    status: ['运行状态', commandItem('/st', '查看连接、登录、当前模型和推理档位。'), '状态不调用模型，不能验证实际额度。'],
    clear: ['清空上下文', commandItem('/cl', '清空微信短期对话上下文。'), '不删除微信聊天记录或博客数据。'],
  };
  if (topic === 'server' || topic === 'computer') topic = 'route';
  if (entries[topic]) return notice('指令帮助', ...entries[topic], state);
  return notice('指令帮助', state,
    '常用指令（中文 / 英文 / 缩写）\n\n' + [commandItem('/帮助 /help /h', '查看全部帮助。'), commandItem('/状态 /status /st', '查看运行状态。'), commandItem('/模型 /model /m', '查看或切换模型。'), commandItem('/推理 /reasoning /r', '查看或调整推理强度。'), commandItem('/执行 /target /t', '设置默认执行端。'), commandItem('/服务器 /server /srv', '指定本次在服务器执行。'), commandItem('/电脑 /computer /pc', '指定本次在电脑执行。'), commandItem('/清空 /clear /cl', '清空微信短期上下文。')].join('\n\n'),
    '快速示例\n\n' + [commandItem('/m 2', '选择 Sol。'), commandItem('/r 2', '推理设为中等。'), commandItem('/t pc', '默认在电脑执行。'), commandItem('/h r', '查看推理主题帮助。')].join('\n\n'),
    '规则\n指令以 / 开头，命令和参数用空格分隔。\n英文命令忽略大小写，也支持全角 ／。\n未知或错误指令只返回提示，不交给 AI。\n裸数字和正文中的 / 保持普通聊天。\n设置指令不调用模型，保存后下一条任务生效。');
}
