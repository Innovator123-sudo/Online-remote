# Railway Deployment Guide - Android TV Remote

## Complete Step-by-Step Instructions

### Prerequisites
- GitHub account
- Railway account (free tier available)
- Your Android TV on the same network as your bridge agent

---

## PART 1: Deploy Cloud Server to Railway

### Step 1: Prepare Your Repository

1. **Initialize Git (if not already done):**
   `ash
   cd c:\Users\Samrat\Desktop\robloc fame
   git init
   git add .
   git commit -m "Initial commit with cloud deployment"
   `

2. **Create GitHub Repository:**
   - Go to https://github.com/new
   - Create a new repository (public or private)
   - Follow instructions to push your code:
   `ash
   git remote add origin https://github.com/YOUR_USERNAME/your-repo-name.git
   git branch -M main
   git push -u origin main
   `

### Step 2: Deploy to Railway

#### Option A: Deploy from Railway GitHub App (Recommended)

1. **Go to Railway:** https://railway.app

2. **Sign Up/Login:**
   - Click "Start a New Project"
   - Choose "Deploy from GitHub repo"
   - Authorize Railway to access your GitHub account

3. **Select Repository:**
   - Choose your repository from the list
   - Railway will scan the repo

4. **Create New Project:**
   - Click "New Project"
   - Select your repo
   - Railway automatically detects Dockerfile

5. **Configure Service:**
   - Railway creates a service automatically
   - Click on the service to configure

6. **Set Environment Variables:**
   - Go to "Variables" tab
   - Add:
     `
     PORT=5000
     NODE_ENV=production
     `

7. **Configure Network:**
   - Go to "Settings" tab
   - Under "Networking", enable "Public Internet"
   - Railway will assign a public URL

8. **Deploy:**
   - Railway automatically deploys
   - Watch the deployment log
   - Wait for "Deployed" status

9. **Get Your URL:**
   - Go to "Settings" ? "Domains"
   - Copy the domain (e.g., https://your-app-abc123.railway.app)
   - This is your Cloud Server URL

#### Option B: Railway CLI (Alternative)

`ash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Login to your account

# Create new project from current directory
railway init

# Link to existing project
railway link

# Add environment variables
railway variables set PORT=5000
railway variables set NODE_ENV=production

# Enable public network
railway networking expose

# Deploy
railway up
`

### Step 3: Verify Deployment

1. **Check Health:**
   - Open your Railway URL in browser
   - Should show basic server response or error page
   - Check Railway dashboard for running status

2. **View Logs:**
   - Go to Railway dashboard
   - Click on your service
   - View deployment logs
   - Ensure no errors

---

## PART 2: Deploy Bridge Agent at Home

### Option A: Docker Compose (Recommended)

1. **Clone Repository at Home:**
   `ash
   git clone https://github.com/YOUR_USERNAME/your-repo.git
   cd facilities
   `

2. **Create Environment File:**
   `ash
   # Create .env.local file
   echo "CLOUD_SERVER_URL=wss://your-railway-url.railway.app:443" > .env.local
   `

3. **Run with Docker Compose:**
   `ash
   # Edit docker-compose.cloud.yml if needed:
   # Update CLOUD_SERVER_URL with your Railway URL
   
   # Start bridge agent only
   docker-compose -f docker-compose.cloud.yml up -d bridge-agent
   
   # Check status
   docker-compose -f docker-compose.cloud.yml ps
   
   # View logs
   docker-compose -f docker-compose.cloud.yml logs -f bridge-agent
   `

### Option B: Docker Run

`ash
docker run -d \
  --name tv-remote-bridge \
  --network=host \
  -e CLOUD_SERVER_URL=wss://your-railway-url.railway.app:443 \
  -v C:\Users\Samrat\Desktop\robloc fame\facilities:/app \
  node:lts \
  node remote-bridge.js
`

### Option C: Direct Node.js (For Testing)

`ash
# Install dependencies
cd facilities
npm install

# Create .env file
echo "CLOUD_SERVER_URL=wss://your-railway-url.railway.app:443" > .env

# Run bridge agent
node remote-bridge.js

# Keep running in background
goodvibes forever remote-bridge.js  # if you have pm2 installed
npm install -g pm2
pm2 start remote-bridge.js --name "tv-remote-bridge"
pm2 save
pm2 startup
`

### Option D: Windows Task Scheduler

1. **Create Batch Script** (start-bridge.bat):
   `atch
   @echo off
   cd C:\Users\YourName\Desktop\robloc fame\facilities
   set CLOUD_SERVER_URL=wss://your-railway-url.railway.app:443
   node remote-bridge.js
   pause
   `

2. **Create Task Scheduler Entry:**
   - Open Task Scheduler
   - Create Task
   - Trigger: At startup
   - Action: Start your batch script
   - Run as administrator

### Option D: Docker Compose (Windows)

`powershell
# Create environment file
Set-Content -Path ".env" -Value "CLOUD_SERVER_URL=wss://your-railway-url.railway.app:443"

# Run bridge
docker-compose -f docker-compose.cloud.yml up -d bridge-agent

# Check status
docker-compose -f docker-compose.cloud.yml ps

# View logs
docker-compose logs -f bridge-agent
`

### Option E: Raspberry Pi

`ash
# On Raspberry Pi (Raspberry Pi OS)
cd ~
git clone https://github.com/YOUR_USERNAME/your-repo.git
cd facilities

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Run as systemd service
sudo nano /etc/systemd/system/tv-remote-bridge.service

# Add this content:
<!--improved
[Unit]
Description=TV Remote Bridge Agent
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/your-repo/facilities
Environment=CLOUD_SERVER_URL=wss://your-railway-url.railway.app:443
ExecStart=/usr/bin/node remote-bridge.js
Restart=always

[Install]
WantedBy=multi-user.target
-->improved

# Enable and start service
sudo systemctl enable tv-remote-bridge
sudo systemctl start tv-remote-bridge

# Check status
sudo systemctl status tv-remote-bridge
sudo journalctl -u tv-remote-bridge -f
`

### Option F: Synology NAS

1. **Docker Package:**
   - Open Docker in DSM
   - Registry ? Search "node" ? Download "lts"
   - Image ? node:lts ? Launch
   
2. **Configure Container:**
   - Container name: tv-remote-bridge
   - Network: Use host network
   - Environment:
     - Key: CLOUD_SERVER_URL
     - Value: wss://your-railway-url.railway.app:443
   - Volume: Map /app to your code directory
   - Auto-restart: Enabled

---

## PART 3: Access the Web UI

### Option A: Use Railway URL Directly

1. Open browser: https://your-railway-url.railway.app
2. Should load the web UI
3. Click "Connect to Cloud"
4. It will automatically connect to your Railway server

### Option B: Host UI Separately (Recommended)

1. **Deploy to Netlify (Free):**
   `ash
   # Install Netlify CLI
   npm install -g netlify-cli
   
   # Deploy
   cd facilities
   netlify deploy --prod --mode remote-web-ui-cloud.html
   `

2. **Upload to Vercel:**
   `ash
   # Create a simple Vercel project
   # Add a vercel.json:
   {
     "rewrites": [{ "source": "/", "destination": "/remote-web-ui-cloud.html" }]
   }
   
   # Deploy
   vercel deploy --prod
   `

3. **Use GitHub Pages:**
   - Push emote-web-ui-cloud.html to gh-pages branch
   - Enable GitHub Pages in repo settings
   - Access at: https://YOUR_USERNAME.github.io/your-repo

---

## Configuration Reference

### Railway Environment Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| PORT | 5000 | Server listening port |
| NODE_ENV | production | Environment mode |

### Bridge Agent Environment Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| CLOUD_SERVER_URL | wss://your-railway-url.railway.app:443 | Cloud relay URL |
| BRIDGE_MODE | home | Deployment mode |
| DISCOVERY_PORT | 57300 | UDP port for TV discovery |
| ADB_PORT | 5555 | ADB connection port |

---

## Troubleshooting

### Bridge Agent Won't Connect to Railway

**Symptom:** Logs show "WebSocket connection failed"

**Solutions:**
1. Verify URL format: Must be wss:// (not ws://) for Railway
2. Port should be 443 or omitted (Railway uses HTTPS)
3. No trailing slashes
4. Check firewall allows outbound WebSocket connections

`ash
# Test WebSocket connection
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('wss://your-railway-url.railway.app');
ws.on('open', () => console.log('Connected!'));
ws.on('error', e => console.error('Error:', e.message));
"
`

### TVs Not Being Discovered

**Troubleshooting:**
1. Ensure TV has Developer Options enabled
2. Check TV and bridge agent are on same network
3. Verify firewall allows UDP port 57300
4. Check if bridge agent can ping TV

`ash
# From bridge agent machine
ping YOUR_TV_IP

# Test UDP port
nc -vzu YOUR_TV_IP 57300
`

### Railway Deployment Failed

**Check:**
1. Build logs in Railway dashboard
2. Verify Dockerfile exists in repository root or facilities/ folder
3. Ensure all required files are committed to Git
4. Check environment variables are set correctly

### Connection Timeout

**Solutions:**
1. Railway is overloaded - wait and retry
2. Check Railway service health: https://status.railway.app
3. Verify TV is powered on and on same network
4. Try manual IP entry in UI

---

## Testing Your Deployment

### Test 1: Cloud Server Health
`ash
curl https://your-railway-url.railway.app
`

### Test 2: Bridge Connection
`ash
docker logs tv-remote-bridge
# Should show "Connected to cloud relay"
`

### Test 3: Full System
1. Open web UI
2. Click "Connect to Cloud"
3. Click "Discover TVs"
4. Select your TV
5. Test buttons (Power, Volume, Navigation)

---

## Security Best Practices

1. **Railway:**
   - Always use HTTPS (Railway provides this for free)
   - Consider adding authentication layer for multi-user
   - Set reasonable resource limits

2. **Bridge Agent:**
   - Only connects outbound to cloud (no inbound ports)
   - TV commands execute with local network permissions
   - Consider VLAN isolation for sensitive TVs

3. **Web UI:**
   - Deploy on HTTPS
   - Add basic auth if exposing publicly
   - Implement rate limiting for commands

---

## Cost Estimation

### Railway (Free Tier)
- 500 GB-month bandwidth
- 512 MB RAM
- Unlimited hobby deployments (with  credit requirement)
- Your cloud server should use ~100-200MB/month

### Alternatives
- **Render:** Free tier available (spins down after inactivity)
- **Vercel:** Free for personal projects (requires serverless adaptation)
- **Fly.io:** Free allowance monthly

---

## Maintenance

### Update Cloud Server
`ash
# Make changes locally
git add .
git commit -m "Update cloud server"
git push origin main
# Railway auto-deploys on push
`

### Update Bridge Agent
`ash
# Pull latest changes
cd facilities
git pull

# Restart container
docker-compose restart bridge-agent
`

### View Logs
`ash
# Railway logs
railway logs

# Bridge logs
docker logs tv-remote-bridge
`

---

## Support & Resources

- **Railway Docs:** https://docs.railway.app
- **Node.js WebSocket:** https://github.com/websockets/ws
- **Android TV Remote Protocol:** https://developer.android.com/atservice
- **Docker Docs:** https://docs.docker.com

---

## Quick Reference Commands

`ash
# Railway
cd c:\Users\Samrat\Desktop\robloc fame
railway project create "TV Remote Cloud"
railway variables set PORT=5000
railway networking expose

# Bridge Agent
docker logs tv-remote-bridge
docker restart tv-remote-bridge
docker-compose -f docker-compose.cloud.yml down

# Test
curl https://your-railway-url.railway.app
`

---

Congratulations! Your Android TV Remote is now cloud-deployed and accessible from anywhere! ??
