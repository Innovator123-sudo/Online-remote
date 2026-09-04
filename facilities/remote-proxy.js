/**
 * ? LIGHTWEIGHT Android TV Remote - Browser-Based (CRYSTAL Protocol)
 * 
 * Features:
 * ? Auto-discovery of TVs on network
 * ? WebSocket for real-time communication
 * ? REST API for simple key sends
 * ? No manual IP entry required
 * 
 * Usage: node facilities/remote-proxy.js
 */

const dgram = require('dgram');
const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = parseInt(process.env.REMOTE_PORT, 10) || 5001;
const TV_PORT = 57300;
const BROADCAST_PORT = 57300;

const MSG = {
  CONNECT: 1, DISCONNECT: 2, KEY_EVENT: 3, TEXT_INPUT: 4,
  PING: 8, PONG: 9, COMPONENT_STATE: 100
};

const KEYS = {
  UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, OK: 23,
  HOME: 3, BACK: 4, MENU: 82, VOLUME_UP: 24,
  VOLUME_DOWN: 25, MUTE: 164, POWER: 26,
  PLAY_PAUSE: 85, STOP: 86, NEXT: 87, PREVIOUS: 88
};

function createMessage(type, msgId, payload = null) {
  const payloadLen = payload ? payload.length : 0;
  const buffer = Buffer.alloc(9 + payloadLen);
  buffer.writeUInt32BE(payloadLen, 0);
  buffer.writeUInt8(type, 4);
  buffer.writeUInt32BE(msgId, 5);
  if (payload) payload.copy(buffer, 9);
  return buffer;
}

function createKeyEvent(keyCode) {
  const payload = Buffer.alloc(8);
  payload.writeUInt8(1, 0);
  payload.writeUInt32BE(keyCode, 1);
  payload.writeBigInt64BE(BigInt(Date.now()), 5);
  return createMessage(MSG.KEY_EVENT, 1, payload);
}

let connectedTvs = new Map();
let webSockets = [];


class TvConnection {
  constructor(ip, name = 'Android TV') {
    this.ip = ip;
    this.name = name;
    this.socket = null;
    this.connected = false;
    this.messageId = 0;
  }

  async connect() {
    return new Promise((resolve) => {
      try {
        this.socket = dgram.createSocket('udp4');
        this.socket.on('error', (err) => {
          console.log(`[TV-REMOTE] Socket error: ${err.message}`);
          this.connected = false;
          resolve(false);
        });
        this.socket.on('message', (message) => this.handleMessage(message));
        this.socket.on('listening', () => {
          this.socket.setBroadcast(true);
        });

        const connectMsg = createMessage(MSG.CONNECT, ++this.messageId);
        this.socket.send(connectMsg, 0, connectMsg.length, TV_PORT, this.ip, (err) => {
          if (err) {
            this.socket.close();
            resolve(false);
            return;
          }
          setTimeout(() => {
            if (!this.connected) {
              this.socket.close();
              resolve(false);
            } else {
              connectedTvs.set(this.ip, this);
              broadcastTvStatus();
              resolve(true);
            }
          }, 2000);
        });
        this.socket.bind();
      } catch (err) {
        console.log(`[TV-REMOTE] Connect error: ${err.message}`);
        resolve(false);
      }
    });
  }

  handleMessage(message) {
    if (message.length < 9) return;
    const type = message.readUInt8(4);
    if (type === MSG.CONNECT || type === MSG.PONG) {
      this.connected = true;
      console.log(`[TV-REMOTE] Connected to ${this.ip}`);
      broadcastTvStatus();
    }
  }

  async sendKey(keyCode) {
    return new Promise((resolve) => {
      if (!this.socket || !this.connected) {
        resolve({ success: false, error: 'Not connected' });
        return;
      }
      const keyMsg = createKeyEvent(keyCode);
      this.socket.send(keyMsg, 0, keyMsg.length, TV_PORT, this.ip, (err) => {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          console.log(`[TV-REMOTE] Sent key ${keyCode} to ${this.ip}`);
          resolve({ success: true });
        }
      });
    });
  }

  async disconnect() {
    return new Promise((resolve) => {
      if (this.socket) {
        const disconnectMsg = createMessage(MSG.DISCONNECT, ++this.messageId);
        this.socket.send(disconnectMsg, 0, disconnectMsg.length, TV_PORT, this.ip, (err) => {
          this.socket.close();
          connectedTvs.delete(this.ip);
          broadcastTvStatus();
          resolve(true);
        });
      } else {
        resolve(false);
      }
    });
  }
}

async function discoverTv() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const foundTvs = [];

    socket.on('message', (message, rinfo) => {
      if (message.length >= 9) {
        const type = message.readUInt8(4);
        if (type === MSG.CONNECT) {
          const tvName = message.length > 9 ? message.slice(9).toString('utf8').replace(/\0/g, '') : 'Android TV';
          if (!foundTvs.some(tv => tv.ip === rinfo.address)) {
            foundTvs.push({ ip: rinfo.address, name: tvName });
            console.log(`[TV-REMOTE] Discovered: ${tvName} at ${rinfo.address}`);
          }
        }
      }
    });

    socket.on('listening', () => {
      socket.setBroadcast(true);
      const discoverMsg = createMessage(MSG.CONNECT, 1);
      socket.send(discoverMsg, 0, discoverMsg.length, BROADCAST_PORT, '255.255.255.255');
    });

    socket.bind(() => {
      setTimeout(() => {
        socket.close();
        resolve(foundTvs);
      }, 3000);
    });
  });
}

function broadcastTvStatus() {
  const status = {
    type: 'status',
    TVs: Array.from(connectedTvs.values()).map(tv => ({
      ip: tv.ip,
      name: tv.name,
      connected: tv.connected
    }))
  };
  webSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(status));
    }
  });
}

// HTTP server
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const p = parsedUrl.pathname;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (p === '/health' || p === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, status: 'TV Remote Proxy Running', timestamp: new Date().toISOString() }));
    return;
  }

  // Discover TVs (auto-scan)
  if (p === '/discover') {
    console.log('[TV-REMOTE] Discovering TVs...');
    discoverTv().then(tvs => {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, TVs: tvs }));
    });
    return;
  }

  // Connect to TV
  if (p === '/connect') {
    const ip = parsedUrl.query.ip;
    if (!ip) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'IP required' }));
      return;
    }
    let tv = connectedTvs.get(ip);
    if (!tv) {
      tv = new TvConnection(ip);
    }
    tv.connect().then(success => {
      res.writeHead(success ? 200 : 500);
      if (success) {
        res.end(JSON.stringify({ ok: true, name: tv.name }));
      } else {
        res.end(JSON.stringify({ ok: false, error: 'Connection failed' }));
      }
    });
    return;
  }

  // Disconnect from TV
  if (p === '/disconnect') {
    const ip = parsedUrl.query.ip;
    if (!ip) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'IP required' }));
      return;
    }
    const tv = connectedTvs.get(ip);
    if (tv) {
      tv.disconnect().then(() => {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      });
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: 'TV not connected' }));
    }
    return;
  }

  // Send key by code
  if (p === '/key') {
    const ip = parsedUrl.query.ip;
    const key = parseInt(parsedUrl.query.key);
    if (!ip || !key) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'IP and key required' }));
      return;
    }
    sendKeyToTv(ip, key).then(result => {
      res.writeHead(result.success ? 200 : 500);
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Status
  if (p === '/status') {
    res.writeHead(200);
    res.end(JSON.stringify({ 
      ok: true, 
      TVs: Array.from(connectedTvs.values()).map(tv => ({
        ip: tv.ip,
        name: tv.name,
        connected: tv.connected
      }))
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

// Helper function to send key
function sendKeyToTv(ip, keyCode) {
  return new Promise((resolve) => {
    let tv = connectedTvs.get(ip);
    if (!tv) {
      tv = new TvConnection(ip);
      tv.connect().then(() => {
        tv.sendKey(keyCode).then(result => {
          if (!result.success) {
            setTimeout(() => resolve(result), 100);
          } else {
            resolve(result);
          }
        });
      });
    } else {
      tv.sendKey(keyCode).then(result => {
        resolve(result);
      });
    }
  });
}

// Add shortcut endpoints for common keys
const shortcutKey = {
  '/up': KEYS.UP, '/down': KEYS.DOWN, '/left': KEYS.LEFT, '/right': KEYS.RIGHT,
  '/ok': KEYS.OK, '/select': KEYS.OK, '/back': KEYS.BACK, '/home': KEYS.HOME,
  '/menu': KEYS.MENU, '/mute': KEYS.MUTE, '/power': KEYS.POWER,
  '/playpause': KEYS.PLAY_PAUSE, '/play': KEYS.PLAY_PAUSE, '/pause': KEYS.PLAY_PAUSE
};

// Patch the HTTP server to handle shortcuts
const originalCreateServer = http.createServer;
http.createServer = function(handler) {
  const server = originalCreateServer(handler);
  
  const oldListener = server.listeners('request')[0];
  
  server.removeAllListeners('request');
  
  server.on('request', (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const p = parsedUrl.pathname;
    
    for (const [path, keyCode] of Object.entries(shortcutKey)) {
      if (p === path) {
        const ip = parsedUrl.query.ip;
        if (!ip) {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'IP required' }));
          return;
        }
        sendKeyToTv(ip, keyCode).then(result => {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(result.success ? 200 : 500);
          res.end(JSON.stringify(result));
        });
        return;
      }
    }
    
    if (oldListener) {
      oldListener(req, res);
    }
  });
  
  return server;
};

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  webSockets.push(ws);
  
  // Send current status immediately
  broadcastTvStatus();

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      switch (data.type) {
        case 'discover':
          discoverTv().then(tvs => {
            ws.send(JSON.stringify({ type: 'discovery-result', TVs: tvs }));
          });
          break;
          
        case 'connect':
          if (data.ip) {
            let tv = connectedTvs.get(data.ip) || new TvConnection(data.ip);
            tv.connect().then(success => {
              ws.send(JSON.stringify({ 
                type: 'connect-result', 
                success, 
                ip: data.ip,
                name: tv.name 
              }));
            });
          }
          break;
          
        case 'disconnect':
          if (data.ip) {
            const tv = connectedTvs.get(data.ip);
            if (tv) {
              tv.disconnect().then(() => {
                ws.send(JSON.stringify({ type: 'disconnect-result', success: true, ip: data.ip }));
              });
            }
          }
          break;
          
        case 'key':
          if (data.ip && data.key) {
            let tv = connectedTvs.get(data.ip);
            if (tv) {
              tv.sendKey(data.key).then(result => {
                ws.send(JSON.stringify({ 
                  type: 'key-result', 
                  success: result.success, 
                  ip: data.ip,
                  key: data.key 
                }));
              });
            }
          }
          break;
      }
    } catch (err) {
      console.log('[WS] Error processing message:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    webSockets = webSockets.filter(w => w !== ws);
  });

  ws.on('error', (err) => {
    console.log('[WS] Error:', err.message);
    webSockets = webSockets.filter(w => w !== ws);
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n? Android TV Remote Proxy (CRYSTAL Protocol)`);
  console.log(`   Server: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   UDP port: ${TV_PORT}`);
  console.log(`   Features: Auto-discovery ? | WebSocket ? | No ADB ?`);
  console.log(`   Initialize: node facilities/remote-proxy.js`);
  console.log(`   \n   Auto-discover enabled on startup...`);
  
  // Auto-discover TVs on startup
  setTimeout(() => {
    discoverTv().then(tvs => {
      if (tvs.length > 0) {
        console.log(`\n[TV-REMOTE] Found ${tvs.length} TV(s):`);
        tvs.forEach(tv => console.log(`   - ${tv.name} at ${tv.ip}`));
      }
    });
  }, 2000);
});

module.exports = { TvConnection, discoverTv, KEYS, MSG, connectedTvs, wss, server };
