import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

let config;
try {
  config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  if (!['echo', 'ai'].includes(config.mode)) throw new Error('mode 请填写 echo 或 ai');
  const required = ['botId', 'botSecret', ...(config.mode === 'ai' ? ['modelApiUrl', 'modelApiKey', 'model'] : [])];
  for (const key of required) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`请在 config.json 填写 ${key}`);
  }
  if (config.mode === 'ai' && new URL(config.modelApiUrl).protocol !== 'https:') {
    throw new Error('模型接口地址必须使用 https');
  }
} catch (error) {
  console.error(`配置错误：${error.message}`);
  process.exit(1);
}
if (process.argv.includes('--check')) {
  console.log(`配置检查通过，模式：${config.mode}（尚未验证密钥是否有效）。`);
  process.exit(0);
}

// Use a silent SDK logger to avoid writing credentials or raw message frames to logs.
const { default: AiBot } = await import('@wecom/aibot-node-sdk');
const silent = () => {};
const client = new AiBot.WSClient({
  botId: config.botId,
  secret: config.botSecret,
  maxReconnectAttempts: -1,
  logger: { debug: silent, info: silent, warn: silent, error: silent },
});
const sessions = new Map();
const seen = new Map();
const busy = new Set();
const ttl = 60 * 60 * 1000;
const cleanup = setInterval(() => {
  const cutoff = Date.now() - ttl;
  for (const [key, time] of seen) if (time < cutoff) seen.delete(key);
  for (const [key, session] of sessions) if (session.time < cutoff) sessions.delete(key);
}, 60_000);
cleanup.unref();

async function askModel(messages) {
  const response = await fetch(config.modelApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.modelApiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: config.systemPrompt }, ...messages],
      stream: false,
      max_completion_tokens: 1200,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}`);
  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('模型未返回文本，请检查接口是否兼容 Chat Completions');
  return answer;
}

function fitReply(text) {
  const suffix = '\n\n（回答过长，已截断，请分步提问。）';
  if (Buffer.byteLength(text, 'utf8') <= 18_000) return text;
  let result = '';
  let bytes = Buffer.byteLength(suffix, 'utf8');
  for (const character of text) {
    bytes += Buffer.byteLength(character, 'utf8');
    if (bytes > 18_000) break;
    result += character;
  }
  return result + suffix;
}

async function handle(frame) {
  const body = frame.body;
  if (!body?.from?.userid || !body.msgid) return;
  const content = body.text?.content?.trim();
  if (!content) return;
  const dedupKey = `${body.aibotid}:${body.msgid}`;
  if (seen.has(dedupKey)) return;
  seen.set(dedupKey, Date.now());
  // Keep every sender's history separate, including within a group.
  const key = JSON.stringify([body.chattype, body.chatid || '', body.from.userid]);
  const streamId = randomUUID();
  const reply = (text, finish = true) => client.replyStream(frame, streamId, fitReply(text), finish);
  if (busy.has(key)) {
    await reply('上一条消息还在处理中，请收到回答后再发送。');
    return;
  }
  busy.add(key);
  try {
    if (content === '/清空') {
      sessions.delete(key);
      await reply('已清空当前对话记忆。');
      return;
    }
    if (config.mode === 'echo') {
      await reply(`连接测试成功！你刚才说：${content}`);
      return;
    }
    await reply('正在思考，请稍候…', false);
    const previous = sessions.get(key);
    const history = previous && Date.now() - previous.time < ttl ? previous.messages : [];
    const messages = [...history, { role: 'user', content: content }];
    const answer = await askModel(messages);
    await reply(answer);
    sessions.set(key, {
      time: Date.now(),
      messages: [...messages, { role: 'assistant', content: answer }].slice(-12),
    });
  } catch (error) {
    const reason = ['TimeoutError', 'AbortError'].includes(error.name)
      ? '模型请求超时，请重试。'
      : /^模型/.test(error.message) ? error.message : '请求或回复失败，请检查网络后重试。';
    console.error(reason);
    await reply(reason).catch(() => console.error('发送错误提示失败。'));
  } finally {
    busy.delete(key);
  }
}

client.on('authenticated', () => console.log(`企业微信认证成功！模式：${config.mode}。现在可以给机器人发送文字。`));
client.on('disconnected', () => console.log('连接已断开。'));
client.on('reconnecting', () => console.log('正在重新连接…'));
client.on('error', () => console.error('企微连接发生错误；请检查网络、Bot ID 和 Secret，避免同时运行多个实例。'));
client.on('message.text', frame => {
  handle(frame).catch(() => console.error('消息处理失败。'));
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { clearInterval(cleanup); client.disconnect(); process.exit(0); });
}
console.log('正在连接企业微信…（不会打印密钥和聊天内容）');
client.connect();
