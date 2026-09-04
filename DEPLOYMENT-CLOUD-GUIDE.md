# 🌐 Android TV Remote - Cloud Deployment Guide

## 🚀 **DEPLOY IN 10 MINUTES - WORKS 24/7 (Even When Laptop is OFF!)**

---

## 📋 **YOU'LL NEED:**

1. ✅ GitHub account (free)
2. ✅ Railway account (free) 
3. ✅ Android TV/Google TV (NOT Samsung/LG)
4. ✅ Raspberry Pi / old phone / always-on PC (for bridge - OPTIONAL)

---

## 🌤️ **STEP 1: DEPLOY CLOUD SERVER TO RAILWAY (5 MINUTES)**

### 1.1 Push Code to GitHub
```bash
cd "c:\Users\Samrat\Desktop\robloc fame"
git init
git add .
git commit -m "Initial commit"
```

Create repository on GitHub (github.com/new) and push:
```bash
git remote add origin https://github.com/Innovator123-sudo/Online-remote.git
git branch -M main
git push -u origin main
```

### 1.2 Deploy to Railway.app
1. Go to https://railway.app/
2. Sign in with GitHub
3. Click **"New Project"** → **"Deploy from GitHub repo"**
4. Select your repository
5. Click the project
6. Click **"New"** → **"Start with a template"** → **"Node.js"**

7. **Add Environment Variables:**
   - Click on your service → Variables tab
   - Add: `NODE_ENV=production`
   - Add: `PORT=5000`

8. **Change Start Command:**
   - Click on your service → Settings tab
   - Start Command: `node facilities/remote-cloud-server.js`

9. Railway will auto-deploy. Wait 2-3 minutes.

10. **Get your URL:** Click on your service → Click "Deployments" → Copy the public URL
    - Example: `https://android-tv-remote-production.up.railway.app`

---

## 📡 **STEP 2: RUN BRIDGE AGENT AT HOME (3 OPTIONS)**

### **Option A: Run on Laptop (Temp - 5 MINUTES)**
**⚠️ Laptop must stay ON**
```bash
cd "c:\Users\Samrat\Desktop\robloc fame"
npm install

# Set cloud URL (YOUR Railway URL!)
$env:CLOUD_SERVER_URL="wss://android-tv-remote-production.up.railway.app:5000"
node facilities/remote-bridge.js
```

You should see:
```
🏠 Android TV Remote - Bridge Agent
✅ Connected to cloud relay server
🆔 Bridge ID: xxxxxxxx
🚀 Bridge agent is running. Keep this device ON for remote access.
```

### **Option B: Run on Raspberry Pi (RECOMMENDED - 24/7)**
Best for always-on remote access even when laptop is OFF:

```bash
# On Raspberry Pi
git clone YOUR_REPO
cd robloc-fame
npm install

# Set cloud URL
export CLOUD_SERVER_URL=wss://android-tv-remote-production.up.railway.app:5000

# Run with PM2 (process manager)
npm install -g pm2
pm2 start facilities/remote-bridge.js --name tv-bridge
pm2 startup
pm2 save
```

### **Option C: Run on Docker (24/7)**
On any always-on device:

```bash
cd facilities
$env:CLOUD_SERVER_URL="wss://android-tv-remote-production.up.railway.app:5000"
docker-compose up -d bridge-agent
```

---

## 📱 **STEP 3: ACCESS THE REMOTE (2 MINUTES)**

### **Option A: Host Frontend on Vercel**
1. Go to https://vercel.com/
2. Import your GitHub repo
3. Add environment variable: `CLOUD_SERVER_URL=wss://android-tv-remote-production.up.railway.app:5000`
4. Deploy
5. Access from anywhere!

### **Option B: Use Direct Link**
While developing, open your browser to:
```
http://localhost:5000
```
**BUT** if connecting from another device, use:
```
http://YOUR_IP:5000
```
Or deploy the frontend to Vercel/Netlify for access from ANYWHERE.

---

## ✅ **TESTING IT WORKS**

1. Open the remote app (phone or another device)
2. Click **SCAN** button
3. Wait 5-10 seconds
4. Your TV should appear!
5. Click on TV name → Try buttons (power, volume, directional)

---

## 🎯 **TROUBLESHOOTING**

### "No TVs found" Error
✅ **Check:**
- TV is Android TV/Google TV (Sony, Toshiba, Hisense, Chromecast)
- TV is POWERED ON (not sleep mode)
- Bridge computer is ON and connected to same Wi-Fi as TV
- Bridge has `CLOUD_SERVER_URL` set correctly
- Firewall allows UDP port 57300

### TV Doesn't Respond to Commands
✅ **Enable ADB on TV:**
- Settings → Device Preferences → About → Click "Build" 7 times
- Back → Developer options → Turn ON "ADB debugging"
- Settings → Apps → Android TV Remote Control → Allow remote

### Bridge Not Connecting to Cloud
✅ **Check:**
```bash
node facilities/remote-bridge.js
```
You should see "✅ Connected to cloud relay server"
If not, check your Railway URL is correct.

---

## 🏗️ **ARCHITECTURE**

```
Your Phone (Anywhere on Internet)
    ↓
Vercel Frontend (https://your-app.vercel.app)
    ↓
Railway WebSocket (wss://android-tv-remote-production.up.railway.app)
    ↓
Bridge Agent (Raspberry Pi / PC on Home Network)
    ↓
Android TV (Same Wi-Fi, port 6466/6467 or ADB 5555)
```

---

## 💰 **COST**

- **Railway:** FREE tier (500 hours/month = always on)
- **GitHub:** FREE
- **Vercel:** FREE  
- **Raspberry Pi:** Optional ($35-55 one-time, or use old phone/PC)

**Total: $0 to test, $35 one-time for 24/7**

---

## 🎉 **YOU'RE DONE!**

Your TV remote now works:
✅ From anywhere in the world
✅ 24/7 even when laptop is off (with Pi)
✅ Free to run

---

## 🆘 **NEED HELP?**

Issues? Check the Railway logs:
1. railway.app → Your project → Click service → Logs tab
2. Check for any error messages

Bridge issues? Check bridge console for connection status.