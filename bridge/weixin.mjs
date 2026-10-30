// Compatible channel transport based on Tencent/openclaw-weixin/docs/protocol.md.
import { randomBytes, randomUUID, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { realpathSync } from 'node:fs';
import { routingCommand } from './hub.mjs';
import { parseCommand } from './worker.mjs';
import { createApiSetup } from './api-setup.mjs';

const API = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '2.4.8';

export function trustedWeixinUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.weixin.qq.com')) throw new Error('微信服务地址不符合预期。');
  return url;
}

export function decodeImage(bytes, image) {
  let key;
  if (/^[a-fA-F0-9]{32}$/.test(image.aeskey || '')) key = Buffer.from(image.aeskey, 'hex');
  else if (image.media?.aes_key) {
    const decoded = Buffer.from(image.media.aes_key, 'base64');
    key = decoded.length === 16 ? decoded : /^[a-fA-F0-9]{32}$/.test(decoded.toString()) ? Buffer.from(decoded.toString(), 'hex') : null;
    if (!key) throw new Error('图片解密密钥格式不受支持。');
  }
  if (key) {
    const cipher = createDecipheriv('aes-128-ecb', key, null);
    bytes = Buffer.concat([cipher.update(bytes), cipher.final()]);
  }
  if (bytes.length > 10 * 1024 * 1024) throw new Error('照片超过10MB，请压缩后重发。');
  const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
  if (!type) throw new Error('目前只接收PNG、JPEG或WebP照片。');
  return `data:image/${type};base64,${bytes.toString('base64')}`;
}

async function api(base, path, payload, token, method = 'POST', timeout = 40000) {
  const url = trustedWeixinUrl(new URL(path, base).href);
  const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 8) };
  if (method === 'POST') {
    Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const body = payload ? JSON.stringify(token ? { ...payload, base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'Ottbot/1.0' } } : payload) : undefined;
  const response = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`微信通道HTTP ${response.status}`);
  const data = await response.json();
  if (data.errcode === -14 || data.ret === -14) throw new Error('WEIXIN_SESSION_EXPIRED');
  if ((data.ret !== undefined && data.ret !== 0) || (data.errcode !== undefined && data.errcode !== 0)) throw new Error('微信通道暂时返回错误。');
  return data;
}

async function atomicJson(path, value) {
  await writeFile(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
  await rename(path + '.tmp', path);
}

export async function pair(configPath) {
  const directory = dirname(configPath);
  const qr = await api(API, '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] });
  if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('未收到微信二维码。');
  await atomicJson(join(directory, 'weixin-qr.json'), { image: qr.qrcode_img_content, createdAt: new Date().toISOString() });
  if (/^https:\/\//.test(qr.qrcode_img_content)) console.log(`请用手机微信扫描：${qr.qrcode_img_content}`);
  else if (/^data:image\/png;base64,/.test(qr.qrcode_img_content)) {
    await writeFile(join(directory, 'weixin-login.png'), Buffer.from(qr.qrcode_img_content.split(',')[1], 'base64'), { mode: 0o600 });
    console.log('微信二维码图片已保存到服务器 shared/weixin-login.png。');
  } else console.log('微信二维码内容已保存到服务器 shared/weixin-qr.json。');
  let base = API;
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await api(base, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, undefined, undefined, 'GET');
    if (status.status === 'confirmed') {
      if (!status.bot_token || !status.ilink_user_id) throw new Error('微信确认未包含账号身份。');
      const baseUrl = trustedWeixinUrl(status.baseurl || API).origin;
      await atomicJson(join(directory, 'weixin-account.json'), { token: status.bot_token, baseUrl, owner: status.ilink_user_id });
      console.log('微信绑定成功。凭据已写入服务器私有文件，未输出。');
      return;
    }
    if (status.status === 'expired') throw new Error('二维码已过期，请重新发起绑定。');
    if (['need_verifycode', 'verify_code_blocked'].includes(status.status)) throw new Error('微信要求额外验证；请在手机处理后重新绑定。');
    if (status.status === 'scaned_but_redirect' && status.redirect_host) {
      base = trustedWeixinUrl(status.redirect_host.includes('://') ? status.redirect_host : `https://${status.redirect_host}`).origin;
    }
    await delay(2000);
  }
  throw new Error('等待扫码超时。');
}

async function receiveContent(message) {
  const content = [];
  for (const item of message.item_list || []) {
    if (item.type === 1 && item.text_item?.text) content.push({ type: 'text', text: item.text_item.text });
    else if (item.type === 3 && item.voice_item?.text) content.push({ type: 'text', text: item.voice_item.text });
    else if (item.type === 2 && item.image_item?.media) {
      if (content.filter(p => p.type === 'image_url').length >= 4) throw new Error('每条消息最多四张照片。');
      const media = item.image_item.media;
      const url = media.full_url || `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param || '')}`;
      const response = await fetch(trustedWeixinUrl(url), { redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('照片下载失败，请重新发送。');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 10 * 1024 * 1024 + 16) throw new Error('照片过大，请压缩后重发。');
        chunks.push(chunk);
      }
      content.push({ type: 'image_url', image_url: { url: decodeImage(Buffer.concat(chunks), item.image_item) } });
    } else if (![1, 2, 3].includes(item.type)) throw new Error('目前支持文字、照片和带文字转写的语音。');
  }
  if (!content.length) throw new Error('没有可处理的文字或照片。');
  return content;
}

export function formatWeixinText(text, menu = false) {
  // Some desktop clients collapse a single newline when displaying bot menus.
  // Paragraph boundaries remain explicit. Keep normal model replies unchanged.
  const value = menu ? text.replace(/\r\n?/g, '\n').replace(/\n+/g, '\n\n') : text;
  return value.length <= 3800 ? value : value.slice(0, 3750) + '\n\n（回复过长，已截断；可分步继续提问。）';
}

export async function monitor(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const directory = dirname(configPath);
  const account = JSON.parse(await readFile(join(directory, 'weixin-account.json'), 'utf8'));
  const apiSetup = await createApiSetup({ providersFile: join(directory, 'providers.json'), pendingFile: join(directory, 'api-setup-pending.json') });
  trustedWeixinUrl(account.baseUrl);
  if (!account.token || !account.owner) throw new Error('微信尚未绑定。');
  const cursorFile = join(directory, 'weixin-cursor.json');
  const histories = new Map(); // Separate target and model/provider; restart clears chat history.
  let state = { cursor: '', seen: [] };
  try { state = JSON.parse(await readFile(cursorFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const send = (message, text, menu = false) => api(account.baseUrl, '/ilink/bot/sendmessage', { msg: {
    from_user_id: '', to_user_id: account.owner, client_id: randomUUID(), message_type: 2, message_state: 2,
    context_token: message.context_token, item_list: [{ type: 1, text_item: { text: formatWeixinText(text, menu) } }],
  } }, account.token);
  console.log('微信服务器接收端启动，仅接受扫码账号的私聊。');
  for (;;) {
    try {
      const update = await api(account.baseUrl, '/ilink/bot/getupdates', { get_updates_buf: state.cursor || '' }, account.token, 'POST', 45000);
      for (const message of update.msgs || []) {
        if (message.message_type !== 1 || message.from_user_id !== account.owner || message.group_id || !message.context_token) continue;
        const id = String(message.client_id || message.message_id || message.seq || '');
        if (!id || state.seen.includes(id)) continue;
        state.seen = [...state.seen.slice(-255), id];
        // Persist receipt before invoking any execution; a restart never repeats a control task.
        await atomicJson(cursorFile, state);
        try {
          const items = message.item_list || [];
          const input = items.filter(item => item.type === 1).map(item => item.text_item?.text || '').join('\n').trim();
          const setup = await apiSetup.handle(input, items.some(item => item.type !== 1));
          if (setup.handled) {
            await send(message, setup.text, true);
            continue; // Configuration inputs never reach models or conversation history.
          }
          const content = await receiveContent(message);
          const plainText = content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
          if (parseCommand(plainText)?.type === 'clear' && content.every(part => part.type === 'text')) {
            histories.clear();
            await send(message, '【清空成功】\n\n已清空短期对话上下文。\n微信聊天记录和博客数据保留。', true);
            continue;
          }
          const parsed = parseCommand(plainText);
          const command = parsed && parsed.type !== 'route';
          let history = [];
          if (!command) {
            let target = routingCommand(plainText)?.target;
            const health = await fetch(config.hubUrl + '/health', { headers: { Authorization: `Bearer ${config.workerToken}` }, signal: AbortSignal.timeout(5000) });
            if (!health.ok) throw new Error('路由状态暂时不可用。');
            const current = await health.json();
            history = histories.get(`${target || current.target}:${current.model}`) || [];
          }
          const response = await fetch(config.hubUrl + '/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.workerToken}` },
            body: JSON.stringify({ model: 'codex-local', messages: [...history, { role: 'user', content }], stream: false }), signal: AbortSignal.timeout(650000),
          });
          const result = await response.json();
          const target = response.headers.get('x-ottbot-target');
          const text = response.ok ? result.choices?.[0]?.message?.content : result.error?.message;
          if (!text) throw new Error('执行端未返回明确结果。');
          await send(message, (target ? `【${target === 'computer' ? '电脑' : '服务器'}】\n\n` : '') + text, Boolean(command));
          if (response.ok && target) histories.set(`${target}:${response.headers.get('x-ottbot-model')}`, [...history,
            { role: 'user', content: plainText.slice(0, 6000) || '（发送了照片，历史中不保留原图片）' },
            { role: 'assistant', content: text.slice(0, 6000) },
          ].slice(-12));
        } catch (error) {
          const safe = /照片|文字|图片|每条消息/.test(error.message) ? error.message : '本次请求未完成，请先发 /状态 查看连接；不要假定操作已成功。';
          await send(message, safe).catch(() => console.error('微信错误提示发送失败。'));
        }
      }
      if (update.get_updates_buf) state.cursor = update.get_updates_buf;
      await atomicJson(cursorFile, state);
      if (!(update.msgs || []).length) await delay(500);
    } catch (error) {
      const expired = error.message === 'WEIXIN_SESSION_EXPIRED';
      console.error(expired ? '微信授权已过期，暂停一小时后重试；可重新扫码绑定。' : '微信通道暂时不可用，稍后重试。');
      await delay(expired ? 3600000 : 10000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const configPath = resolve(process.argv[3]);
  const run = process.argv[2] === 'login' ? pair : process.argv[2] === 'run' ? monitor : null;
  if (!run) throw new Error('Usage: weixin.mjs login|run CONFIG');
  run(configPath).catch(error => { console.error(error.message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')); process.exitCode = 1; });
}
