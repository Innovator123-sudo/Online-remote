# 🚀 QUICKSTART: Deploy TV Control Hub to the Cloud

## Choose Your Deployment Option

---

## Option 1: Self-Hosted on Same Network as TVs (Recommended)

**Best for:** Raspberry Pi, old laptop, or VPS on your home network

### Steps:
```bash
# 1. Transfer files to your device
# (copy all files from this folder)

# 2. Install dependencies (optional but recommended)
npm install

# 3. Configure your TV
export TVS_CONFIG='[{"name":"My TV","ip":"192.168.1.100"}]'

# 4. Run the server
PORT=80 node server.js

# 5. Open browser at https://YOUR_IP:80
```

### Port Forwarding (to access from anywhere):
1. Log into your router admin panel
2. Port forward external port 443 → internal port 80
3. Access via: `https://your-public-ip`

---

## Option 2: Render.com (Easy Cloud Hosting)

**Best for:** Zero-config cloud deployment

### Steps:
```bash
# 1. Initialize git if not already done
git init
git add .
git commit -m "initial deploy"
git branch -M main
git remote add origin YOUR_GITHUB_URL
git push -u origin main
```

2. Go to [render.com](https://render.com) → New Web Service
3. Connect your GitHub repository
4. Environment variables:
   ```
   TV_DISCOVERY_MODE=manual
   TVS_CONFIG='[{\"name\":\"Living Room TV\",\"ip\":\"192.168.1.100\"}]'
   API_KEY=your-secret-key-here
   NODE_ENV=production
   ```
5. Deploy! (takes ~3 minutes)

6. Access your app at `https://your-app-name.onrender.com`

---

## Option 3: Hybrid (Cloud + Local Bridge)

**Best for:** Maximum security, commands execute locally

### Setup:
1. **Deploy main app to Render.com** (see Option 2)
2. **Run local bridge at home:**
   ```bash
   npm install ws
   export CLOUD_SERVER=wss://your-app.onrender.com
   export BRIDGE_MODE=websocket
   node local-bridge.js
   ```
3. **Update app.js** to connect WebSocket to cloud server

Commands enter the cloud, but execute via the local bridge on your network.

---

## 📱 Using the App

### Default Controls:
1. **Open browser** at your server URL
2. **Pair with TV:** Enter 6-digit code shown on TV
3. **Use gestures:**
   - 👆 Tap → Click
   - 👆👆 Double tap → Home
   - ☝️ Swipe up/down/left/right → Navigation
   - ☝️ Long press → Menu

### Keyboard Mode:
Click the keyboard icon and type directly!

---

## 🔧 Configuration

### TVS_CONFIG Format:
```json
[
  {"name":"Living Room TV", "ip":"192.168.1.101", "model":"Samsung TV"},
  {"name":"Bedroom TV", "ip":"192.168.1.102", "model":"Sony Bravia"}
]
```

For Render.com, escape quotes:
```
'[{\"name\":\"TV\",\"ip\":\"192.168.1.101\"}]'
```

Or convert here: https://eloforms.io/json-yaml-converter

### Environment Variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `TV_DISCOVERY_MODE` | Discovery method | `manual` |
| `TVS_CONFIG` | TV list | see above |
| `API_KEY` | Authentication | `my-secret-key` |
| `ENABLE_MOCK_TVS` | Demo mode | `false` |
| `PORT` | Server port | `80` |

---

## 🛡️ Security Checklist

Before going live:
- [ ] Set a secure `API_KEY` (use `openssl rand -hex 32`)
- [ ] Set `ALLOWED_ORIGINS` to your domain
- [ ] Put TVs on a separate VLAN if possible
- [ ] Enable ADB debug authorization (accept on TV)
- [ ] Test manually: `adb connect 192.168.x.x:5555`

---

## 🐛 Troubleshooting

### "Command not executing"
1. Check ADB authorization on TV (Settings → Developer Options)
2. Verify TV IP is correct
3. Test: `adb connect 192.168.x.x:5555`

### "TVs not discovered"
- SSDP doesn't work across networks
- Solution: Use `TVS_CONFIG` with manual IP (see above)

### "Camera not working"
- Browsers require HTTPS for camera
- Render.com provides HTTPS automatically
- Self-hosted: Use Let's Encrypt or similar

### "App is slow/laggy"
- Ensure good WiFi signal to your device
- Try lowering video quality in settings
- Close other bandwidth-heavy apps

---

## 📚 Documentation

- **Full Guide:** `README_CLOUD_DEPLOYMENT.md`
- **WebSocket Info:** `websocket-server.js` comments
- **Bridge Mode:** `local-bridge.js` comments
- **Configuration:** `.env.example`

---

## 💡 Next Steps

Once deployed:
1. **PWA Installation:** Add `manifest.json` for installable app
2. **Custom Gestures:** Edit `app.js` gesture recognition
3. **Multi-user Auth:** Add user accounts if needed
4. **Logging:** Integrate Winston or CloudWatch
5. **Monitoring:** Set up uptime monitoring

---

Questions? Check `README_CLOUD_DEPLOYMENT.md` or review the code comments!

Made with ❤️ for seamless TV control