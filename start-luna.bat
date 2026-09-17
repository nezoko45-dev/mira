@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ================================================
echo              LUNA - Chrome Launcher
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found.
  echo Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)

if not exist "luna-app\server.js" (
  echo Luna backend is missing: luna-app\server.js
  pause
  exit /b 1
)

if not exist "luna-app\index.html" (
  echo Luna Chrome UI is missing: luna-app\index.html
  pause
  exit /b 1
)

set "SDDIR=%~dp0stable-diffusion"
set "SDURL=http://127.0.0.1:1234"

if not exist "%SDDIR%\sd-server.exe" (
  echo.
  echo Local Stable Diffusion is not installed yet.
  echo.
  echo The launcher cannot download the SD server automatically yet.
  echo Put sd-server.exe and its model files in:
  echo %SDDIR%
  echo.
  echo Luna will still start, but AI speaking frames will use the source image.
  echo.
) else (
  echo Starting local Stable Diffusion server...
  start "Luna Image Generator" /min cmd /c "cd /d ""%SDDIR%"" && sd-server.exe --host 127.0.0.1 --port 1234"
  echo Waiting for local image generator...
  for /l %%N in (1,1,45) do (
    powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%SDURL%/v1/models' -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
    if not errorlevel 1 goto sdready
    timeout /t 1 /nobreak >nul
  )
  echo.
  echo Stable Diffusion did not respond on port 1234.
  echo Check the minimized Luna Image Generator window.
  echo Luna will continue without generated frames.
)

:sdready
echo.
echo Starting Luna backend...
start "Luna Backend" /min cmd /c "cd /d ""%~dp0luna-app"" && node server.js"

echo Waiting for Luna backend...
for /l %%N in (1,1,20) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)

echo Luna backend did not respond on port 8787.
echo Check the minimized Luna Backend window for the error.
pause
exit /b 1

:ready
echo Luna backend is ready.
echo Opening Luna in Chrome...
start "" "http://127.0.0.1:8787"
echo.
echo Luna is running in Chrome.
echo Keep the minimized Luna Image Generator window open while using Luna.
echo.
exit /b 0
