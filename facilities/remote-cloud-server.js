/**
 * Android TV Remote - Cloud Relay Server
 * Deployment: npm run cloud-server (or node remote-cloud-server.js)
 */

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 5000;
const bridges = new Map();
const users = new Map();
const tvRegistry = new Map();

console.log('🌥️  Android TV Remote - Cloud Relay Server');
console.log(`✅ Starting on port ${PORT}`);

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const id = crypto.randomBytes(8).toString('hex');
  ws.on('message', (msg) => handleMessage(ws, id, JSON.parse(msg)));
  ws.on('close', () => cleanup(id));
  bridges.set(id, { ws, tvs: [] });
  users.set(id, { ws });
});

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

server.listen(PORT, () => console.log(`✅ Cloud server running on port ${PORT}`));