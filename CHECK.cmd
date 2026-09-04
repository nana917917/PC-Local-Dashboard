@echo off
setlocal
title PC Local Dashboard Check
set "INSTALL_DIR=%LOCALAPPDATA%\PCPowerHistory\app"
set "SOURCE_DIR=%~dp0"

echo PC Local Dashboard 状態確認
echo.
where node.exe 2>nul
if errorlevel 1 (
  echo [NG] Node.js was not found.
) else (
  echo [OK] Node.js
  node.exe --version
)
echo.

if exist "%INSTALL_DIR%\WattSeal.exe" (echo [OK] WattSeal.exe) else (echo [NG] WattSeal.exe is missing)
if exist "%INSTALL_DIR%\server.js" (echo [OK] Dashboard files) else (echo [NG] Dashboard files are missing)
if exist "%INSTALL_DIR%\power_monitoring.db" (echo [OK] Power database) else (echo [WAIT/NG] Power database does not exist yet)
echo.

tasklist /FI "IMAGENAME eq WattSeal.exe" 2>nul | find /I "WattSeal.exe" >nul
if errorlevel 1 (echo [NG] WattSeal process is not running) else (echo [OK] WattSeal process is running)
echo.

if exist "%SOURCE_DIR%setup-log.txt" (
  echo 最新のセットアップ要約ログ:
  echo ----------------------------------------
  powershell.exe -NoProfile -Command "Get-Content -LiteralPath '%SOURCE_DIR%setup-log.txt' -Tail 40"
  echo ----------------------------------------
) else (
  echo setup-log.txt はまだありません。
)
echo.
pause
