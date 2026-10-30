# GitHub 同步部署

## 当前单机部署

博客网页/API/Caddy及全部SQLite、图片、会话密钥卷与微信接收器、路由、Codex执行器均位于新加坡。微信私有`shared/ottlog.json`使用同机`http://127.0.0.1:8088`，原跨广州`ottbot-ottlog`隧道已禁用，部署器不会重新启用。Cookie、数据库及SSH私钥不进入Git。博客迁移的校验、空卷恢复及回滚过程见ottlog仓库`docs/singapore-deployment.md`。网页继续沿原私密预览；公网DNS与域名发布不是这次迁移的自动步骤。

代码来源为 `https://github.com/ohtautau/ottbot.git`。仓库只存程序和空白示例，服务器密码、SSH 私钥、微信绑定、Codex 登录和 API Key 都不进入 Git。

## 首次部署

以 `ubuntu` 登录 Ubuntu x86_64 服务器：

```sh
git clone https://github.com/ohtautau/ottbot.git /home/ubuntu/ottbot-source
python3 /home/ubuntu/ottbot-source/bridge/deploy-server.py
```

部署脚本校验官方 Node 与 Codex 归档，运行测试，把当前 Git 提交发布到 `~/ottbot-relay/releases/<commit>`，再切换服务。默认执行目录为 `~/ottbot-workspace`，服务器 Codex 保持只读；接入博客授权工具后另行配置。程序端口只监听 `127.0.0.1`，不对公网开放模型接口。用户级 systemd 和 linger 保证退出 SSH 后服务仍运行。

默认使用 ChatGPT 账号的 Codex 登录，不配置付费 API。运行 `~/ottbot-relay/tools/paths.json` 中的 Codex 可执行文件，使用 `login --device-auth` 完成官方账号授权；浏览器登录也可通过官方 SSH 本地回调方式完成。登录完成不代表模型权限和额度验证成功，应额外做一次真实回复测试。

微信绑定与游标位于 `~/ottbot-relay/shared/weixin-account.json`、`weixin-cursor.json`。从旧服务器迁移时保留原绑定，先停止旧接收服务，再经 SSH 传输这两个私有文件并启动新接收服务，避免同一绑定同时消费消息。无需重新创建机器人。迁移失败可停止新接收端后恢复旧端。

```sh
systemctl --user start ottbot-weixin.service
systemctl --user status ottbot-codex.service ottbot-hub.service ottbot-weixin.service
```

电脑端的 SSH 目标、known_hosts 和私有转接密钥必须与新服务器一致。密钥不通过 GitHub 同步；本机 `local-state/codex-bridge/worker.json` 保留电脑 Codex 路径和工作区，修改连接目标后重启本机代理。电脑在线且代理运行才能接受 `/电脑` 任务。

## 后续更新

本机检查、提交并 push GitHub；服务器只拉取已提交的版本：

```sh
git -C /home/ubuntu/ottbot-source pull --ff-only
python3 /home/ubuntu/ottbot-source/bridge/deploy-server.py
```

部署不会把微信绑定或 API Key 覆盖为空白示例，也不会修改博客数据库或公网域名。已经运行的微信进程在更新代码后需要重启；确认授权后使用 `--start-weixin` 同时重启接收端。

## 微信里的模型切换

- `/模型`：查看当前模型和用法。
- `/推理`：查看当前模型的推理档位；`/推理 low|medium|high|xhigh|max|ultra` 设置，`/推理 auto` 恢复模型默认值。以模型能力缓存为准，Luna 不接受 ultra；不支持的值拒绝保存。API 通道尚未接入各提供商的推理参数。
- `/推理 0|1|2|3|4|5|6`：数字方式，对应 auto、low、medium、high、xhigh、max、ultra；编号固定，切换模型时不重新编号。菜单标注当前选择，只显示当前模型支持的档位。
- `/模型 luna`、`/模型 sol`、`/模型 terra`、`/模型 astra`：ChatGPT 账号的 Codex 模型。
- `/模型 codex/sol`：明确回到 Codex 通道。
- `/模型 gpt-完整模型名称`：指定账号可用的其他 Codex 模型；切换不验证实际权限，真实调用失败会报告。
- `/模型 deepseek/deepseek-flash`、`/模型 qwen/qwen-plus`：使用明确配置的 API，按提供商计费。
- `/执行 服务器`、`/执行 电脑`：切换默认执行端。
- `/服务器 任务`、`/电脑 任务`：指定本次执行端，离线时不转移。
- `/清空`：清空短期对话上下文，不删除微信聊天记录或博客数据。

日常文字直接发给机器人即可。对话仅保留每个执行端、每个模型最近约六轮文字上下文，重启后清空。图片仅用于本轮识别，保存到博客需另接上传授权工具。模型列表不代表账号已获得全部模型权限。

## 可选付费 API

服务器初始 `~/ottbot-relay/shared/providers.json` 来自 `providers.example.json`，所有 API 都禁用且无 Key。通过 SSH 私下填写提供商的完整 Chat Completions HTTPS 地址、API Key，再设 `enabled: true`，文件权限保持 `600`。Qwen 的地址需要与 Key 所属地域和业务空间一致；示例中的 `YOUR_WORKSPACE` 必须替换。

API 配置每次切换和调用时读取，通常不用重启。只在绑定微信的 `/api add` 专用步骤填写 Key，不在普通对话粘贴；微信聊天记录仍可能保留。不要把私有 `providers.json` 加进 Git。不自动充值，不在 Codex 失败时调用 API。API 当前为独立聊天适配器，不具备 Codex 的本机执行工具。

官方协议依据：[微信通道](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)、[Codex 认证](https://learn.chatgpt.com/docs/auth)、[DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/)、[Qwen](https://help.aliyun.com/en/model-studio/first-api-call-to-qwen)。

## 微信分步配置 API

仅绑定账号私聊可用。发送 `/api add`，依次填写提供商英文标识、完整 HTTPS Chat Completions 地址、API Key、模型 ID；发送“确认”或 `/api save` 后原子保存到服务器 `shared/providers.json`（600权限）。同名提供商更新并保留已登记模型列表。

配置期间所有输入都由接收端消费，不进入模型或对话历史；Key 不回显，不写日志或待确认文件。微信平台聊天记录仍可能保留输入，用户可自行处理。等待配置时不执行其他任务；`/api cancel` 放弃并恢复普通对话。

十分钟超时或接收服务重启后，非敏感的待配置标记会继续拦截输入，直到 `/api add` 重新开始或 `/api cancel` 明确退出，避免迟到的 Key 成为普通聊天。待确认值只在内存，不复制 Codex 登录或博客管理员凭据。

保存不调用付费 API、不自动切换。发送 `/m 提供商/模型ID` 或 `/m 提供商` 明确选择后，普通消息才调用对应 API。`/api list` 只返回提供商、模型和 Key 是否已填写。已配置 API 会显示在 `/m` 菜单，所有模型显示提供商与完整模型 ID；别名没有披露固定版本时不猜测底层版本。

API模型统一编号：启动接收服务与保存配置时为已登记模型分配持久编号（5起），已有编号不重排，/m菜单统一显示。/api和/api list只列已填写Key及模型的提供商，不显示未配置的示例占位。切换可用/m 数字，也保留完整提供商/模型ID兼容写法。
