@echo off
setlocal
cd /d "%~dp0"
echo.
echo ==========================================
echo            MIRA - LOCAL BACKEND
echo ==========================================
echo.
echo Starting the built-in Windows backend...
echo Browser: http://127.0.0.1:8787/
echo.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8787/"
echo Mira is running. Leave the backend window open.
