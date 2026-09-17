@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "wav2lip\inference.py" (
  echo Luna has not been set up yet.
  echo Running setup-luna.bat now...
  call "%~dp0setup-luna.bat"
  if errorlevel 1 exit /b 1
)

where py >nul 2>nul
if errorlevel 1 (
  echo Python 3.11 is missing. Run setup-luna.bat.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing. Run setup-luna.bat.
  pause
  exit /b 1
)

if not exist "luna-app\server.js" (
  echo Luna backend is missing.
  pause
  exit /b 1
)

if not exist "luna-app\index.html" (
  echo Luna Chrome UI is missing.
  pause
  exit /b 1
)

if not exist "luna-app\wav2lip_service.py" (
  echo Wav2Lip service is missing.
  pause
  exit /b 1
)

echo Starting Wav2Lip engine...
start "Luna Wav2Lip" /min cmd /c "cd /d "%~dp0" && py -3.11 luna-app\wav2lip_service.py > Wav2Lip.log 2>&1"

echo Waiting for Wav2Lip...
for /l %%N in (1,1,30) do (
  powershell -NoProfile -Command "try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:9872/health' -TimeoutSec 1; if($r.ready){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto wavready
  timeout /t 1 /nobreak >nul
)

echo Wav2Lip did not become ready.
echo Check Wav2Lip.log for the reason.
pause
exit /b 1

:wavready
echo Wav2Lip is ready.
echo Starting Luna backend...
start "Luna Backend" /min cmd /c "cd /d "%~dp0" && node luna-app\server.js"

timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8787"

echo.
echo Luna is running in Chrome.
echo Close the two minimized Luna windows to stop the app.
echo.
exit /b 0
