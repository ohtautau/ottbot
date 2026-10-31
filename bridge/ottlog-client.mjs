import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

export async function createOttlogClient(configFile, transport = fetch) {
  let config;
  try { config = JSON.parse(await readFile(configFile, 'utf8')); } catch { throw new Error('博客尚未连接，请先在服务器配置 Ottlog 账号。'); }
  const origin = new URL(config.origin);
  if (origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error('博客连接地址不安全。');
  const bot = config.authMode === 'bot' || Object.hasOwn(config, 'botToken');
  if (!config.expectedUserName || (bot ? typeof config.botToken !== 'string' || !/^ottb_[A-Za-z0-9_-]{43}$/.test(config.botToken) : !config.cookies || typeof config.cookies !== 'object'))
    throw new Error(bot ? '机器人授权未配置或已撤销，请重新授权；不会回退到网页登录。' : '博客账号配置不完整。');
  const toolsPath = bot ? '/api/bot/personal-tools/' : '/api/personal-tools/';
  let dirty = false;
  async function save() {
    if (!dirty) return;
    const next = configFile + '.' + randomUUID() + '.tmp';
    await writeFile(next, JSON.stringify(config), { mode: 0o600 });
    await rename(next, configFile); dirty = false;
  }
  async function request(path, method = 'GET', data, csrf) {
    let response;
    try { response = await transport(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: {
      'Content-Type': 'application/json', ...(bot ? { Authorization: 'Bearer ' + config.botToken } : {
        Cookie: Object.entries(config.cookies).map(([key, value]) => key + '=' + value).join('; '), ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}),
      }),
    }, body: data === undefined ? undefined : JSON.stringify(data) }); }
    catch { throw new Error(method === 'GET' ? '博客连接失败，请稍后重试。' : '博客保存结果未确认；请先查看列表，勿重复提交。'); }
    for (const cookie of bot ? [] : response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], index = pair.indexOf('=');
      if (index > 0) { config.cookies[pair.slice(0, index)] = pair.slice(index + 1); dirty = true; }
    }
    await save();
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? (bot ? '机器人授权已失效、被撤销或权限不足；本次已停止，不会回退到网页登录。' : '博客登录已失效或权限不足，请重新绑定账号。') : `博客接口返回 HTTP ${response.status}，未确认保存成功。`);
    return response.json();
  }
  async function session() {
    const s = await request(bot ? '/api/bot/session' : '/api/account/session');
    if (!s.authenticated) throw new Error('博客登录已失效，请重新绑定账号；本次未操作数据。');
    if (s.userName !== config.expectedUserName || s.isAdmin !== config.expectedAdmin) throw new Error('博客账号不匹配，已停止操作。');
    if (bot && config.botGrantId && s.grantId !== config.botGrantId) throw new Error('机器人授权不匹配，已停止操作。');
    return s;
  }
  const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return {
    owner: `${config.expectedAdmin ? 'admin' : 'reader'}:${config.expectedUserName}`,
    async read(key) { await session(); return (await request(toolsPath + key)).data; },
    async write(key, previous, data) {
      const s = await session();
      const latest = (await request(toolsPath + key)).data;
      if (digest(latest) !== digest(previous)) throw new Error('博客数据刚被其他设备修改，本次未保存，请重试。');
      const result = await request(toolsPath + key, 'PUT', { data }, s.csrfToken);
      if (digest(result.data) !== digest(data)) throw new Error('博客未确认目标内容已保存，请先查看列表。');
    },
  };
}
