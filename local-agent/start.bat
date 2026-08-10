@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required for Veritas local agent.
  pause
  exit /b 1
)
start "Veritas Local Agent" /MIN cmd /c "node keepalive.js"
exit /b 0
