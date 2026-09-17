@echo off
cd /d "%~dp0"
start "Mira Backend" "%~dp0MiraBackend.exe"
timeout /t 2 /nobreak >nul
start "Mira Chrome" "http://127.0.0.1:47821/"
exit /b 0
