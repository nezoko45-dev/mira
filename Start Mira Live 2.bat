@echo off
setlocal
title Mira Live 2
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
 echo Node.js is not installed.
 pause
 exit /b 1
)
if not exist "node_modules\express" call npm.cmd install
if errorlevel 1 (
 echo Dependency installation failed.
 pause
 exit /b 1
)
start "Mira Live 2 Server" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8787/live2/"
echo Mira Live 2 is starting...
pause