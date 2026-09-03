/**
 * Local Bridge Server
 * Connects to cloud backend and executes ADB commands locally
 * 
 * Run: node local-bridge.js
 * Or:  BRIDGE_MODE=standalone node local-bridge.js
 */

const http = require('http');
const { exec } = require('child_process');

// Configuration
const PORT = process.env.BRIDGE_PORT || 8080;
const CLOUD_SERVER = process.env.CLOUD_SERVER || 'ws://localhost:5000';

// ADB Command executor
async function executeAdbCommand(ip, cmd, payload = '') {
  return new Promise((resolve) => {
    let adbCmd = '';
    
    if (cmd === 'TEXT') {
      const escaped = String(payload)
        .replace(/ /g, '%s')
        .replace(/&/g, '\\&')
        .replace(/\|/g, '\\|')
        .replace(/;/g, '\\;');
      adbCmd = `adb -s ${ip} shell input text "${escaped}"`;
    } else {
      const keyCodes = {
        'DPAD_UP': '19', 'DPAD_DOWN': '20', 'DPAD_LEFT': '21', 'DPAD_RIGHT': '22',
        'DPAD_CENTER': '23', 'UP': '19', 'DOWN': '20', 'LEFT': '21', 'RIGHT': '22',
        'CENTER': '23', 'OK': '23', 'ENTER': '66', 'BACK': '4', 'HOME': '3',
        'MENU': '82', 'VOLUME_UP': '24', 'VOLUME_DOWN': '25', 'MUTE': '164',
        'POWER': '26', 'SEARCH': '84', 'PLAY': '126', 'PAUSE': '127'
      };
      const keyCode = keyCodes[cmd];
      if (! keyCode) return resolve({ success: false, error: 'Unknown cmd' });
      adbCmd = `adb -s ${ip} shell input keyevent ${keyCode}`;
    }
    
    exec(adbCmd, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[ADB] Failed: ${error.message}`);
        resolve({ success: false, error: error.message });
      } else {
        console.log(`[ADB] ✓ ${cmd}`);
        resolve({ success: true });
      }
    });
  });
}

// Standalone HTTP mode (no cloud needed)
function startStandaloneMode() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && req.url === '/execute') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (! data.cmd || ! data.ip) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'Missing cmd or ip' }));
          }
          const result = await executeAdbCommand(data.ip, data.cmd, data.payload || '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } else if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'online', timestamp: Date.now() }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  
  server.listen(PORT, () => {
    console.log(`🌉 Local bridge on http://localhost:${PORT}`);
    console.log('  POST /execute - { ip, cmd, payload }');
    console.log('  GET  /status  - Status');
  });
}

// WebSocket cloud mode
function startWebSocketMode() {
  let WebSocket;
  try {
    WebSocket = require('ws');
  } catch (e) {
    console.log('⚠️ ws not installed, falling back to standalone mode');
    startStandaloneMode();
    return;
  }
  
  const wsUrl = CLOUD_SERVER.replace(/^https?:\/\//, 'ws://').replace(/^wss:\/\//, 'ws://');
  const ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log('✅ Connected to cloud server');
  });
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.cmd) {
        console.log(`🎯 Command: ${msg.cmd} for ${msg.ip}`);
        const result = await executeAdbCommand(msg.ip, msg.cmd, msg.payload || '');
        ws.send(JSON.stringify({ cmd: msg.cmd, ip: msg.ip, ...result, ts: Date.now() }));
      }
    } catch (err) {
      console.error('Message error:', err.message);
    }
  });
  
  ws.on('close', () => {
    console.log('⚠️ Cloud disconnected, retrying in 5s');
    setTimeout(() => { console.log('🔄 Reconnecting...'); startWebSocketMode(); }, 5000);
  });
  
  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
}

// Main
const mode = process.env.BRIDGE_MODE || 'standalone';
console.log('\n🌉 TV Control Hub - Local Bridge');
console.log('================================');
console.log(`Mode: ${mode}`);
console.log(`Port: ${PORT}\n`);

if (mode === 'standalone' || mode === 'http') {
  startStandaloneMode();
} else {
  startWebSocketMode();
}
