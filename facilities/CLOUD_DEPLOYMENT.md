# Cloud-Deployable TV Remote System

## Overview
A complete TV remote system that works without localhost dependency using a local proxy bridge architecture with automatic TV discovery via CRYSTAL Protocol (Android TV Remote Control Protocol).

## Architecture
```
Cloud Server/Local Browser → Local Proxy (Port 5001) → TV (UDP Port 57300)
```

## Components

### 1. `remote-proxy.js` - Node.js Proxy Server
- Uses CRYSTAL Protocol (official Android TV Remote Control on UDP 57300)
- Provides REST API + WebSocket for browser communication
- Auto-discovers TVs on local network
- No ADB dependency (reduces CPU usage)

### 2. `remote-web-ui.html` - Browser Interface
- Auto-connects to proxy server
- Displays discovered TVs
- D-pad navigation, volume, power, and media controls
- Real-time status updates

## Quick Start

### Prerequisites
- Node.js 18+
- Android TV with "Remote Control" app enabled

### Installation

1. **Enable TV Remote Control:**
   - On your Android TV, go to Settings → Apps → Android TV Remote Control
   - Enable the remote control feature
   - Note your TV's IP address

2. **Install Dependencies:**
   ```bash
   cd facilities
   npm install ws express
   ```

3. **Start the Proxy Server:**
   ```bash
   node remote-proxy.js
   ```

4. **Open the Web Interface:**
   - Open `remote-web-ui.html` in your browser
   - Or serve it: `npx serve .` and navigate to the URL
   - Click "Discover TVs" to auto-scan your network
   - Select your TV and start controlling!

## API Endpoints

### REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/discover` | GET | Auto-discover TVs on network |
| `/connect?ip=TV_IP` | GET | Connect to specific TV |
| `/disconnect?ip=TV_IP` | GET | Disconnect from TV |
| `/key?ip=TV_IP&key=KEYCODE` | GET | Send key press |
| `/text?ip=TV_IP&text=TEXT` | GET | Send text input |

### Key Codes
- **Navigation:** 19=Up, 20=Down, 21=Left, 22=Right, 23=OK
- **System:** 3=Home, 4=Back, 26=Power, 82=Menu
- **Media:** 85=Play/Pause, 86=Play, 87=Pause
- **Volume:** 24=Vol+, 25=Vol-
- **Other:** 164=Mute, 178=Input

## Configuration

### Environment Variables (Optional)
| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_PORT` | 5001 | Proxy server port |
| `REMOTE_HOST` | 0.0.0.0 | Server bind address |

### Example
```bash
REMOTE_PORT=8080 node remote-proxy.js
```

## Deployment

### Local Development
```bash
cd facilities
node remote-proxy.js
```

### Production (Render/Railway/etc.)
1. Deploy with `render.yaml` configuration
2. Set `REMOTE_PORT` to match platform requirements
3. Users must install the proxy locally on their network

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY facilities/remote-proxy.js .
COPY facilities/package*.json .
RUN npm install --production
EXPOSE 5001
CMD ["node", "remote-proxy.js"]
```

## Security Considerations
- Proxy runs on local network only by default (bind to 127.0.0.1 for extra security)
- Each TV connection is isolated
- No authentication required for local network (add if exposing externally)

## Troubleshooting

### TVs Not Discovered
1. Ensure "Android TV Remote Control" is enabled on the TV
2. Check firewall allows UDP port 57300
3. Verify TV and proxy are on the same network

### Connection Fails
1. Verify TV IP is correct
2. Check network connectivity to TV
3. Try restarting the proxy server

### Proxy Won't Start
1. Ensure Node.js 18+ is installed
2. Run `npm install ws express`
3. Check port 5001 is not in use

## File Structure
```
facilities/
├── remote-proxy.js      # Proxy server (477 lines)
├── remote-web-ui.html   # Web interface
├── package.json         # Dependencies
└── CLOUD_DEPLOYMENT.md  # This file
```

## Project Stats
- **Proxy Server:** 477 lines of Node.js
- **Web Interface:** Single HTML file with embedded JS/CSS
- **Dependencies:** Only `ws` and `express`
- **No ADB Required:** Uses official protocol directly

## License
MIT - Free for personal and commercial use