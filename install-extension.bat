@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-extension.ps1"
if errorlevel 1 (
  echo.
  echo Install failed. Press any key to close.
  pause >nul
  exit /b 1
)
echo.
echo Install completed. Press any key to close.
pause >nul
