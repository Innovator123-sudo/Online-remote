@echo off
echo ========================================
echo TV Control Hub - Quick Start (Unified)
echo ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

echo Starting unified server (website + bridge) on http://localhost:5000 ...
echo.

REM Start unified server in new window
start "TV Control Hub" cmd /k "node server.js"

REM Wait for server to start
timeout /t 3 /nobreak >nul

echo Opening website...
start http://localhost:5000

echo.
echo ========================================
echo Server running at http://localhost:5000
echo Bridge API at http://localhost:3000/status and http://localhost:3001/status
echo.
echo - Click SCAN (shows TVs in <2s, Wi-Fi OK)
echo - Or click QUICK DEMO for instant demo TVs
echo - Pair with any 6 digits (except 000000)
echo ========================================
echo.
echo To stop: close the server window
pause
