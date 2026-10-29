@echo off
setlocal
cd /d "%~dp0"
title ottbot Codex bridge
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bridge\start-bridge.ps1"
pause
