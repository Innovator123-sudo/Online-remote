// Test SSDP scanning - Run with: node test-ssdp.js
const { Client } = require('node-ssdp');

console.log('='.repeat(50));
console.log('TV Control Hub - SSDP Discovery Test');
console.log('='.repeat(50));
console.log();

const discovered = new Map();
let scanStartTime = Date.now();

// Create SSDP client
const client = new Client({
  timeout: 5000,
  allowNative: true,
  ipVersion: 4
});

// Listen for responses
client.on('response', (headers, statusCode, rinfo) => {
  const now = Date.now();
  const elapsed = ((now - scanStartTime) / 1000).toFixed(2);
  
  const st = headers.ST || headers.st || 'unknown';
  const location = headers.LOCATION || headers.location || '';
  const server = headers.SERVER || headers.server || '';
  const deviceName = headers['X-Device-Name'] || headers['X-Android-Device-Name'] || '';
  
  console.log(`[${elapsed}s] Device found!`);
  console.log(`  Address: ${rinfo.address}:${rinfo.port}`);
  console.log(`  ST: ${st}`);
  if (location) console.log(`  Location: ${location}`);
  if (server) console.log(`  Server: ${server}`);
  if (deviceName) console.log(`  Device Name: ${deviceName}`);
  console.log();
  
  // Store unique devices
  if (!discovered.has(rinfo.address)) {
    discovered.set(rinfo.address, {
      ip: rinfo.address,
      port: rinfo.port,
      st: st,
      location: location,
      server: server,
      name: deviceName || `Device at ${rinfo.address}`
    });
  }
});

client.on('error', (err) => {
  console.error('SSDP Error:', err.message);
});

console.log('Starting SSDP scan...');
console.log('Searching for devices on your network...');
console.log('This will take 10 seconds...\n');

// Search for various device types
const searchTargets = [
  'urn:dial-multiscreen-org:service:dial:1',
  'ssdp:all',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:device:TV:1',
  'upnp:rootdevice'
];

searchTargets.forEach(target => {
  console.log(`Searching: ${target}`);
  client.search(target);
});

// Also do a simple M-SEARCH
setTimeout(() => {
  console.log('\nPerforming general M-SEARCH...');
}, 2000);

// Stop after 10 seconds
setTimeout(() => {
  console.log();
  console.log('='.repeat(50));
  console.log('SCAN COMPLETE');
  console.log('='.repeat(50));
  console.log();
  
  console.log(`Total unique devices found: ${discovered.size}`);
  console.log();
  
  if (discovered.size === 0) {
    console.log('⚠️  No devices found. Possible reasons:');
    console.log('  1. Your network blocks SSDP multicast traffic');
    console.log('  2. No UPnP/SSDP devices are on the network');
    console.log('  3. Firewall is blocking SSDP (port 1900)');
    console.log('  4. Devices don\'t support SSDP discovery');
    console.log();
    console.log('Try:');
    console.log('  - Ensure TV is ON and connected to same WiFi');
    console.log('  - Check if TV has "Network Control" or "DLNA" enabled');
    console.log('  - Try on a different network (home WiFi)');
  } else {
    console.log('Devices discovered:');
    console.log('-'.repeat(50));
    discovered.forEach((device, index) => {
      console.log(`${index + 1}. ${device.name}`);
      console.log(`   IP: ${device.ip}:${device.port}`);
      console.log(`   Type: ${device.st}`);
      if (device.server) console.log(`   Server: ${device.server}`);
      console.log();
    });
    
    // Filter for TVs
    const tvs = Array.from(discovered.values()).filter(d => 
      /dial|android|googletv|cast|roku|firetv|tv|media/i.test(d.st + ' ' + d.server + ' ' + d.name)
    );
    
    console.log(`Potential TVs found: ${tvs.length}`);
    tvs.forEach((tv, i) => {
      console.log(`  ${i + 1}. ${tv.name} - ${tv.ip}`);
    });
  }
  
  console.log();
  console.log('='.repeat(50));
  
  // Cleanup
  client.stop();
  process.exit(discovered.size > 0 ? 0 : 1);
}, 10000);