import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const state = join(root, 'local-state', 'codex-bridge');
await mkdir(state, { recursive: true });
let config;
try { config = JSON.parse(await readFile(join(state, 'worker.json'), 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if (!process.argv[2]) throw new Error('Pass the installed codex.exe path.');
  if (!process.env.OTTBOT_SSH_TARGET || !process.env.OTTBOT_SSH_KEY) throw new Error('Set OTTBOT_SSH_TARGET and OTTBOT_SSH_KEY for this machine.');
  config = {
    codexPath: process.argv[2],
    workspace: resolve(process.env.OTTBOT_WORKSPACE || resolve(root, '..', 'ottlog')),
    port: 18890, localRelayPort: 18889, serverRelayPort: 8089, serverWorkerPort: 18450,
    sshTarget: process.env.OTTBOT_SSH_TARGET,
    sshKey: resolve(process.env.OTTBOT_SSH_KEY),
    knownHosts: resolve(process.env.OTTBOT_KNOWN_HOSTS || join(state, 'known_hosts')),
    clientToken: randomBytes(32).toString('hex'), workerToken: randomBytes(32).toString('hex'),
    defaultModel: 'gpt-6.1-sol', timeoutMs: 600000,
    sandbox: 'workspace-write', executionName: 'computer-codex',
  };
  await writeFile(join(state, 'worker.json'), JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
}
await writeFile(join(state, 'relay.json'), JSON.stringify({
  clientToken: config.clientToken, workerToken: config.workerToken,
  port: config.serverRelayPort, workerPort: config.serverWorkerPort,
}, null, 2), { mode: 0o600 });
await writeFile(join(state, 'codebuddy-settings.txt'), [
  'CodeBuddy 自定义模型（私人 SSH 转接）',
  `接口地址：http://127.0.0.1:${config.localRelayPort}/v1/chat/completions`,
  `API KEY：${config.clientToken}`,
  '模型名称：codex-local',
  '工具调用：不勾选（Codex 自己执行工具，CodeBuddy 只负责对话入口）',
  '图片输入：勾选（PNG/JPEG/WebP 图片附件；不接受图片网址）',
  '推理模式：不勾选；思考强度：留空；输入/输出：留空',
  '保存后在微信对应的 Claw 会话选择 codex-local。',
  '微信发送 /模型 查看选项；/模型 luna、/模型 sol、/模型 terra、/模型 astra 切换；/状态 检查连接。',
  '此 API KEY 是转接密钥，不是 OpenAI API Key。不要分享此文件。',
].join('\r\n'), { mode: 0o600 });
console.log('Local bridge configuration prepared. Credentials were not printed.');
