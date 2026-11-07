@echo off
setlocal
cd /d "%~dp0"
start "" powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0bridge\stop-bridge.ps1"
