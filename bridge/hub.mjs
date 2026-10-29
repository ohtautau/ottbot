import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { MODELS, authorized, textContent, parseCommand } from './worker.mjs';
import { resolveModel, apiConfig } from './models.mjs';

const TARGETS = { '服务器': 'server', server: 'server', '电脑': 'computer', computer: 'computer', pc: 'computer' };

export function routingCommand(text) {
  const match = text.trim().match(/^\/(服务器|server|电脑|computer|pc)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { target: TARGETS[match[1].toLowerCase()], text: (match[2] || '').trim() };
}

export async function createHub(config) {
  await mkdir(config.runtimeDirectory, { recursive: true });
  const stateFile = join(config.runtimeDirectory, 'hub-selection.json');
  let selection = { target: 'server', model: MODELS.sol };
  try {
    const stored = JSON.parse(await readFile(stateFile, 'utf8'));
    if (!['server', 'computer'].includes(stored.target) || !resolveModel(stored.model)) throw new Error('Invalid selection');
    selection = stored;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const persist = async value => {
    await writeFile(stateFile + '.tmp', JSON.stringify(value), { mode: 0o600 });
    await rename(stateFile + '.tmp', stateFile);
    selection = value;
  };
  const name = target => target === 'server' ? '服务器' : '电脑';
  const endpoint = target => target === 'server' ? config.serverWorkerUrl : config.computerWorkerUrl;
  const headers = { Authorization: `Bearer ${config.workerToken}`, 'Content-Type': 'application/json' };
  const health = async target => {
    try {
      const response = await fetch(endpoint(target) + '/health', { headers, signal: AbortSignal.timeout(2000) });
      if (!response.ok) return null;
      return await response.json();
    } catch { return null; }
  };
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const answer = (res, body, text) => {
    const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
    if (body.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      const chunk = (delta, finish) => ({ id, created, model: 'codex-local', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: text }, null))}\n\n`);
      res.end(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
    } else json(res, 200, { id, created, model: 'codex-local', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
  };
  const help = () => `默认执行端：${name(selection.target)}\n当前模型：${selection.model}\n/服务器 你的要求：仅本次在服务器执行\n/电脑 你的要求：仅本次在电脑执行（离线时不转移任务）\n/执行 服务器 或 /执行 电脑：修改默认执行端\n/模型 luna|sol|terra|astra：Codex账号模型\n/模型 gpt-完整模型名称：其他Codex模型\n/模型 提供商/模型ID：已配置的付费API\n/状态：查看执行端在线情况\nAPI密钥保存在服务器私有配置，切换后才按API计费，不自动回退。API当前仅聊天。模型与默认执行端设置适用于此私人服务的所有会话。`;
  let busy = false;
  const server = http.createServer(async (req, res) => {
    res.on('error', () => {});
    if (!authorized(req.headers.authorization, config.workerToken)) return json(res, 401, { error: { message: 'Unauthorized' } });
    if (req.method === 'GET' && req.url === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'codex-local', object: 'model', owned_by: 'private-hub' }] });
    if (req.method === 'GET' && req.url === '/health') {
      const [remote, computer] = await Promise.all([health('server'), health('computer')]);
      return json(res, 200, { ok: true, execution: 'hybrid-codex', model: selection.model, target: selection.target,
        serverOnline: Boolean(remote), computerOnline: Boolean(computer), serverAuthenticated: remote?.authenticated ?? null, busy });
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: { message: 'Not found' } });
    let body;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 24 * 1024 * 1024) throw new Error('Request too large');
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== 'codex-local' || !Array.isArray(body.messages) || body.messages.length > 300 || body.messages.at(-1)?.role !== 'user') throw new Error('Invalid chat request');
    } catch { return json(res, 400, { error: { message: '请求格式不正确或超过24MB；模型名称应为codex-local。' } }); }
    if (busy) return json(res, 429, { error: { message: '上一条任务仍在执行。' } });
    busy = true;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const last = body.messages.at(-1);
      const text = textContent(last.content).trim();
      const hasImages = Array.isArray(last.content) && last.content.some(part => part.type === 'image_url');
      const route = routingCommand(text);
      const command = !hasImages && !route ? parseCommand(text) : null;
      const targetSetting = !hasImages && text.match(/^\/(?:执行|target)(?:\s+(\S+))?$/i);
      if (targetSetting) {
        if (!targetSetting[1]) return answer(res, body, help());
        const target = TARGETS[targetSetting[1].toLowerCase()];
        if (!target) return answer(res, body, '执行端仅支持：服务器、电脑。');
        await persist({ ...selection, target });
        return answer(res, body, `默认执行端已设为${name(target)}。\n${help()}`);
      }
      if (command) {
        if (command.type === 'model' && command.value) {
          const model = resolveModel(command.value);
          if (!model) return answer(res, body, `没有这个模型。\n${help()}`);
          try { await apiConfig(config, model); }
          catch (error) { return answer(res, body, error.message); }
          await persist({ ...selection, model });
          return answer(res, body, `已切换到 ${model}。下一条普通消息生效；切换不调用模型。${model.includes('/') ? '\n这是独立API通道，按该提供商计费，当前仅聊天。' : '\n使用ChatGPT账号的Codex额度；实际模型权限需调用验证。'}`);
        }
        if (command.type === 'status') {
          const [remote, computer] = await Promise.all([health('server'), health('computer')]);
          return answer(res, body, `服务器接收端在线。\n服务器执行进程：${remote ? '在线' : '未连接'}\n服务器Codex登录：${remote?.authenticated === true ? '已登录（额度需调用验证）' : remote?.authenticated === false ? '未登录' : '尚未验证'}\n电脑执行端：${computer ? '在线' : '离线'}\n${help()}`);
        }
        return answer(res, body, help());
      }
      const target = route?.target || selection.target;
      if (route && !route.text && !hasImages) return answer(res, body, `请在 /${name(target)} 后写要执行的任务。`);
      if (!await health(target)) return json(res, 503, { error: { message: `${name(target)}执行端离线。本次任务没有执行，也不会改交其他机器。` } });
      const control = await fetch(endpoint(target) + '/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'codex-local', messages: [{ role: 'user', content: `/模型 ${selection.model}` }] }), signal: AbortSignal.timeout(5000) });
      if (!control.ok) { await control.body.cancel(); throw new Error('执行端忙碌或模型设置失败。'); }
      await control.body.cancel();
      if (route) {
        const content = Array.isArray(last.content)
          ? [{ type: 'text', text: route.text }, ...last.content.filter(part => part.type !== 'text')]
          : route.text;
        body = { ...body, messages: [...body.messages.slice(0, -1), { role: 'user', content }] };
      }
      const response = await fetch(endpoint(target) + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: abort.signal });
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', 'X-Ottbot-Target': target, 'X-Ottbot-Model': selection.model });
      for await (const chunk of response.body) {
        if (res.destroyed) { abort.abort(); break; }
        if (!res.write(chunk)) await once(res, 'drain');
      }
      if (!res.destroyed) res.end();
    } catch {
      if (!res.destroyed && !res.headersSent) json(res, 502, { error: { message: '指定执行端请求失败。本次任务没有自动转交其他机器，请先检查状态。' } });
      else if (!res.destroyed) res.destroy();
    } finally { busy = false; }
  });
  server.requestTimeout = 30000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const path = resolve(process.argv[2]);
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.runtimeDirectory = resolve(dirname(path), 'hub-runtime');
  const server = await createHub(config);
  server.listen(config.port || 18892, '127.0.0.1', () => console.log('Private dual-executor hub ready.'));
}
