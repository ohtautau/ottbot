# ottbot

企业微信长连接 AI 对话机器人。支持文字对话、按用户隔离的短期对话记忆和清空会话。

仓库：https://github.com/ohtautau/ottbot

微信/CodeBuddy复用本机Codex登录的转接服务见 [Codex转接说明](bridge/README.md)，通过 `start-codex-bridge.cmd` 启动，与下方企微机器人独立运行。

本程序采用企业微信官方 SDK：https://github.com/WecomTeam/aibot-node-sdk 。第一版仅支持文字，不接数据库。

## 1. 先测试企微连接

首次克隆项目后，将 config.example.json 复制为 config.json（双击 start.cmd 也会自动创建）。用记事本打开 config.json，在双引号内填写 botId、botSecret。它们来自企业微信机器人设置页。机器人选择「API 模式 → 长连接」，保存设置。

mode 先保持 echo，其他空值可以暂时不填。保存 config.json 后双击 start.cmd。首次启动会联网安装依赖。需要 Node.js 22 或更新版本；本机启动脚本也支持现有 Codex Node 运行环境。

看到「企业微信认证成功」后，给机器人发「你好」。收到「连接测试成功！你刚才说：你好」说明企微接入成功。

## 2. 切换到 AI 回答

在运行窗口按 Ctrl+C 停止程序，然后修改 config.json：

- mode 改成 ai。
- modelApiUrl 填模型供应商提供的完整 Chat Completions 地址，包括路径（通常以 /chat/completions 结尾，不能只填网站首页或 /v1）。
- modelApiKey 填 API Key。
- model 填供应商要求的模型名称。

此版本要求供应商支持 Bearer API Key 和 Chat Completions 消息格式；并非所有模型 API 都兼容。若供应商使用其他接口，需要修改模型调用部分。所有配置均留在本地，不要分享填写过的 config.json。

再次双击 start.cmd，给机器人发消息即可。聊天记录会随消息发送给配置的模型供应商。

也可以在终端运行：

```powershell
npm install
npm start
```

依赖锁定文件使用 pnpm 管理；使用 pnpm 时可执行 `pnpm install --frozen-lockfile`。config.json 已由 .gitignore 排除，GitHub 仅保存无密钥的 config.example.json。

## 3. 使用说明

- 先在私聊里测试。群聊需要按企业微信规则触发机器人，例如 @机器人。
- 发送 /清空 清除当前会话记忆。每个用户分别保存最近六轮对话，闲置一小时清除，重启也会清除。
- 模型请求最多等待 45 秒；本版先显示「正在思考」再显示最终回答，不逐字输出。
- 电脑和终端窗口需要保持运行，休眠或退出会影响服务。后续可部署服务器。
- 同一个机器人不要同时启动多个接入程序，否则可能互相挤掉连接。
- 看到 HTTP 401 检查模型密钥，404 检查完整接口地址及模型名称，429 检查额度或频率限制。
- 本程序没有数据库权限，也不执行系统命令。

开发检查：node --check bot.mjs 检查语法；node bot.mjs --check 检查配置，不连接企微也不调用模型。
