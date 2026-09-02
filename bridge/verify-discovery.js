// Verify TV Control Hub SSDP Scanning - Run with: node verify-discovery.js
const http = require('http');

console.log('='.repeat(60));
console.log('TV CONTROL HUB - DISCOVERY VERIFICATION TEST');
console.log('='.repeat(60));
console.log();

const BRIDGE_URL = 'http://localhost:3001/scan';
const BRIDGE_STATUS = 'http://localhost:3001/status';

function makeRequest(url) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const elapsed = Date.now() - startTime;
          resolve({ success: true, data: json, time: elapsed });
        } catch (e) {
          reject(new Error(`Invalid JSON: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('Step 1: Checking if bridge server is running...');
  console.log('-'.repeat(60));
  
  try {
    const status = await makeRequest(BRIDGE_STATUS);
    console.log(`✓ Bridge server is running (${status.time}ms)`);
    console.log();
    
    console.log('Step 2: Initiating device scan...');
    console.log('-'.repeat(60));
    
    const scan = await makeRequest(BRIDGE_URL);
    console.log(`✓ Scan completed in ${scan.time}ms`);
    console.log();
    
    console.log('Step 3: Analyzing discovered devices...');
    console.log('-'.repeat(60));
    
    const tvs = scan.data.tvs || [];
    console.log(`Total devices found: ${tvs.length}`);
    console.log();
    
    if (tvs.length === 0) {
      console.log('⚠️  No devices discovered!');
      console.log();
      console.log('Possible issues:');
      console.log('  • Network blocks SSDP multicast (port 1900)');
      console.log('  • No UPnP/SSDP devices on network');
      console.log('  • Firewall blocking discovery');
      process.exit(1);
    }
    
    // Categorize devices
    const realDevices = tvs.filter(t => t.via === 'ssdp');
    const mockDevices = tvs.filter(t => !t.via);
    
    if (mockDevices.length > 0) {
      console.log('Mock Devices (sample data):');
      mockDevices.forEach((tv, i) => {
        console.log(`  ${i + 1}. ${tv.name} (${tv.ip}) - ${tv.model}`);
      });
      if (realDevices.length > 0) console.log();
    }
    
    if (realDevices.length > 0) {
      console.log('✓ Real Devices Discovered (via SSDP):');
      realDevices.forEach((tv, i) => {
        console.log(`  ${i + 1}. ${tv.name} (${tv.ip})`);
        console.log(`     Model: ${tv.model}`);
        console.log();
      });
      
      // Check for Chromecast/Smart TV
      const chromecasts = realDevices.filter(t => 
        /chromecast|google tv|android tv/i.test(t.name + ' ' + t.model)
      );
      const otherTvs = realDevices.filter(t => 
        !/chromecast|google tv|android tv/i.test(t.name + ' ' + t.model)
      );
      
      console.log('✓ Smart TV Summary:');
      console.log(`  Chromecast/Google TV devices: ${chromecasts.length}`);
      chromecasts.forEach(tv => {
        console.log(`    • ${tv.name} at ${tv.ip}`);
      });
      
      if (otherTvs.length > 0) {
        console.log(`  Other UPnP devices: ${otherTvs.length}`);
        otherTvs.forEach(tv => {
          console.log(`    • ${tv.name} at ${tv.ip}`);
        });
      }
      
      console.log();
      console.log('='.repeat(60));
      console.log('✓ VERIFICATION COMPLETE');
      console.log('='.repeat(60));
      console.log();
      console.log('SSDP scanning is working correctly!');
      console.log(`Your network has ${realDevices.length} discoverable device(s).`);
      console.log();
      console.log('Next steps:');
      console.log('  • Select a TV from the website to control it');
      console.log('  • Bridge server running at http://localhost:3001');
      console.log();
      
      process.exit(0);
    } else {
      console.log('No real devices found, only mock data.');
      process.exit(1);
    }
    
  } catch (error) {
    console.log(`✗ Error: ${error.message}`);
    console.log();
    console.log('Troubleshooting:');
    console.log('  1. Make sure bridge server is running: node bridge/server.js');
    console.log('  2. Check if port 3001 is available');
    console.log('  3. Verify network connectivity');
    process.exit(1);
  }
}

// Run the tests
runTests();