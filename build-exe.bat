@echo off
setlocal
cd /d "%~dp0"
title Building CalendarWidget.exe

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Trying to install it with winget...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo.
    echo winget not found. Install Node.js LTS from https://nodejs.org , then run this file again.
    pause
    exit /b 1
  )
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  echo.
  echo Node.js installed. CLOSE this window and run build-exe.bat once more.
  pause
  exit /b 0
)

echo Installing dependencies (first time takes a few minutes)...
call npm install
if errorlevel 1 goto fail

echo Building CalendarWidget.exe ...
call npm run dist
if errorlevel 1 goto fail

echo.
echo DONE: dist\CalendarWidget.exe
start "" "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo Build failed. Send the text above to the assistant.
pause
exit /b 1
