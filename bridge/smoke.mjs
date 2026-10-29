import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const config = JSON.parse(await readFile(resolve(import.meta.dirname, '../local-state/codex-bridge/worker.json'), 'utf8'));
const base = `http://127.0.0.1:${config.localRelayPort}`;
const headers = { Authorization: `Bearer ${config.clientToken}`, 'Content-Type': 'application/json' };
const chat = async (text, stream = false) => {
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers,
    body: JSON.stringify({ model: 'codex-local', stream, messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(180000) });
  const data = stream ? await response.text() : await response.json();
  if (!response.ok) throw new Error(`Bridge HTTP ${response.status}: ${data.error?.message || 'failed'}`);
  return data;
};

let health;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    health = await fetch(base + '/health', { headers, signal: AbortSignal.timeout(3000) });
    if (health.ok) break;
    await health.body.cancel();
  } catch { /* Supervisor may still be opening its SSH tunnel. */ }
  await delay(500);
}
if (!health) throw new Error('Local bridge did not become reachable.');
assert.equal(health.status, 200);
const status = await health.json();
console.log(`SSH round trip: healthy; worker=${status.execution}; sandbox=${status.sandbox}; model=${status.model}`);
assert.equal((await fetch(base + '/health', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
console.log('Invalid relay key: rejected');
const models = await (await fetch(base + '/v1/models', { headers })).json();
assert.equal(models.data[0].id, 'codex-local');
const control = await chat('/状态', true);
assert.ok(control.includes('data: [DONE]') && control.includes(status.execution === 'hybrid-codex' ? '服务器接收端在线' : '转接已连接'));
console.log('SSE control command: passed (no inference)');

if (process.argv.includes('--inference')) {
  await chat('/模型 luna');
  try {
    console.log('Running one real Codex login-based inference...');
    const streaming = process.argv.includes('--stream');
    const prefix = status.execution === 'hybrid-codex' ? (status.serverAuthenticated ? '/服务器 ' : '/电脑 ') : '';
    const result = await chat(prefix + '只回复“Codex 转接测试成功”，不要读取文件、执行命令或调用工具。', streaming);
    if (streaming && result.includes('codex_bridge_error')) throw new Error('Codex streaming inference failed.');
    const answer = streaming ? result.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '').join('') : result.choices?.[0]?.message?.content;
    assert.ok(answer?.includes('Codex 转接测试成功'));
    console.log(`Real Codex response: ${answer}`);
  } finally { await chat(`/模型 ${status.model}`); }
}
