import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function save(file, value) {
  const next = file + '.' + randomUUID() + '.tmp';
  await writeFile(next, JSON.stringify(value), { mode: 0o600 });
  await rename(next, file);
}

export async function manageOttlogAuth({ action, configFile, sessionFile, name = 'Ottbot', confirm = false, transport = fetch }) {
  async function readConfig(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('授权配置文件无法读取。'); }
  }
  const config = await readConfig(configFile);
  const origin = new URL(config.origin);
  if (origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname))))
    throw new Error('博客连接地址不安全。');
  if (!config.expectedUserName || typeof config.expectedAdmin !== 'boolean') throw new Error('绑定账号配置不完整。');
  async function call(path, { method = 'GET', data, token, cookies, csrf } = {}) {
    let response;
    try {
      response = await transport(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: {
        'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : { Cookie: Object.entries(cookies || {}).map(([k, v]) => k + '=' + v).join('; ') }),
        ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}),
      }, body: data === undefined ? undefined : JSON.stringify(data) });
    } catch { throw new Error('博客连接失败；请检查授权状态后重试。'); }
    if (!response.ok) throw new Error(`授权接口返回 HTTP ${response.status}；请检查登录或授权状态。`);
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new Error('授权接口返回无效响应。'); }
  }
  function verify(session) {
    if (!session.authenticated || session.userName !== config.expectedUserName || session.isAdmin !== config.expectedAdmin)
      throw new Error('登录账号与绑定账号不一致，已停止。');
  }
  if (action === 'bind') {
    if (config.botToken) throw new Error('已有独立授权；如需更换，请先撤销。');
    const login = sessionFile ? await readConfig(sessionFile) : config;
    if (!login.cookies || !Object.keys(login.cookies).length || (login.origin && login.origin !== config.origin)) throw new Error('需要同一博客的有效登录 Cookie 文件。');
    const session = await call('/api/account/session', { cookies: login.cookies }); verify(session);
    const grant = await call('/api/account/bot-grants', { method: 'POST', cookies: login.cookies, csrf: session.csrfToken, data: { name } });
    try {
      if (!/^ottb_[A-Za-z0-9_-]{43}$/.test(grant.token) || !grant.id) throw new Error('授权响应无效。');
      const check = await call('/api/bot/session', { token: grant.token }); verify(check);
      if (check.grantId !== grant.id) throw new Error('授权编号不匹配。');
      const { cookies, botRevokedAt, ...rest } = config;
      await save(configFile, { ...rest, authMode: 'bot', botToken: grant.token, botGrantId: grant.id, botGrantName: grant.name });
      return `已绑定独立机器人授权：${grant.name}\n账号：${config.expectedUserName}\n授权编号：${grant.id}\n有效期：直到撤销或账号安全标记变更。`;
    } catch {
      try { await call('/api/bot/grant', { method: 'DELETE', token: grant.token }); } catch { /* Account endpoint can revoke any orphaned grant by ID. */ }
      throw new Error('独立授权未保存成功；请在账号授权列表检查并撤销未使用的授权。');
    }
  }
  if (!config.botToken) throw new Error(config.botRevokedAt ? '机器人授权已撤销。' : '尚未绑定独立机器人授权。');
  if (action === 'status') {
    const session = await call('/api/bot/session', { token: config.botToken }); verify(session);
    if (config.botGrantId && session.grantId !== config.botGrantId) throw new Error('授权编号不匹配。');
    return `授权：有效\n账号：${session.userName}\n名称：${session.name}\n授权编号：${session.grantId}\n权限：读取任务、便签、习惯；修改任务和便签。`;
  }
  if (action === 'revoke') {
    if (!confirm) throw new Error('撤销后机器人将不能读写博客。确认时添加 --confirm。');
    await call('/api/bot/grant', { method: 'DELETE', token: config.botToken });
    const { botToken, cookies, ...rest } = config;
    await save(configFile, { ...rest, authMode: 'bot', botRevokedAt: new Date().toISOString() });
    return '独立机器人授权已撤销；网页登录和其他机器人授权不受影响。';
  }
  throw new Error('用法：ottlog-auth.mjs bind|status|revoke [--config <文件>] [--session-file <登录文件>] [--name <名称>] [--confirm]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), action = args.shift();
    const options = { action, configFile: join(homedir(), 'ottbot-relay', 'shared', 'ottlog.json') };
    while (args.length) {
      const flag = args.shift();
      if (flag === '--confirm') options.confirm = true;
      else if (['--config', '--session-file', '--name'].includes(flag) && args.length) options[{ '--config': 'configFile', '--session-file': 'sessionFile', '--name': 'name' }[flag]] = args.shift();
      else throw new Error('未知或缺少参数。');
    }
    console.log(await manageOttlogAuth(options));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
