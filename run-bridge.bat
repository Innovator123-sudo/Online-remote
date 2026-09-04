@echo off
REM ======================================
REM Local Bridge Runner for Cloud Setup
REM OVERWRITES: Set your Railway URL below!
REM ======================================

REM ⬇⬇⬇ REPLACE THIS WITH YOUR RAILWAY URL ⬇⬇⬇
set CLOUD_SERVER_URL=wss://android-tv-remote-production.up.railway.app:5000

echo.
echo ========================================
echo   Android TV Remote - Bridge Agent
echo ========================================
echo.
echo Cloud Server: %CLOUD_SERVER_URL%
echo.
echo Make sure this computer stays ON for remote access!
echo.

REM Check if dependencies are installed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

echo Starting bridge agent...
echo Press Ctrl+C to stop
echo.

node facilities/remote-bridge.js

pause