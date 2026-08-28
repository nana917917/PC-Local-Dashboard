@echo off
setlocal
title PC Local Dashboard Setup
set "SCRIPT_DIR=%~dp0"

echo PC Local Dashboard Setup
echo.

if not exist "%SCRIPT_DIR%install.ps1" (
  echo [ERROR] install.ps1 was not found.
  echo Extract the entire ZIP before running SETUP.cmd.
  echo.
  pause
  exit /b 10
)

if not exist "%SCRIPT_DIR%app\server.js" (
  echo [ERROR] The app folder was not found. Extract the entire ZIP again.
  echo.
  pause
  exit /b 11
)

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1"
set "SETUP_RESULT=%ERRORLEVEL%"

if not "%SETUP_RESULT%"=="0" (
  echo.
  echo [FAILED] Setup error code: %SETUP_RESULT%
  echo Details were saved to setup-log.txt.
  echo.
  pause
  exit /b %SETUP_RESULT%
)

echo.
echo [DONE] Setup completed successfully.
pause
exit /b 0
