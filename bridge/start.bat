@echo off
echo ========================================
echo TV Control Hub - Bridge Setup
echo ========================================
echo.

echo Step 1: Installing bridge dependencies...
cd bridge
call npm install
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies
    echo Make sure Node.js is installed
    pause
    exit /b 1
)

echo.
echo Step 2: Starting bridge server...
echo Bridge will start on http://localhost:3001
echo Press Ctrl+C to stop the bridge
echo.
call npm start