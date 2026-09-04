@echo off
echo ========================================
echo Cast Remote - Same Wi-Fi Website
echo ========================================
echo.
echo The remote needs NO server, but this opens it
echo on your home network for phones without internet.
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

start "Cast Remote" cmd /k "node server.js"
timeout /t 3 /nobreak >nul
start http://localhost:5000
echo.
echo Open the printed LAN URL on your phone (same Wi-Fi).
echo To stop: close the server window
pause
