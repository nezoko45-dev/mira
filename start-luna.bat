@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ================================================
echo          LUNA - Chrome + Local Img2Img
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
set "MODELSDIR=%SDDIR%\models"
set "MODEL=%MODELSDIR%\DreamShaper_8.safetensors"
set "SDZIP=%TEMP%\luna-sd-vulkan.zip"
set "SDDOWNLOAD=https://sourceforge.net/projects/stable-diffusion-cpp.mirror/files/master-872-cc515a0/sd-master-cc515a0-bin-win-vulkan-x64.zip/download"
set "MODELDOWNLOAD=https://civitai.com/api/download/models/128713"

if not exist "%SDDIR%\sd-server.exe" (
  echo.
  echo [1/2] Installing the local Stable Diffusion Vulkan server...
  echo Downloading the official stable-diffusion.cpp Windows Vulkan build.
  echo.
  if not exist "%SDDIR%" mkdir "%SDDIR%"
  if not exist "%SDDOWNLOAD%" goto badsd
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '%SDDOWNLOAD%' -OutFile '%SDZIP%'" 
  if errorlevel 1 goto badsd
  if not exist "%SDZIP%" goto badsd
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '%SDZIP%' -DestinationPath '%SDDIR%\_extract' -Force" 
  if errorlevel 1 goto badsd
  for /r "%SDDIR%\_extract" %%F in (sd-server.exe) do if not exist "%SDDIR%\sd-server.exe" copy /y "%%F" "%SDDIR%\sd-server.exe" >nul
  if not exist "%SDDIR%\sd-server.exe" goto badsd
  rmdir /s /q "%SDDIR%\_extract" >nul 2>nul
  del /q "%SDZIP%" >nul 2>nul
  echo Stable Diffusion server installed.
) else (
  echo Local Stable Diffusion server already installed.
)

echo.
if not exist "%MODELSDIR%" mkdir "%MODELSDIR%"

if not exist "%MODEL%" (
  echo [2/2] Installing the image-to-image model...
  echo.
  echo DreamShaper 8 is a Stable Diffusion 1.5 checkpoint from Civitai.
  echo The download is large and may take several minutes.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '%MODELDOWNLOAD%' -OutFile '%MODEL%'" 
  if errorlevel 1 goto badmodel
  if not exist "%MODEL%" goto badmodel
  echo Image model installed.
) else (
  echo Image model already installed.
)

echo.
echo Starting local Stable Diffusion img2img server...
start "Luna Image Generator" /min cmd /c "cd /d ""%SDDIR%"" && sd-server.exe --listen-ip 127.0.0.1 --listen-port 1234 -m ""%MODEL%"""

echo Waiting for local image generator...
for /l %%N in (1,1,90) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%SDURL%/v1/models' -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto sdready
  timeout /t 1 /nobreak >nul
)

echo.
echo Stable Diffusion did not respond on port 1234.
echo Check the minimized Luna Image Generator window for the model/driver error.
pause
exit /b 1

:sdready
echo Local img2img server is ready.
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
echo Luna is running in Chrome with local image-to-image generation.
echo Keep both minimized server windows open while using Luna.
echo.
exit /b 0

:badsd
echo.
echo ERROR: Could not install stable-diffusion.cpp.
echo Download URL:
echo %SDDOWNLOAD%
echo.
pause
exit /b 1

:badmodel
echo.
echo ERROR: Could not download the DreamShaper 8 model.
echo The local img2img server needs a model file to generate frames.
echo.
echo You can retry this launcher to try the download again.
echo.
pause
exit /b 1
