@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ================================================
echo        LUNA - Chrome + Local Img2Img
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

if not exist "luna-app\package.json" (
  echo Luna package file is missing: luna-app\package.json
  pause
  exit /b 1
)

set "SDDIR=%~dp0stable-diffusion"
set "SDEXE=%SDDIR%\sd-server.exe"
set "SDZIP=%TEMP%\luna-sdcpp-vulkan.zip"

if not exist "%SDEXE%" (
  echo Local image engine is missing.
  echo Downloading the latest official stable-diffusion.cpp Windows Vulkan build...
  if not exist "%SDDIR%" mkdir "%SDDIR%"

  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $api=Invoke-RestMethod -Headers @{Accept='application/vnd.github+json';'User-Agent'='Luna-Mira'} -Uri 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest'; $asset=$api.assets ^| Where-Object { $_.name -match 'win-vulkan-x64\.zip$' } ^| Select-Object -First 1; if(-not $asset){throw 'No Windows Vulkan release asset was found.'}; Write-Host ('Downloading '+$asset.name); Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile '%SDZIP%';"
  if errorlevel 1 (
    echo.
    echo Could not download stable-diffusion.cpp automatically.
    echo Check your internet connection and run this file again.
    pause
    exit /b 1
  )

  echo Extracting local image engine...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '%SDZIP%' -DestinationPath '%SDDIR%\_extract' -Force; $exe=Get-ChildItem -Path '%SDDIR%\_extract' -Filter 'sd-server.exe' -File -Recurse ^| Select-Object -First 1; if(-not $exe){throw 'sd-server.exe was not found inside the downloaded archive.'}; Copy-Item $exe.FullName '%SDEXE%' -Force; $dir=$exe.Directory.FullName; Get-ChildItem -Path $dir -File ^| Where-Object { $_.Name -ne 'sd-server.exe' } ^| Copy-Item -Destination '%SDDIR%' -Force; Remove-Item '%SDDIR%\_extract' -Recurse -Force;"
  if errorlevel 1 (
    echo.
    echo The stable-diffusion.cpp archive could not be extracted.
    pause
    exit /b 1
  )
  del /q "%SDZIP%" >nul 2>nul
  echo Local image engine installed.
)

if not exist "%SDDIR%\models" mkdir "%SDDIR%\models"

set "MODEL="
for %%F in ("%SDDIR%\models\*.gguf") do if not defined MODEL set "MODEL=%%~fF"
for %%F in ("%SDDIR%\models\*.safetensors") do if not defined MODEL set "MODEL=%%~fF"

if not defined MODEL (
  echo.
  echo No Stable Diffusion model was found in:
  echo   %SDDIR%\models
  echo.
  echo The engine is installed, but img2img needs a model file.
  echo Put a compatible .gguf or .safetensors model in that folder.
  echo Then run start-luna.bat again.
  echo.
  echo The browser will NOT be opened until the local generator is ready.
  pause
  exit /b 1
)

for /f "delims=" %%P in ('powershell -NoProfile -Command "$p='%MODEL%'; $p.Replace('\','/')"') do set "MODEL_UNIX=%%P"

echo Starting local Stable Diffusion.cpp img2img engine...
start "Luna Image Generator" /min cmd /c "cd /d ""%SDDIR%"" && sd-server.exe --listen-ip 127.0.0.1 --listen-port 1234 -m ""%MODEL%"""

echo Waiting for local image generator...
for /l %%N in (1,1,90) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:1234/v1/models' -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto sdready
  timeout /t 1 /nobreak >nul
)

echo.
echo Local Stable Diffusion.cpp did not respond on port 1234.
echo Check the minimized Luna Image Generator window for the model/driver error.
pause
exit /b 1

:sdready
echo Local img2img engine is ready.

echo Starting Luna backend...
start "Luna Backend" /min cmd /c "cd /d ""%~dp0luna-app"" && node server.js"

echo Waiting for Luna backend...
for /l %%N in (1,1,30) do (
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
echo Luna is running in Chrome with local img2img.
echo Close this window when finished.
exit /b 0
