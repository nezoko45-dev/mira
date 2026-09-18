@echo off
setlocal
title Mira AI Video Date
cd /d "%~dp0"

echo Starting Mira...
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing Mira dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

start "" http://localhost:8787
node server.js
pause
