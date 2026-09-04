@echo off
REM ======================================
REM Local Bridge Runner for Cloud Setup
REM OVERWRITES: Set your Railway URL below!
REM ======================================

REM ⬇⬇⬇ REPLACE THIS WITH YOUR RAILWAY URL ⬇⬇⬇
REM Find it at: https://railway.com/project/7f0bbf70-32c4-4be3-9d7c-50ac406b8eb6
REM It looks like: https://your-service-name.up.railway.app
set CLOUD_SERVER_URL=wss://YOUR_ACTUAL_RAILWAY_URL.up.railway.app:5000

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