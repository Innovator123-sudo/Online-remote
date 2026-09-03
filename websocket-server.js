/**
 * WebSocket Server for TV Control Hub
 * Adds real-time command streaming via WebSockets
 * 
 * Requires: npm install ws
 * 
 * Usage:
 *   node websocket-server.js
 * 
 * Or integrate with main server by requiring this module.
 */

const WebSocket = require('ws');
const http = require('http');

// ADB command executor (imported from server.js or duplicated here)
const { exec } = require('child_process');

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
        'UP': '19', 'DOWN': '20', 'LEFT': '21', 'RIGHT': '23',
        'CENTER': '24', 'OK': '66', 'BACK': '4', 'HOME': '3',
        'MENU': '82', 'PLAY': '126', 'PAUSE': '127', 'STOP': '86'
      };
      const keyCode = keyCodes[cmd];
      if (! keyCode) return resolve({ success: false, error: 'Unknown cmd' });
      adbCmd = `adb -s ${ip} shell input keyevent ${keyCode}`;
    }
    
    console.log(`[WebSocket] ADB: ${adbCmd}`);
    
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

/**
 * Create WebSocket server attached to existing HTTP server
 * @param {http.Server} server - Existing HTTP server to attach to
 * @param {string} apiKey - Optional API key for authentication
 */
function attachWebSocketServer(server, apiKey = '') {
  const wss = new WebSocket.Server({ server });
  
  console.log('🔌 WebSocket server ready');
  
  wss.on('connection', (ws, req) => {
    const clientIp = req.connection.remoteAddress;
    console.log(`📡 WebSocket client connected: ${clientIp}`);
    
    // Optional API key authentication
    if (apiKey) {
      const authHeader = req.headers['sec-websocket-protocol'];
      if (authHeader !== apiKey) {
        console.log(`❌ Unauthorized connection attempt from ${clientIp}`);
        ws.close(4001, 'Unauthorized');
        return;
      }
    }
    
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        // Handle ping/pong for keepalive
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          return;
        }
        
        // Execute ADB command
        if (data.cmd && data.ip) {
          console.log(`🎯 Command: ${data.cmd} → ${data.ip}`);
          const result = await executeAdbCommand(data.ip, data.cmd, data.payload || '');
          
          // Send result back to client
          ws.send(JSON.stringify({
            type: 'command_result',
            cmd: data.cmd,
            ip: data.ip,
            payload: data.payload,
            success: result.success,
            error: result.error,
            ts: Date.now()
          }));
        }
        
        // Get status
        if (data.type === 'status') {
          ws.send(JSON.stringify({
            type: 'status',
            connected: true,
            ts: Date.now()
          }));
        }
        
      } catch (err) {
        console.error('⚠️ Message handler error:', err.message);
        ws.send(JSON.stringify({
          type: 'error',
          message: err.message,
          ts: Date.now()
        }));
      }
    });
    
    ws.on('close', () => {
      console.log(`👋 WebSocket client disconnected: ${clientIp}`);
    });
    
    ws.on('error', (err) => {
      console.error(`❌ WebSocket error for ${clientIp}:`, err.message);
    });
    
    // Send initial connection message
    ws.send(JSON.stringify({
      type: 'connected',
      ts: Date.now(),
      server: 'TV Control Hub'
    }));
  });
  
  // Broadcast helper
  wss.broadcast = function broadcast(data) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  };
  
  return wss;
}

// Standalone mode if run directly
if (require.main === module) {
  const PORT = parseInt(process.env.WS_PORT, 10) || 5002;
  const apiKey = process.env.WS_API_KEY || '';
  
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TV Control Hub WebSocket Server');
  });
  
  attachWebSocketServer(server, apiKey);
  
  server.listen(PORT, () => {
    console.log(`\n🌉 WebSocket Server Running`);
    console.log(`Port: ${PORT}`);
    console.log(`Mode: Standalone`);
    console.log(`Connect to: ws://localhost:${PORT}`);
    if (apiKey) console.log(`API Key: Required`);
    console.log('');
  });
}

module.exports = { attachWebSocketServer, executeAdbCommand };