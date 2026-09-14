@echo off
setlocal
cd /d "%~dp0"
start "Luna Backend" /min "%~dp0Luna-Backend\Luna-Backend.exe"

echo Starting Luna backend...
for /l %%N in (1,1,90) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/health -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)
echo Backend did not start. Check the Luna-Backend window/logs.
pause
exit /b 1

:ready
echo Luna backend is ready.
where chrome.exe >nul 2>&1
if not errorlevel 1 (
  start "Luna" chrome.exe --app=http://127.0.0.1:8765/
) else (
  start "Luna" http://127.0.0.1:8765/
)
exit /b 0
