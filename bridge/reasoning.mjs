import { readFile } from 'node:fs/promises';
import { MODELS } from './models.mjs';
import { notice, compactRows } from './commands.mjs';

const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const NUMBERED = Object.freeze({ '0': 'auto', '1': 'low', '2': 'medium', '3': 'high', '4': 'xhigh', '5': 'max', '6': 'ultra' });
const LABELS = { auto: '模型默认', none: '不推理', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大', ultra: '极致' };
const ALIASES = { ...NUMBERED, '低': 'low', '中': 'medium', '高': 'high', '超高': 'xhigh', '最大': 'max', '极致': 'ultra', '默认': 'auto', default: 'auto' };

export function effortLabel(effort) {
  const number = Object.keys(NUMBERED).find(key => NUMBERED[key] === effort);
  return `${number === undefined ? '' : number + ' · '}${effort}（${LABELS[effort] || effort}）`;
}

export function effortShort(effort) {
  const number = Object.keys(NUMBERED).find(key => NUMBERED[key] === effort);
  return (LABELS[effort] || effort) + (number === undefined ? '' : `（${number}）`);
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
  if (model.includes('/')) return notice('推理', '当前为 API 通道，暂不支持修改推理参数。', '/m 2 切回 Codex');
  const options = await reasoningOptions(config, model);
  const menu = compactRows(options.map(level => [
    '/r ' + (Object.keys(NUMBERED).find(number => NUMBERED[number] === level) ?? level),
    (LABELS[level] || level) + (level === effort ? '  ← 当前' : ''),
  ]));
  return notice('推理', `当前：${effortShort(effort)}`, menu, '仅列出本模型支持的档位。\n档位越高通常越慢、越耗额度；用法见 /h r');
}
