/**
 * Android TV Remote - Cloud Relay Server
 * Deployment: npm run cloud-server (or node remote-cloud-server.js)
 * Serves both HTTP web UI and WebSocket relay
 */

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 5000;
const bridges = new Map();
const users = new Map();
const tvRegistry = new Map();

console.log('🌥️  Android TV Remote - Cloud Relay Server');
console.log(`✅ Starting on port ${PORT}`);

const server = http.createServer(handleHttpRequest);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const id = crypto.randomBytes(8).toString('hex');
  ws.on('message', (msg) => handleMessage(ws, id, JSON.parse(msg)));
  ws.on('close', () => cleanup(id));
  bridges.set(id, { ws, tvs: [] });
  users.set(id, { ws });
});

function handleHttpRequest(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Serve the web UI for root path
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const htmlPath = path.join(__dirname, 'remote-web-ui-cloud.html');
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
  }
  
  // API endpoint for remotes list
  if (req.method === 'GET' && req.url === '/api/remotes') {
    const remotes = Array.from(tvRegistry.values()).map(tv => ({
      ip: tv.ip,
      name: tv.name || 'Android TV',
      model: tv.model || 'Android TV'
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ remotes }));
    return;
  }
  
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', bridges: bridges.size, users: users.size }));
    return;
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function handleMessage(ws, id, data) {
  switch(data.type) {
    case 'bridge:register':
      console.log(`🏠 Bridge registered: ${id}`);
      ws.send(JSON.stringify({type: 'bridge:registered', bridgeId: id}));
      break;
    case 'bridge:tv:discovery':
      if(data.tvs) {
        data.tvs.forEach(tv => {
          tvRegistry.set(tv.ip, { ...tv, bridgeId: id, lastSeen: Date.now() });
          broadcastUsers(JSON.stringify({type: 'tv:discovered', tv, bridgeId: id}));
        });
      }
      break;
    case 'bridge:control:ack':
      broadcastUsers(JSON.stringify({type: 'control:success', command: data.command}));
      break;
    case 'ui:connect':
      console.log(`📱 UI connected: ${id}`);
      const tvs = Array.from(tvRegistry.values());
      ws.send(JSON.stringify({type: 'ui:connected', tvs}));
      break;
    case 'ui:discover':
      const bridge = [...bridges.entries()][0];
      if(bridge) bridge[1].ws.send(JSON.stringify({type: 'ui:discover', userId: data.userId}));
      break;
    case 'ui:control':
      const tv = tvRegistry.get(data.tvIp);
      if(tv) {
        const b = [...bridges.entries()].find(([_,b]) => b.bridgeId === tv.bridgeId);
        if(b) b[1].ws.send(JSON.stringify({type: 'ui:control', ...data}));
      }
      break;
  }
}

function broadcastUsers(msg) {
  users.forEach((u) => { if(u.ws.readyState === WebSocket.OPEN) u.ws.send(msg); });
}

function cleanup(id) {
  bridges.delete(id);
  users.delete(id);
}

// Handle errors
server.on('error', (err) => {
  console.error(`❌ Server error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Cloud server running on port ${PORT}`);
  console.log(`🌐 Web UI available at http://localhost:${PORT}/`);
  console.log(`💬 WebSocket relay ready for connections`);
}).on('listening', () => {
  console.log(`🎉 Server successfully started and listening`);
});