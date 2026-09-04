# Android TV Remote - Cloud Deployment Guide

## Architecture Overview

This system enables you to control your Android TV from anywhere in the world using a cloud-based relay architecture:

`
+-------------+     WebSocket      +--------------+     WebSocket      +-------------+
¦   Browser   ¦ ?----------------? ¦  Cloud Relay ¦ ?----------------? ¦ Bridge Agent¦
¦   (UI)      ¦     (wss://)       ¦   Server     ¦     (wss://)       ¦  (Home)     ¦
+-------------+                    +--------------+                    +-------------+
                                                                               ¦
                                                                               ¦ UDP/TCP
                                                                               ?
                                                                       +-------------+
                                                                       ¦  Android TV ¦
                                                                       +-------------+
`

## Components

### 1. Cloud Relay Server (emote-cloud-server.js)
- Runs on public cloud (Railway, Render, VPS, etc.)
- Maintains WebSocket connections with all UI clients and bridge agents
- Relays control commands and TV discovery information
- Stateless and scalable

### 2. Local Bridge Agent (emote-bridge.js)
- Runs on your home network (Docker, Raspberry Pi, always-on PC)
- Discovers Android TVs via UDP multicast/broadcast
- Opens firewall hole for this Relay
- Connects to cloud relay via WebSocket
- Sends ADB commands to TVs on your local network

### 3. Web UI (emote-web-ui-cloud.html)
- Static HTML/JS that runs in any browser
- Connects to cloud relay via WebSocket
- No local server installation needed on client side
- Works from any device (phone, tablet, laptop)

## Quick Start

### Step 1: Deploy Cloud Server

#### Option A: Railway (Recommended - Free Tier)

1. Fork this repository to GitHub
2. Go to [railway.app](https://railway.app) and create account
3. Create new project ? Deploy from GitHub repo
4. Select acilities directory or add ROOT_DIRECTORY variable
5. Add environment variables:
   `
   PORT=5000
   NODE_ENV=production
   `
6. Railway will auto-deploy. Note your https://your-app.railway.app URL

#### Option B: Render

1. Go to [render.com](https://render.com)
2. Create new ? Web Service
3. Connect GitHub repo
4. Configure:
   - Build command: 
pm install
   - Start command: 
ode remote-cloud-server.js
   - Environment: PORT=5000
5. Deploy and note your URL

#### Option C: VPS (DigitalOcean, AWS, etc.)

`
# SSH into server
cd /opt/tv-remote
git clone <your-repo> .
npm install

# Run as systemd service
sudo nano /etc/systemd/system/tv-remote.service
`

Add to service file:
`
[Unit]
Description=Android TV Remote Cloud Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/tv-remote/facilities
ExecStart=/usr/bin/node remote-cloud-server.js
Restart=always

[Install]
WantedBy=multi-user.target
`

`
sudo systemctl enable tv-remote
sudo systemctl start tv-remote
`

#### Option D: Vercel (Serverless - Requires Adaptation)

Note: This requires adapting the WebSocket server to work with Vercel serverless functions. See Vercel README for details.

### Step 2: Deploy Bridge Agent

#### Option A: Docker (Recommended)

`ash
# On home server/Raspberry Pi always-on PC
cd /path/to/clone

# Edit .env file
cp .env.example .env
nano .env  # Set CLOUD_SERVER_URL=wss://your-railway-app.railway.app:443

# Run with Docker Compose
docker-compose -f docker-compose.cloud.yml up -d bridge-agent

# Check logs
docker-compose -f docker-compose.cloud.yml logs -f bridge-agent
`

#### Option B: Docker (Manual)

`ash
docker run -d \
  --name tv-remote-bridge \
  --network=host \
  -e CLOUD_SERVER_URL=wss://your-cloud-url.com:443 \
  -v C:\Users\Samrat\Desktop\robloc fame\facilities:/app \
  node:lts \
  node remote-bridge.js
`

#### Option C: Direct Node

`ash
# On home computer (Windows/Mac/Linux)
cd facilities

# Create .env file
echo "CLOUD_SERVER_URL=wss://your-cloud-url.com:443" > .env

# Run directly
node remote-bridge.js
`

#### Option D: Synology NAS

1. Open Container Registry
2. Pull 
ode:lts image
3. Create container with:
   - Host network mode
   - Environment variable: CLOUD_SERVER_URL
   - Volume mount to code directory
   - Auto-start enabled

### Step 3: Access Web UI

1. Navigate to your cloud server URL in browser: https://your-railway-app.railway.app
2. Or upload emote-web-ui-cloud.html to any static hosting (Netlify, Vercel, Github Pages)
3. Enter your cloud server WebSocket URL: wss://your-railway-app.railway.app:443
4. Click "Connect to Cloud"
5. Click "Discover TVs" and select your Android TV
6. Start controlling!

## Configuration

### Environment Variables

#### Cloud Server
`
PORT=5000                 # Port to listen on
NODE_ENV=production       # Environment mode
`

#### Bridge Agent
`
CLOUD_SERVER_URL=wss://your-cloud-url.com:443  # Cloud relay URL
BRIDGE_MODE=home          # Deployment mode
DISCOVERY_PORT=57300      # UDP port for TV discovery
ADB_PORT=5555             # TCP port for ADB commands
`

### Android TV Setup

1. On Android TV:
   - Go to Settings ? Device Preferences ? About
   - Click "Build" 7 times to enable Developer Options
   - Go back ? Settings ? Device Preferences ? Developer Options
   - Enable "USB Debugging" (or "Network Debugging" on newer TVs)
   - Note the IP address shown in network settings

2. Ensure TV and Bridge Agent are on same network

3. Firewall: Ensure bridge agent machine can reach TV on port 5555

## Troubleshooting

### Bridge Agent Won't Connect

`
# Check logs
docker logs tv-remote-bridge

# Verify URL format (must be wss:// for production)
docker exec -it tv-remote-bridge echo 

# Test WebSocket connection
docker exec -it tv-remote-bridge node -e "const ws = require('ws'); const w = new WebSocket(process.env.CLOUD_SERVER_URL); w.on('open', () => console.log('OK')); w.on('error', e => console.log(e.message));"
`

### TVs Not Being Discovered

`
# Enable host network mode for UDP multicast
docker update --network=host tv-remote-bridge

# Check if TV is reachable
docker exec -it tv-remote-bridge ping <tv-ip>

# Verify TV has debugging enabled
# Check TV firewall settings
`

### Cloud Server Not Accessible

`
# Check Railway/Render logs
# Verify PORT environment variable is set
# Test from different network:
wget https://your-app.railway.app
`

## Security Considerations

- Use WSS (WebSocket Secure) in production - Railway/Render provide auto TLS
- Consider adding authentication layer for multi-user deployments
- Bridge agent only connects OUTBOUND to cloud (no inbound ports needed)
- ADB commands executed with local network permissions only

## Scalability

- Cloud server is stateless - deploy multiple instances behind load balancer
- Bridge agents are per-network - one per home network needed
- Web UI is static - serve from CDN for global access

## TypeScript Migration (Optional)

For enterprise deployments, consider migrating to TypeScript:

`ash
npm install -D typescript @types/node @types/ws @types/express
tsc --init
`

## License

MIT - See LICENSE file
