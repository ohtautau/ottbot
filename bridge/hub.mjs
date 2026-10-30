import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { MODELS, authorized, textContent, parseCommand } from './worker.mjs';
import { resolveModel, apiConfig } from './models.mjs';
import { resolveEffort, reasoningOptions, reasoningHelp, effortLabel } from './reasoning.mjs';

import { resolveTarget, helpText, notice } from './commands.mjs';

export function routingCommand(text) {
  const command = parseCommand(text);
  return command?.type === 'route' ? { target: command.target, text: command.text } : null;
}

export async function createHub(config) {
  await mkdir(config.runtimeDirectory, { recursive: true });
  const stateFile = join(config.runtimeDirectory, 'hub-selection.json');
  let selection = { target: 'server', model: MODELS.sol, effort: 'low' };
  try {
    const stored = JSON.parse(await readFile(stateFile, 'utf8'));
    if (!['server', 'computer'].includes(stored.target) || !resolveModel(stored.model)) throw new Error('Invalid selection');
    if (stored.effort !== undefined && !resolveEffort(stored.effort)) throw new Error('Invalid reasoning state');
    selection = { ...stored, effort: resolveEffort(stored.effort || 'low') };
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
  const currentSettings = () => `默认执行端：${name(selection.target)}\n当前模型：${selection.model}\n推理强度：${selection.model.includes('/') ? 'API默认' : effortLabel(selection.effort)}`;
  const help = topic => helpText(topic, currentSettings());
  let busy = false;
  const server = http.createServer(async (req, res) => {
    res.on('error', () => {});
    if (!authorized(req.headers.authorization, config.workerToken)) return json(res, 401, { error: { message: 'Unauthorized' } });
    if (req.method === 'GET' && req.url === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'codex-local', object: 'model', owned_by: 'private-hub' }] });
    if (req.method === 'GET' && req.url === '/health') {
      const [remote, computer] = await Promise.all([health('server'), health('computer')]);
      return json(res, 200, { ok: true, execution: 'hybrid-codex', model: selection.model, target: selection.target,
        reasoningEffort: selection.effort,
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
      const command = !route ? parseCommand(text) : null;
      if (hasImages && command) return answer(res, body, notice('指令错误', '设置指令请单独发送文字，不要附带图片。图片任务可使用 /srv 或 /pc。'));
      if (command?.type === 'target') {
        if (!command.value) return answer(res, body, help('target'));
        const target = resolveTarget(command.value);
        if (!target) return answer(res, body, notice('指令错误', '执行端无效，可选：服务器 / server / srv 或 电脑 / computer / pc。', '示例：/t pc'));
        await persist({ ...selection, target });
        return answer(res, body, notice('设置成功', `默认执行端：${name(target)}`, '下一条任务生效 · 重启保留\n单次执行可用 /srv 任务 或 /pc 任务'));
      }
      if (command) {
        if (command.type === 'error') return answer(res, body, notice('指令错误', command.message));
        if (command.type === 'help') return answer(res, body, help(command.value));
        if (command.type === 'clear') return answer(res, body, notice('使用提示', '请在微信入口发送 /cl 清空短期对话。当前入口没有可清空的对话记录。'));
        if (command.type === 'reasoning') {
          const options = await reasoningOptions(config, selection.model);
          const effort = resolveEffort(command.value);
          if (!command.value || !effort || !options.includes(effort)) {
            return answer(res, body, command.value && options.length ? notice('指令错误', '该模型不支持这个推理档位，原设置保持。', await reasoningHelp(config, selection.model, selection.effort)) : await reasoningHelp(config, selection.model, selection.effort));
          }
          await persist({ ...selection, effort });
          return answer(res, body, notice('设置成功', `推理强度：${effortLabel(effort)}`, '下一条任务生效 · 重启保留\n适用于服务器和电脑执行端\n/r 查看编号'));
        }
        if (command.type === 'model' && command.value) {
          const model = resolveModel(command.value);
          if (!model) return answer(res, body, notice('指令错误', '模型名称无效，原设置保持。', help('model')));
          try { await apiConfig(config, model); }
          catch (error) { return answer(res, body, error.message); }
          const options = await reasoningOptions(config, model);
          const effort = !options.length || options.includes(selection.effort) ? selection.effort : 'auto';
          await persist({ ...selection, model, effort });
          return answer(res, body, `【设置成功】\n\n当前模型：${model}\n下一条消息生效 · 切换不调用模型\n${model.includes('/') ? '\n这是独立API通道，按该提供商计费，当前仅聊天。' : `\n推理强度：${effort}；发送 /推理 查看。\n使用ChatGPT账号的Codex额度；实际模型权限需调用验证。`}`);
        }
        if (command.type === 'status') {
          const [remote, computer] = await Promise.all([health('server'), health('computer')]);
          return answer(res, body, notice('运行状态', `服务器接收端在线\n服务器执行进程：${remote ? '在线' : '未连接'}\n服务器Codex登录：${remote?.authenticated === true ? '已登录（额度需调用验证）' : remote?.authenticated === false ? '未登录' : '尚未验证'}\n电脑执行端：${computer ? '在线' : '离线'}`, currentSettings(), '/h 帮助　/m 模型　/r 推理　/t 执行端'));
        }
        return answer(res, body, help(command.type));
      }
      const target = route?.target || selection.target;
      if (route && !route.text && !hasImages) return answer(res, body, `请在 /${name(target)} 后写要执行的任务。`);
      const current = await health(target);
      if (!current) return json(res, 503, { error: { message: `${name(target)}执行端离线。本次任务没有执行，也不会改交其他机器。` } });
      if (current.reasoningControl !== true) return json(res, 503, { error: { message: '执行端版本需要更新并重启；本次没有执行，避免推理设置被当作普通任务。' } });
      const control = await fetch(endpoint(target) + '/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'codex-local', messages: [{ role: 'user', content: `/模型 ${selection.model}` }] }), signal: AbortSignal.timeout(5000) });
      if (!control.ok) { await control.body.cancel(); throw new Error('执行端忙碌或模型设置失败。'); }
      const modelControl = await control.json();
      if (modelControl.settings?.model !== selection.model) throw new Error('Model synchronization failed');
      if (!selection.model.includes('/')) {
        const reasoning = await fetch(endpoint(target) + '/v1/chat/completions', { method: 'POST', headers,
          body: JSON.stringify({ model: 'codex-local', messages: [{ role: 'user', content: `/推理 ${selection.effort}` }] }), signal: AbortSignal.timeout(5000) });
        const result = await reasoning.json();
        if (!reasoning.ok || result.settings?.reasoningEffort !== selection.effort) {
          return json(res, 400, { error: { message: '指定执行端不支持当前推理档位，请先发送 /推理 查看或选择 /推理 auto。本次没有调用模型。' } });
        }
      }
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
  config.modelCacheFile ||= join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
  config.runtimeDirectory = resolve(dirname(path), 'hub-runtime');
  const server = await createHub(config);
  server.listen(config.port || 18892, '127.0.0.1', () => console.log('Private dual-executor hub ready.'));
}
