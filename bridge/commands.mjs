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

export function notice(title, ...sections) {
  return `【${title}】\n\n${sections.filter(Boolean).join('\n\n────────\n\n')}`;
}

export function helpText(topic = '', state = '') {
  const entries = {
    model: ['模型 / model / m', '/m 查看模型\n/m sol 切换 Codex 模型\nluna · sol · terra · astra\n/m 提供商/模型ID 切换已配置 API', 'API 需先在服务器配置 Key；明确切换后计费，不自动回退。'],
    reasoning: ['推理 / reasoning / r', '/r 查看当前模型可用编号\n/r 2 设置为中等\n0 默认 · 1 低 · 2 中 · 3 高\n4 超高 · 5 最大 · 6 极致', '编号固定，只能选择当前模型支持的档位；API 推理参数暂未接入。'],
    target: ['执行端 / target / t', '/t 查看默认执行端\n/t srv 默认服务器\n/t pc 默认电脑', '切换默认只影响后续任务；电脑离线不会转交服务器。'],
    route: ['单次执行', '/srv 任务内容 → 服务器\n/pc 任务内容 → 电脑', '支持多行任务；仅影响本次，不改变默认执行端。'],
    status: ['状态 / status / st', '/st 查看连接、登录、当前模型和推理档位', '状态不调用模型，不能验证实际额度。'],
    clear: ['清空 / clear / cl', '/cl 清空微信短期对话上下文', '不删除微信聊天记录或博客数据。'],
  };
  if (topic === 'server' || topic === 'computer') topic = 'route';
  if (entries[topic]) return notice('指令帮助', ...entries[topic], state);
  return notice('指令帮助', state,
    '常用指令（中文 / 英文 / 缩写）\n1. 帮助 / help / h\n2. 状态 / status / st\n3. 模型 / model / m\n4. 推理 / reasoning / r\n5. 执行 / target / t\n6. 服务器 / server / srv\n7. 电脑 / computer / pc\n8. 清空 / clear / cl',
    '快速示例\n/m sol　切换模型\n/r 2　推理设为中等\n/t pc　默认在电脑执行\n/srv 任务内容　仅本次在服务器执行\n/h r　查看推理帮助',
    '规则\n指令以 / 开头，命令和参数用空格分隔。\n英文命令忽略大小写，也支持全角 ／。\n未知或错误指令只返回提示，不交给 AI。\n裸数字和正文中的 / 保持普通聊天。\n设置指令不调用模型，保存后下一条任务生效。');
}
