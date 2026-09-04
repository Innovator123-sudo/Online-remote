/**
 * Android TV Remote - Local Bridge Agent
 * 
 * This runs locally on your network (as Docker container or Node.js process)
 * and bridges the cloud server with your local Android TVs via UDP.
 * 
 * Features:
 * - Connects to cloud relay server via WebSocket
 * - Discovers Android TVs on local network via UDP multicast
 * - Sends ADB commands to TVs via TCP
 * - Relays control commands from cloud UI to local TVs
 * 
 * Run with: node remote-bridge.js
 * Docker: docker-compose up
 */

const dgram = require('dgram');
const net = require('net');
const WebSocket = require('ws');
const crypto = require('crypto');

// Configuration
const CLOUD_SERVER_URL = process.env.CLOUD_SERVER_URL || 'ws://localhost:5000';
const DISCOVERY_PORT = 57300;
const ADB_PORT = 5555;

console.log('🏠 Android TV Remote - Local Bridge Agent');
console.log('=========================================');
console.log(`📡 Cloud Server: ${CLOUD_SERVER_URL}`);

let cloudWs = null;
const discoveredTvs = new Map();
const cloudBridgeId = crypto.randomBytes(8).toString('hex');

// Connect to cloud relay server
function connectToCloud() {
  cloudWs = new WebSocket(CLOUD_SERVER_URL);
  
  cloudWs.on('open', () => {
    console.log('✅ Connected to cloud relay server');
    cloudWs.send(JSON.stringify({ type: 'bridge:register', bridgeId: cloudBridgeId }));
  });

  cloudWs.on('message', (data) => {
    const msg = JSON.parse(data);
    handleMessage(msg);
  });

  cloudWs.on('close', () => {
    console.log('❌ Cloud connection lost, reconnecting...');
    setTimeout(connectToCloud, 5000);
  });

  cloudWs.on('error', (err) => {
    console.error('❌ Cloud WebSocket error:', err.message);
  });
}

// Handle messages from cloud
function handleMessage(msg) {
  switch(msg.type) {
    case 'ui:discover':
      console.log('🔍 TV discovery requested');
      discoverTvs();
      break;
    case 'ui:control':
      if(msg.tvIp && msg.command) {
        sendCommandToTv(msg.tvIp, msg.command);
      }
      break;
  }
}

// Discover TVs via UDP multicast
function discoverTvs() {
  const server = dgram.createSocket('udp4');
  const message = Buffer.from('HELLO-ADB-DETECT');
  
  server.on('message', (msg, rinfo) => {
    console.log(`📺 TV detected: ${rinfo.address}`);
    const tvIp = rinfo.address;
    discoveredTvs.set(tvIp, { name: 'Android TV', ip: tvIp, status: 'online' });
    
    if(cloudWs.readyState === WebSocket.OPEN) {
      cloudWs.send(JSON.stringify({
        type: 'bridge:tv:discovery',
        bridgeId: cloudBridgeId,
        tvs: Array.from(discoveredTvs.values())
      }));
    }
  });

  server.on('error', (err) => {
    console.error('❌ Discovery error:', err.message);
    server.close();
  });

  server.bind(DISCOVERY_PORT, () => {
    server.setBroadcast(true);
    server.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255');
    setTimeout(() => server.close(), 3000);
  });
}

// Send ADB commands to TV via TCP
async function sendCommandToTv(tvIp, command) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: tvIp, port: ADB_PORT }, () => {
      console.log(`🎮 Sending ${command} to ${tvIp}`);
      // ADB protocol: send command bytes
      const adbCommand = Buffer.from(`BD${command}\0`); // Basic ADB control
      client.write(adbCommand);
      resolve({ success: true });
    });

    client.on('error', (err) => {
      console.error(`❌ Failed to send to ${tvIp}:`, err.message);
      resolve({ success: false, error: err.message });
    });

    client.on('close', () => {});
    client.setTimeout(5000, () => {
      client.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// Start
connectToCloud();

// Periodic discovery every 30 seconds
setInterval(discoverTvs, 30000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down bridge agent...');
  if(cloudWs) cloudWs.close();
  process.exit(0);
});