# 微信与 Codex 转接

微信消息由服务器常驻接收，再交给服务器或在线电脑执行。CodeBuddy 是可选入口；普通微信消息不需要经过桌面 CodeBuddy。

部署、更新、登录、迁移与模型配置见 [GitHub 部署说明](DEPLOYMENT.md)。服务器代码与私有配置分开保存，代码通过 GitHub 同步。

## 微信指令

- `/状态`：查看服务器、Codex 登录与电脑连接。
- `/推理`：查看当前模型支持的推理档位；`/推理 medium` 修改，`/推理 auto` 使用模型默认值。设置从下一条任务生效，重启保留；当前只适用于 Codex 通道。
- 数字快捷设置：`/推理 0` 默认、`1` 低、`2` 中、`3` 高、`4` 超高、`5` 最大、`6` 极致。每个数字都需带 `/推理` 前缀；编号不随模型变化，不支持的档位拒绝设置，`/推理` 显示可用编号和当前选择。
- `/服务器 任务`、`/电脑 任务`：选择本次执行位置。
- `/执行 服务器`、`/执行 电脑`：设置默认执行位置。电脑离线时不转移任务。
- `/模型 luna|sol|terra|astra`：使用 ChatGPT 账号的 Codex 模型。
- `/模型 gpt-完整模型名称`：使用账号可用的其他 Codex 模型。
- `/模型 deepseek/deepseek-flash`、`/模型 qwen/qwen-plus`：使用服务器已配置的付费 API。
- `/模型 codex/sol`：回到 Codex 账号通道。
- `/清空`：清空接收进程的短期对话上下文。

日常聊天直接发送文字即可。模型与默认执行端设置适用于此私人服务的所有会话。不同执行端、不同模型的历史分开保存，重启清空；本轮最多四张 PNG/JPEG/WebP 照片，每张不超过 10MB。照片识别不等于已保存到博客。

Codex 通道每次调用前验证 ChatGPT 登录，忽略 API Key 环境变量，不回退到付费 API。API 需要先在服务器私有 `shared/providers.json` 中明确启用并配置 Key；未配置时拒绝切换。API 当前仅聊天和已启用的图片输入，未接博客或电脑工具。不要把 API Key 发到微信。

服务器 Codex 默认只读；电脑权限以本机私有配置的沙箱和工作区为准。博客写入需要单独接入经过认证的内容、上传等接口；图形界面控制尚未接入。失败时如实报告，不能把通道连通当作操作成功。

## 本机代理与 CodeBuddy

新建本机配置时设置 `OTTBOT_SSH_TARGET` 和 `OTTBOT_SSH_KEY`，可选 `OTTBOT_KNOWN_HOSTS`、`OTTBOT_WORKSPACE`，再运行 `node bridge/prepare-local.mjs <Codex可执行文件路径>`。私有配置位于已忽略的 `local-state/codex-bridge`。核对 SSH 主机指纹后再启动代理。

双击 `start-codex-bridge.cmd` 启动电脑代理，`stop-codex-bridge.cmd` 停止。电脑需要开机、代理运行且网络在线，未自动设置开机自启。

CodeBuddy 自定义模型填写本机 `local-state/codex-bridge/codebuddy-settings.txt` 中的地址和转接密钥，模型名为 `codex-local`；工具调用不勾选，图片输入可勾选，推理模式和思考强度留空。转接密钥不是 OpenAI API Key。消息进入独立 Codex 执行会话，不会进入当前桌面聊天。

所有模型端口只监听回环地址，电脑与服务器间使用 SSH 隧道。微信仅接受绑定账号私聊。请求串行，忙碌时拒绝新任务，超时取消子进程。不要将私人服务分享给多人。

## 验证

```sh
node --test bridge/worker.test.mjs bridge/hub.test.mjs bridge/weixin.test.mjs bridge/models.test.mjs
```

测试使用临时配置、模拟 Codex 和 API，不调用真实付费模型、不写入博客。实际登录、照片、博客授权写入和电脑操作需要分别验收。

统一指令规范见 [COMMANDS.md](COMMANDS.md)，包含中文、英文、缩写、帮助主题与参数边界。
