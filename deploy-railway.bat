@echo off
REM ======================================
REM Railway Cloud Server Deployment Script
REM This deploys your cloud relay server
REM ======================================

echo.
echo ========================================
echo   Android TV Remote - Cloud Deployment
echo ========================================
echo.
echo This script will help you deploy the cloud server to Railway.app
echo Your remote will work 24/7, even when laptop is OFF!
echo.

echo STEP 1: Pushing code to GitHub...
echo Please replace YOUR-USERNAME and YOUR-REPO below:
echo.

git init
git add .
git commit -m "Cloud deployment ready"

echo.
echo Next: Create a GitHub repo at https://github.com/new
echo Then run: git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
echo      git branch -M main
echo      git push -u origin main
echo.

echo STEP 2: Deploy to Railway.app (https://railway.app/)
echo - Sign in with GitHub
echo - Create new project
echo - Deploy from GitHub repo
echo - Set start command: node facilities/remote-cloud-server.js
echo - Add environment: NODE_ENV=production
echo.

echo STEP 3: After deployment, copy your Railway URL
echo Then configure your bridge with:
echo $env:CLOUD_SERVER_URL="wss://your-url.railway.app:5000"
echo node facilities/remote-bridge.js
echo.

pause