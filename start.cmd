@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title ottbot
if not exist "config.json" (
  copy /y "config.example.json" "config.json" >nul
  echo 已创建 config.json。请填写本地配置后重新启动。
  pause
  exit /b 0
)
set "TASK_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "TASK_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "node_modules\@wecom\aibot-node-sdk\package.json" (
  echo 首次启动，正在安装企业微信 SDK，需要联网……
  where npm.cmd >nul 2>nul
  if errorlevel 1 (
    if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" (
      call "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" install --store-dir "./node_modules/.pnpm-store" --node-linker=hoisted --package-import-method=copy --config.enable-global-virtual-store=false
    ) else (
      echo 请先安装 Node.js 22 或更新版本（包含 npm）。
      pause
      exit /b 1
    )
  ) else (
    call npm.cmd install
  )
  if errorlevel 1 (
    echo 安装失败，请检查网络，然后重新运行。
    pause
    exit /b 1
  )
)
"%TASK_NODE%" bot.mjs
pause
