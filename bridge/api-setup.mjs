import { readFile, writeFile, mkdir, rename, rm, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { notice, compactRows, parseCommand } from './commands.mjs';
import { API_MODEL_ID as MODEL } from './models.mjs';

const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED = ['codex', 'constructor', 'prototype', '__proto__'];
const PROMPTS = [
  '步骤：1/4 · 提供商\n请输入英文标识，例如 deepseek、qwen、openai。',
  '步骤：2/4 · 接口地址\n请输入完整 HTTPS Chat Completions 地址，以 /chat/completions 结尾。',
  '步骤：3/4 · API Key\n请发送该提供商的 Key。不会回显或交给模型。\n说明：微信聊天记录仍可能保留这条消息。',
  '步骤：4/4 · 模型名称\n请输入提供商要求的完整模型 ID，例如 qwen-plus。',
];

async function readProviders(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('配置文件暂时无法读取；未覆盖原配置。');
  }
}

async function atomicPrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const next = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(next, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(next, path);
  } finally { await rm(next, { force: true }); }
}

export function validateEndpoint(value) {
  if (value.length > 2048) throw new Error('接口地址过长，最多2048个字符。');
  let url;
  try { url = new URL(value); } catch { throw new Error('地址格式不正确，请重新输入 HTTPS 接口地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
      || !url.pathname.endsWith('/chat/completions')) {
    throw new Error('需填写完整 HTTPS 地址，不能带账号、密码、查询参数或锚点，路径以 /chat/completions 结尾。');
  }
  return url.href;
}

export async function createApiSetup({ providersFile, pendingFile, now = Date.now }) {
  let draft = null;
  let blocked = false;
  try { await access(pendingFile); blocked = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = text => ({ handled: true, text });
  const prompt = () => notice('API 配置', PROMPTS[draft.stage], '取消：/api cancel');
  async function finish() {
    await rm(pendingFile, { force: true });
    draft = null; blocked = false;
  }
  return {
    async handle(text, hasAttachments = false) {
      const command = parseCommand(text);
      const isApi = command?.type === 'api';
      if (!isApi && !draft && !blocked) return { handled: false };
      // This handler must run only after the channel's owner/private-chat check.
      if (hasAttachments) return result(notice('API 配置', '说明：配置只接受文字，本条内容未交给模型。', '取消：/api cancel'));
      const parts = isApi ? (command.value || '').split(/\s+/).filter(Boolean) : [];
      const action = (parts[0] || '').toLowerCase();
      if (isApi && ['cancel', '取消', '退出'].includes(action)) {
        await finish();
        return result(notice('已取消', '说明：未保存的配置已清除，后续恢复普通对话。'));
      }
      if (isApi && ['add', 'set', '新增', '配置', '设置'].includes(action)) {
        if (parts.length !== 1) return result(notice('API 配置', '用法：单独发送 /api add，然后按步骤填写。'));
        await atomicPrivate(pendingFile, { active: true }); // No key or draft values on disk.
        blocked = true;
        draft = { stage: 0, values: {}, expires: now() + 10 * 60 * 1000 };
        return result(prompt());
      }
      if (isApi && ['list', '列表'].includes(action)) {
        try {
          const providers = await readProviders(providersFile);
          const rows = Object.entries(providers).filter(([id]) => PROVIDER.test(id) && !RESERVED.includes(id)).map(([id, item]) => [id, `${item.enabled ? '已启用' : '未启用'} · ${typeof item.defaultModel === 'string' && MODEL.test(item.defaultModel) ? item.defaultModel : '模型未设'} · Key${item.apiKey ? '已填写' : '未填写'}`]);
          return result(notice('API 列表', rows.length ? compactRows(rows) : '当前：尚无已配置提供商。', '配置：/api add\n切换：/m 提供商/模型ID'));
        } catch { return result(notice('配置失败', '说明：无法读取配置，原配置保持。')); }
      }
      if (draft && now() > draft.expires) draft = null;
      if (!draft) {
        if (blocked) return result(notice('配置已中断', '说明：本条内容未交给模型。配置可能超时或服务已重启。', '重新开始：/api add\n退出配置：/api cancel'));
        return result(notice('API 配置', compactRows([['新增或修改', '/api add'], ['查看提供商', '/api list'], ['取消配置', '/api cancel']]), '支持：OpenAI 兼容 Chat Completions API。\n说明：配置不调用 API，也不会自动切换模型。'));
      }
      const confirm = draft.stage === 4 && ((!isApi && ['确认', '保存'].includes(text.trim())) || (isApi && ['save', 'confirm', '保存', '确认'].includes(action)));
      if (confirm) {
        const { provider, endpoint, apiKey, model } = draft.values;
        try {
          const providers = await readProviders(providersFile);
          const previous = Object.hasOwn(providers, provider) ? providers[provider] : {};
          const ids = [...new Set([...(Array.isArray(previous.models) ? previous.models.filter(id => typeof id === 'string' && MODEL.test(id)) : []), ...(typeof previous.defaultModel === 'string' && MODEL.test(previous.defaultModel) ? [previous.defaultModel] : []), model])];
          providers[provider] = { ...previous, enabled: true, endpoint, apiKey, defaultModel: model, models: ids, images: previous.images === true, maxTokens: previous.maxTokens || 2048 };
          await atomicPrivate(providersFile, providers);
          await finish();
          return result(notice('API 已保存', `提供商：${provider}\n模型版本：${model}\nAPI Key：已保存，不回显`, `执行端：先发送 /t srv\n切换：/m ${provider}/${model}\n说明：尚未切换；明确选择后按 API 计费。`));
        } catch { return result(notice('保存失败', '说明：配置流程仍保留，请重试确认或 /api cancel。')); }
      }
      if (isApi || /^[/／]/.test(text.trim())) return result(notice('API 配置中', '说明：本条消息未交给模型。请按当前步骤输入，或 /api cancel 退出。', draft.stage < 4 ? PROMPTS[draft.stage] : '保存：发送“确认”或 /api save'));
      if (draft.stage === 4) return result(notice('等待确认', '保存：发送“确认”或 /api save\n取消：/api cancel'));
      const value = text.trim();
      try {
        if (draft.stage === 0) {
          const provider = value.toLowerCase();
          if (!PROVIDER.test(provider) || RESERVED.includes(provider)) throw new Error('提供商标识需为1至32位英文字母、数字、短横线或下划线，以字母开头；codex 为保留名称。');
          draft.values.provider = provider;
        } else if (draft.stage === 1) draft.values.endpoint = validateEndpoint(value);
        else if (draft.stage === 2) {
          if (!/^[\x21-\x7e]{10,2048}$/.test(value)) throw new Error('Key 需为10至2048位可见英文字符，不可含空格或换行，请重新输入。');
          draft.values.apiKey = value;
        } else {
          if (!MODEL.test(value)) throw new Error('模型 ID 格式不正确，可使用字母、数字、点、短横线、下划线、斜杠和冒号，最多150字符。');
          draft.values.model = value;
        }
      } catch (error) { return result(notice('输入有误', error.message, '取消：/api cancel')); }
      draft.stage++;
      if (draft.stage < 4) return result(prompt());
      const { provider, endpoint, model } = draft.values;
      return result(notice('确认 API 配置', `提供商：${provider}\n接口：${endpoint}\n模型版本：${model}\nAPI Key：已填写，不回显`, '保存：发送“确认”或 /api save\n取消：/api cancel\n说明：同名提供商将更新配置；保存不会调用或自动切换 API。'));
    },
  };
}
