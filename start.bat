@echo off
echo ========================================
echo Online Remote - Home Helper
echo ========================================
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)
if not exist node_modules (
    echo Installing helper libraries (one time)...
    call npm install --no-audit --no-fund
)
start "Online Remote" cmd /k "node helper.js"
timeout /t 3 /nobreak >nul
start http://localhost:5000
echo.
echo Open the printed LAN URL on your phone (same Wi-Fi).
echo To stop: close the server window
pause
