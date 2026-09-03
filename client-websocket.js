/**
 * WebSocket Client Example
 * Demonstrates how to connect to TV Control Hub via WebSocket
 * 
 * Usage:
 *   node client-websocket.js
 *   
 * Or run interactive mode:
 *   node client-websocket.js interactive
 */

const WebSocket = require('ws');

const SERVER_URL = process.env.WS_URL || 'ws://localhost:5000';
const API_KEY = process.env.WS_API_KEY || '';

class TvControlClient {
  constructor(url, apiKey = '') {
    this.url = url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
    this.apiKey = apiKey;
    this.ws = null;
    this.reconnectTimer = null;
    this.commandCallbacks = new Map();
    this.cmdCounter = 0;
  }

  connect() {
    console.log(`📡 Connecting to ${this.url}...`);
    
    this.ws = new WebSocket(this.url);
    
    this.ws.on('open', () => {
      console.log('✅ Connected');
      clearTimeout(this.reconnectTimer);
    });
    
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'connected') {
        console.log('🤝 Server:', msg.server);
      }
      else if (msg.type === 'command_result') {
        const callback = this.commandCallbacks.get(msg.cmd + msg.ts);
        if (callback) {
          callback(msg);
          this.commandCallbacks.delete(msg.cmd + msg.ts);
        } else {
          console.log(`Result: ${msg.cmd} = ${msg.success ? '✓' : '✗'}`);
        }
      }
      else if (msg.type === 'pong') {
        // Handle keepalive
      }
      else if (msg.type === 'error') {
        console.error('❌ Server error:', msg.message);
      }
    });
    
    this.ws.on('close', () => {
      console.log('⚠️ Disconnected');
      this.reconnectTimer = setTimeout(() => {
        console.log('🔄 Reconnecting...');
        this.connect();
      }, 5000);
    });
    
    this.ws.on('error', (err) => {
      console.error('❌ Error:', err.message);
    });
  }

  async sendCommand(ip, cmd, payload = '') {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      
      const id = ++this.cmdCounter;
      const message = { id, ip, cmd, payload };
      
      const timeout = setTimeout(() => {
        this.commandCallbacks.delete(id);
        reject(new Error('Timeout'));
      }, 10000);
      
      this.commandCallbacks.set(id, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
      
      this.ws.send(JSON.stringify(message));
    });
  }

  async pressKey(ip, key) {
    return this.sendCommand(ip, key.toUpperCase());
  }

  async sendText(ip, text) {
    return this.sendCommand(ip, 'TEXT', text);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Interactive mode
if (process.argv[2] === 'interactive' || !module.parent) {
  const client = new TvControlClient(SERVER_URL, API_KEY);
  
  client.connect();
  
  // Demo: send some commands after connection
  setTimeout(async () => {
    console.log('\n📺 Demo Commands');
    console.log('================\n');
    
    const demoTvIp = '192.168.1.101';
    
    try {
      console.log('Sending UP command...');
      await client.pressKey(demoTvIp, 'UP');
      
      await new Promise(r => setTimeout(r, 500));
      
      console.log('Sending HOME command...');
      await client.pressKey(demoTvIp, 'HOME');
      
      await new Promise(r => setTimeout(r, 500));
      
      console.log('Sending text "Hello"...');
      await client.sendText(demoTvIp, 'Hello');
      
      console.log('\n✅ Demo complete!');
      console.log('Press Ctrl+C to exit');
      
    } catch (err) {
      console.error('Demo failed:', err.message);
    }
  }, 1000);
}

module.exports = TvControlClient;