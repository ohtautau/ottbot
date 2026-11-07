@echo off
setlocal
cd /d "%~dp0"
start "" powershell.exe -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0bridge\tray-bridge.ps1" -ShowStatus
