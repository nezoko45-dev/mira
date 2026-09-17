@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ================================================
echo        LUNA - Wav2Lip one-click setup
echo ================================================
echo.

where py >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Installing Python 3.11 with winget...
  winget install --id Python.Python.3.11 -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo Python installation failed. Install Python 3.11 and run this file again.
    pause
    exit /b 1
  )
  set "PATH=%LocalAppData%\Programs\Python\Python311;%LocalAppData%\Programs\Python\Python311\Scripts;%PATH%"
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Installing Node.js LTS with winget...
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo Node.js installation failed. Install Node.js LTS and run this file again.
    pause
    exit /b 1
  )
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo FFmpeg was not found. Installing FFmpeg with winget...
  winget install --id Gyan.FFmpeg.Shared -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo FFmpeg installation failed. Install FFmpeg and run this file again.
    pause
    exit /b 1
  )
)

where git >nul 2>nul
if errorlevel 1 (
  echo Git was not found. Installing Git with winget...
  winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo Git installation failed.
    pause
    exit /b 1
  )
  set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
)

if not exist "wav2lip\inference.py" (
  echo.
  echo Downloading Wav2Lip engine...
  git clone --depth 1 https://github.com/Mozer/wav2lip.git wav2lip
  if errorlevel 1 (
    echo Failed to download Wav2Lip.
    pause
    exit /b 1
  )
)

if not exist "wav2lip\checkpoints" mkdir "wav2lip\checkpoints"
if not exist "wav2lip\checkpoints\wav2lip.pth" (
  echo.
  echo Downloading Wav2Lip model checkpoint. This is a large file...
  curl.exe -L --fail --retry 3 -o "wav2lip\checkpoints\wav2lip.pth" "https://github.com/justinjohn0306/Wav2Lip/releases/download/models/wav2lip.pth"
  if errorlevel 1 (
    echo Checkpoint download failed. Run setup-luna.bat again to retry.
    pause
    exit /b 1
  )
)

if not exist "wav2lip\face_detection\detection\sfd" mkdir "wav2lip\face_detection\detection\sfd"
if not exist "wav2lip\face_detection\detection\sfd\s3fd.pth" (
  echo Downloading Wav2Lip face detector...
  curl.exe -L --fail --retry 3 -o "wav2lip\face_detection\detection\sfd\s3fd.pth" "https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth"
  if errorlevel 1 (
    echo Face detector download failed. Run setup-luna.bat again to retry.
    pause
    exit /b 1
  )
)

rem The upstream detector expects torch to be available as a module name.
py -3.11 -c "from pathlib import Path; p=Path(r'wav2lip/face_detection/detection/sfd/sfd_detector.py'); s=p.read_text(encoding='utf-8'); p.write_text(('import torch\n'+s) if not s.startswith('import torch') else s, encoding='utf-8')"

echo.
echo Installing Python packages. This can take a while the first time...
py -3.11 -m pip install --upgrade pip
py -3.11 -m pip install torch torchvision
py -3.11 -m pip install -r "luna-app\requirements-wav2lip.txt"
if errorlevel 1 (
  echo Python dependency installation failed.
  pause
  exit /b 1
)

echo.
echo ================================================
echo Setup complete!
echo Run start-luna.bat to launch Luna.
echo ================================================
pause
