# Cloud Deployment Guide for TV Control Hub

## Architecture Overview

This gesture-based TV remote system normally runs locally to communicate with TVs on the same network via ADB. To deploy it in the cloud while still controlling local TVs, you need to bridge the gap between cloud and local network.

## Current Limitations

The system currently relies on:
1. **Local-only ADB communication** - Commands go from browser → localhost server → TV via ADB on port 5555
2. **SSDP discovery** - Only works on the same local network  
3. **Mixed content blocking** - Hosted HTTPS pages can't access http://localhost bridges

## Deployment Options

### Option 1: Self-Hosted VPS on Same Network (Recommended)

**Best for:** Maximum control, no third-party dependencies

1. **Set up a VPS/VM on your local network:**
   - Use a Raspberry Pi, old PC, or always-on machine connected to your home Wi-Fi
   - Install Node.js on it
   - Clone this repository

2. **Configure port forwarding on your router:**
### Option 2: Render.com with WebSocket Integration

**Best for:** Easy cloud hosting with real-time performance

1. **Install WebSocket support:**
   ```bash
   npm install ws
   ```

2. **Update server.js to use WebSocket module** (see websocket-server.js for reference)

3. **Deploy to Render.com:**
   - Create a new Web Service
   - Connect your GitHub repo
   - Add environment variables:
     - `TV_DISCOVERY_MODE=manual`
     - `TVS_CONFIG='[{"name":"My TV","ip":"192.168.1.100"}]'`
     - `API_KEY=your-secure-key`
   - Deploy

4. **Access from anywhere:**
   - Browser connects to: `wss://your-app.render.app/`
   - Commands execute locally on the TV network

### Option 3: ngrok/Cloudflared Tunnel (Quick Testing)

1. **Deploy the server to Render.com:**
   - Create a new Web Service
   - Connect your GitHub repo
   - Add the bridge component code below
   - Set environment variable `PORT=10000` (Render provides this)

2. **Keep a local bridge running:**
   - On a machine on your home network, run a simplified bridge server
   - This bridge polls Render for commands and executes ADB locally

See the "Required Code Changes" section for implementation details.

### Option 3: ngrok/Cloudflared Tunnel (Quick Testing)

1. **Run the server locally:**
   ```bash
   node server.js
   ```

2. **Expose it with ngrok:**
   ```bash
   ngrok http 5000
   ```

3. **Access the ngrok URL from anywhere**

**Pros:** Extremely quick setup, no code changes needed
**Cons:** URL changes on free tier, security concerns, rate limits

---

## Required Code Changes

### 1. Server-Side WebSocket Support

Add this to server.js after the `createMainServer()` function:

```javascript
// Check for WebSocket support
let WebSocket;
try {
  WebSocket = require('ws');
} catch(e) {
  console.log('ℹ️ WebSocket not installed. Run: npm install ws');
}

// After server.listen() in createMainServer():
if (WebSocket) {
  const wss = new WebSocket.Server({ server });
  wss.on('connection', (ws, req) => {
    console.log('🔌 WebSocket client connected');
    
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        if (data.cmd) {
          const result = await sendAdbCommand(data.ip, data.cmd, data.payload || '');
          ws.send(JSON.stringify({ cmd: data.cmd, result, ts: Date.now(), ip: data.ip }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ error: err.message }));
      }
    });
    
    ws.on('close', () => console.log('WebSocket client disconnected'));
    
    // Send initial status
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
  });
}
```

### 2. Client-Side WebSocket Integration

Add to app.js after the `sendCommand` function:

```javascript
// WebSocket connection management
let ws = null;
let wsRetryTimer = null;
let wsConnected = false;

function initWebSocket(serverUrl) {
  if (!serverUrl || ws) return;
  
  // Convert https://domain.com to wss://domain.com
  const wsUrl = serverUrl.replace(/^https?:\/\//, 'wss://');
  
  try {
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('✅ WebSocket connected to cloud backend');
      wsConnected = true;
      clearTimeout(wsRetryTimer);
      toast('Connected to cloud backend', 'good');
    };
    
    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          log(`WebSocket error: ${data.error}`, 'bad');
        } else if (data.type === 'connected') {
          log('WebSocket handshake complete', 'good');
        } else {
          // Command result received
          log(`Command result: ${data.cmd} ${data.result ? '✓' : '✗'}`, 'good');
        }
      } catch (e) {
        console.error('WebSocket message parse error:', e);
      }
    };
    
    ws.onclose = () => {
      console.log('⚠️ WebSocket disconnected, retrying...');
      wsConnected = false;
      wsRetryTimer = setTimeout(() => initWebSocket(serverUrl), 5000);
    };
    
    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      log(`WebSocket error: ${err.message}`, 'warn');
    };
  } catch (err) {
    console.error('Failed to create WebSocket:', err);
    log('Failed to initialize WebSocket', 'bad');
  }
}

function sendCommandViaWebSocket(cmd, payload = '') {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log('WebSocket not connected, using REST fallback', 'warn');
    return false;
  }
  
  ws.send(JSON.stringify({
    ip: state.connected.ip,
    cmd,
    payload
  }));
  
  log(`Command sent via WebSocket: ${cmd}`, 'good');
  return true;
}
```

### 3. Auto-detect WebSocket and Use When Available

Modify the `sendCommand` function to try WebSocket first:

```javascript
// In sendCommand, after line 634 where sendPayload is created:
const sendPayload = {ip: state.connected.ip, cmd, payload};

// Try WebSocket first if connected
if (ws && ws.readyState === WebSocket.OPEN) {
  sendCommandViaWebSocket(cmd, payload);
  return;
}

// Existing bridge and fallback logic...
if(state.bridge){
  // ...current bridge code
}
```

### 4. Add environment variable config to server.js

```javascript
// Add at top of server.js, after line 21
const config = {
  PORT: parseInt(process.env.PORT, 10) || 5000,
  BRIDGE_PORT: parseInt(process.env.BRIDGE_PORT, 10) || 5001,
  NODE_ENV: process.env.NODE_ENV || 'development',
  ENABLE_MOCK_TVS: process.env.ENABLE_MOCK_TVS === 'true',
  TV_DISCOVERY_MODE: process.env.TV_DISCOVERY_MODE || 'ssdp', // 'ssdp', 'manual', 'mock'
  API_KEY: process.env.API_KEY || '',
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
};
```
   - Forward external port (e.g., 443/8443) to internal server port (5000)
   - Enable HTTPS with Let's Encrypt for secure connections

3. **Update firewall/router settings:**
   - Allow traffic on the forwarded port
   - Consider using a VPN (WireGuard, OpenVPN) for secure remote access

4. **Launch the server:**
   ```bash
   node server.js
   ```

5. **Access from anywhere:**
   - Open https://your-domain.com or your public IP
   - The server runs on your local network and can reach TVs via ADB

**Pros:** Full control, no latency through third-party services, works reliably
**Cons:** Requires hardware always-on at home, needs port forwarding/VPN setup