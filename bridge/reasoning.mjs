import { readFile } from 'node:fs/promises';
import { MODELS } from './models.mjs';
import { notice, commandItem } from './commands.mjs';

const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const NUMBERED = Object.freeze({ '0': 'auto', '1': 'low', '2': 'medium', '3': 'high', '4': 'xhigh', '5': 'max', '6': 'ultra' });
const LABELS = { auto: '模型默认', none: '不推理', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大', ultra: '极致' };
const ALIASES = { ...NUMBERED, '低': 'low', '中': 'medium', '高': 'high', '超高': 'xhigh', '最大': 'max', '极致': 'ultra', '默认': 'auto', default: 'auto' };

export function effortLabel(effort) {
  const number = Object.keys(NUMBERED).find(key => NUMBERED[key] === effort);
  return `${number === undefined ? '' : number + ' · '}${effort}（${LABELS[effort] || effort}）`;
}

export function resolveEffort(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const effort = Object.hasOwn(ALIASES, text) ? ALIASES[text] : text;
  return ['auto', ...LEVELS].includes(effort) ? effort : null;
}

export async function reasoningOptions(config, model) {
  if (model.includes('/')) return [];
  if (config.modelCacheFile) {
    try {
      const cache = JSON.parse(await readFile(config.modelCacheFile, 'utf8'));
      const item = cache.models?.find(entry => entry.slug === model);
      const levels = item?.supported_reasoning_levels?.map(entry => entry.effort).filter(level => LEVELS.includes(level));
      if (levels?.length) return ['auto', ...new Set(levels)];
    } catch { /* Missing metadata never grants a level beyond the known model baseline. */ }
  }
  if (!Object.values(MODELS).includes(model)) return ['auto'];
  const levels = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
  return model === MODELS.luna ? levels : [...levels, 'ultra'];
}

export async function reasoningHelp(config, model, effort) {
  if (model.includes('/')) return '当前为 API 通道，尚未接入提供商各自的推理参数；/推理 不会修改或发送 API 参数。切回 Codex 后可设置。';
  const options = await reasoningOptions(config, model);
  const menu = options.map(level => commandItem('/r ' + (Object.keys(NUMBERED).find(number => NUMBERED[number] === level) ?? level), effortLabel(level) + (level === effort ? ' ← 当前' : ''))).join('\n\n');
  return notice('推理设置', `当前推理强度：${effortLabel(effort)}`, `可用档位（编号固定，不随模型变化）：\n${menu}`, commandItem('/r ' + (options.includes('medium') ? '2' : '0'), options.includes('medium') ? '设为中等；也可发送 /r medium 或 /推理 中。' : '使用模型默认推理强度。'), '生效：下一条任务\n保存：重启保留\n消耗：设置本身不调用模型；较高档位通常更慢、消耗更多额度。');
}
