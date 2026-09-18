@echo off
setlocal
title Mira AI Video Date
cd /d "%~dp0"

echo ========================================
echo        MIRA AI VIDEO DATE
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo.
  echo Install Node.js LTS, then double-click this file again.
  pause
  exit /b 1
)

echo Node.js found.
echo.

if not exist "node_modules\express" (
  echo Installing Mira dependencies...
  echo This may take a minute.
  echo.
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo ERROR: Dependency installation failed.
    echo Check your internet connection and try again.
    pause
    exit /b 1
  )
  echo.
  echo Dependencies installed.
  echo.
)

echo Starting Mira server...
start "Mira Server" /min cmd /c "node server.js"

echo Waiting for Mira server...
set /a tries=0

:wait
set /a tries+=1
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8787/' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto ready

if %tries% GEQ 15 (
  echo.
  echo Mira server did not start.
  echo A separate window named "Mira Server" should show the error.
  echo.
  pause
  exit /b 1
)

timeout /t 1 /nobreak >nul
goto wait

:ready
echo Mira server is running!
echo Opening Mira in Chrome...
start "" "http://localhost:8787/"

echo.
echo Mira is running.
echo Keep the Mira Server window open while using the app.
echo.
pause
