import { readFile } from 'node:fs/promises';
import { MODELS } from './models.mjs';

const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const ALIASES = { '低': 'low', '中': 'medium', '高': 'high', '超高': 'xhigh', '最大': 'max', '极致': 'ultra', '默认': 'auto', default: 'auto' };

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
  return `当前推理强度：${effort}\n可用档位：${(await reasoningOptions(config, model)).join(' | ')}\n例如 /推理 medium；/推理 auto 使用模型默认值。修改从下一条任务生效，重启保留，不调用模型。档位越高通常更慢、消耗更多额度。`;
}
