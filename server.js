/**
 * TV Control Hub — Unified Server (Website + Bridge)
 * Serves the gesture website AND the Wi-Fi discovery API on ONE port.
 * 
 * Run: node server.js
 * Then open: http://localhost:5000
 * 
 * No deps required. If express/cors are installed, uses them, else raw http.
 * Also serves bridge API at /status, /scan, /pair, /cmd, /search
 * Website at / and /index.html, /app.js, /style.css
 * 
 * This fixes "localhost:3001 refused" — now everything is on 3000.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.PORT, 10) || 5000;
const BRIDGE_PORT = 5001; // also listen on 5001 for backward compat (local only)
const transport = require('./cast-transport'); // ADB + Chromecast Cast v2 + DIAL routing
let LAN_URL = ''; // filled at listen time; shared with phones via /status + share links

// Cloud deployment configuration
const config = {
  // Detection
  isHosted: !!process.env.VERCEL || !!process.env.RENDER || !!process.env.NETLIFY || process.env.NODE_ENV === 'production',
  
  // TV Discovery mode: 'ssdp', 'manual', 'mock'
  tvDiscoveryMode: process.env.TV_DISCOVERY_MODE || 'ssdp',
  
  // Mock TVs for testing (disabled in production by default)
  enableMockTvs: process.env.ENABLE_MOCK_TVS === 'true',
  
  // API security
  apiKey: process.env.API_KEY || '',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  
  // Manual TV configuration (for cloud deployment)
  manualTvs: (() => {
    try {
      return process.env.TVS_CONFIG ? JSON.parse(process.env.TVS_CONFIG) : [];
    } catch (e) {
      console.warn('⚠️ Invalid TVS_CONFIG JSON, ignoring');
      return [];
    }
  })()
};

// Log configuration
console.log(`\n📡 TV Control Hub Configuration`);
console.log(`================================`);
console.log(`Port: ${PORT}`);
console.log(`Environment: ${config.isHosted ? 'Cloud/Production' : 'Local/Development'}`);
console.log(`TV Discovery Mode: ${config.tvDiscoveryMode}`);
if (config.manualTvs.length > 0) {
  console.log(`Manual TVs: ${config.manualTvs.length} device(s) configured`);
  config.manualTvs.forEach(tv => {
    console.log(`  - ${tv.name} (${tv.ip})`);
  });
}
if (config.apiKey) {
  console.log(`API Key: Configured (authentication required)`);
}
console.log('');

// Backward compatibility alias for existing code
const isHosted = config.isHosted;

// When hosted (Vercel/Render/etc.) the server's LAN is the cloud, NOT the user's TV network.
// So we disable real SSDP and per-user state sharing — each client uses localStorage + simulated discovery.
// This ensures hosting doesn't leak one user's TVs to another.
let express, cors;
try { express=require('express'); cors=require('cors'); } catch(e){}

// TV Configuration - prioritize manually configured TVs, fall back to demo mocks
let MOCK_TVS = [];
if (config.manualTvs.length > 0) {
  // Use manually configured TVs from environment variable
  MOCK_TVS = config.manualTvs;
  console.log(`✅ Using ${MOCK_TVS.length} manually configured TV(s)`);
} else if (config.enableMockTvs || config.isHosted) {
  // Demonstration fallback
  MOCK_TVS = [
    { name:"Demo Living Room TV", ip:"192.168.1.101", model:"TCL Android TV (Demo)" },
    { name:"Demo Bedroom TV", ip:"192.168.1.42", model:"Sony Bravia Google TV (Demo)" },
  ];
  console.log(`ℹ️ Using ${MOCK_TVS.length} demo TV(s) — configure TVS_CONFIG for your actual TVs`);
}
// Valid-TV-only mode (fixes "scan the valid tv only"): start empty, only real SSDP results are valid.
// Mocks are only added as fallback demo if no valid found and client explicitly allows demo.
let discovered = [];
let states = new Map();
let lastValidScan = [];

// Fetch real device name from SSDP LOCATION XML (friendlyName / modelName)
function fetchFriendlyName(locationUrl, timeout=1500) {
  return new Promise((resolve) => {
    try {
      const req = http.get(locationUrl, { timeout }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          const fnMatch = data.match(/<friendlyName[^>]*>([^<]+)<\/friendlyName>/i);
          if (fnMatch) { resolve(fnMatch[1].trim()); return; }
          const mdMatch = data.match(/<modelName[^>]*>([^<]+)<\/modelName>/i);
          resolve(mdMatch ? mdMatch[1].trim() : '');
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { try { req.destroy(); } catch{}; resolve(''); });
    } catch { resolve(''); }
  });
}

// For Chromecast/Google Cast devices, probe /setup/eureka_info for the real user-set name.
function fetchCastName(ip, timeout=1400) {
  return new Promise((resolve) => {
    const url = `http://${ip}:8008/setup/eureka_info?params=name,model_name,ssdp_udn`;
    const req = http.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve((j && j.name) ? String(j.name).trim() : ''); }
        catch { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { try { req.destroy(); } catch{}; resolve(''); });
  });
}

// Decide best display name — prefer user-set Cast name, then DIAL friendlyName, then model label.
function enrichDeviceName(ip, server, st, currentName, locationUrl) {
  return new Promise((resolve) => {
    const isCast = /chromecast|google|cast/i.test((server||'') + ' ' + (st||''));
    const applyCastName = () => {
      if(!isCast){ resolve(currentName); return; }
      fetchCastName(ip, 1400).then(castName => {
        if(castName && castName.toLowerCase() !== 'tv'){
          resolve(castName.slice(0,40));
        } else if(locationUrl){
          fetchFriendlyName(locationUrl, 1400).then(xmlName => {
            if(xmlName && xmlName.toLowerCase() !== 'tv' && !/^chromecast$/i.test(xmlName)){
              resolve(xmlName.slice(0,40));
            } else resolve(currentName);
          }).catch(()=> resolve(currentName));
        } else resolve(currentName);
      }).catch(()=> resolve(currentName));
    };
    applyCastName();
  });
}

// Build a human-readable device name from SSDP headers + optional XML enrichment
function buildDeviceName(server, st, location, fallbackIp) {
  let name = '';
  if (/chromecast|google/i.test(server + ' ' + st)) {
    name = 'Chromecast';
  } else if (/android/i.test(server + ' ' + st)) {
    name = 'Android TV';
  } else if (/roku/i.test(server)) {
    name = 'Roku TV';
  } else if (/fire.?tv/i.test(server)) {
    name = 'Fire TV';
  } else if (/bravia|sony/i.test(server)) {
    name = 'Sony TV';
  } else if (/tcl/i.test(server)) {
    name = 'TCL TV';
  } else if (/hisense/i.test(server)) {
    name = 'Hisense TV';
  } else {
    name = (server || '').split(' ')[0] || '';
    if (!name && location) {
      try { name = new URL(location).hostname; } catch {}
    }
    name = name || `TV`;
  }
  if (!/tv|chromecast|cast/i.test(name)) name = `${name} TV`;
  return name.replace(/UPnP\/.*/,'').trim() || `TV ${fallbackIp}`;
}

// Reuse SSDP logic from bridge/server.js (fast, <3s)
function rawSsdpScan(timeout=2200){
  return new Promise((resolve)=>{
    const dgram = require('dgram');
    const found = new Map();
    const nameFetches = [];
    const socket = dgram.createSocket({type:'udp4', reuseAddr:true});
    let finished=false;
    const finish=()=>{
      if(finished) return; finished=true;
      try{ socket.close(); }catch{}
      // Enrich all found devices with real names (Cast eureka_info + DIAL XML, parallel)
      for(const [ip, info] of found){
        nameFetches.push(
          enrichDeviceName(ip, info.server, info.st, info.name, info.location).then(realName => {
            if(realName && found.has(ip)){
              const dev = found.get(ip);
              const oldName = dev.name;
              dev.name = realName.slice(0,40);
              if(oldName !== dev.name) console.log(`[ssdp-raw] enriched ${ip}: "${oldName}" → "${dev.name}"`);
            }
          }).catch(()=>{})
        );
      }
      Promise.allSettled(nameFetches).then(()=>{
        for(const [ip,info] of found){
          if(!discovered.some(d=> d.ip===ip)){
            discovered.push(info);
            console.log(`[ssdp-raw] found ${info.name} at ${ip} (ST=${info.st})`);
          }
        }
        resolve();
      });
    };
    socket.on('error', (err)=>{ console.log('[ssdp-raw] socket error', err.message); finish(); });
    socket.on('message', (msg, rinfo)=>{
      const text = msg.toString('utf8');
      const headers={};
      text.split('\r\n').forEach(line=>{
        const idx=line.indexOf(':');
        if(idx>0){ headers[line.slice(0,idx).trim().toUpperCase()] = line.slice(idx+1).trim(); }
      });
      const st = headers['ST']||'';
      const server = headers['SERVER']||'';
      const location = headers['LOCATION']||'';
      const isTv = /dial|android|google|chromecast|cast|roku|firetv|philips|sony|tcl|hisense|bravia|upnp|mediarenderer|tv/i.test(st+' '+server+' '+location);
      if(isTv){
        if(!found.has(rinfo.address)){
          const name = buildDeviceName(server, st, location, rinfo.address);
          found.set(rinfo.address, { name: name.slice(0,40), ip:rinfo.address, model: st||'Android TV', st, location, server });
        }
      }
    });
    socket.bind(0, ()=>{
      try{ socket.addMembership('239.255.255.250'); }catch{}
      socket.setBroadcast(true);
      socket.setMulticastTTL(4);
      const mk = (st)=> Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
      ['urn:dial-multiscreen-org:service:dial:1','urn:google-com:device:ChromeCast:1','urn:schemas-upnp-org:device:MediaRenderer:1'].forEach((st,i)=>{
        setTimeout(()=> socket.send(mk(st), 0, mk(st).length, 1900, '239.255.255.250', ()=>{}), i*80);
      });
      setTimeout(()=> socket.send(mk('ssdp:all'), 0, mk('ssdp:all').length, 1900, '239.255.255.250', ()=>{}), 600);
    });
    setTimeout(finish, timeout);
  });
}

async function ssdpScan(){
  if(isHosted){
    console.log("[ssdp] Hosted mode — skipping real SSDP (cloud LAN != user LAN). Client uses real scan + local bridge only.");
    discovered = [];
    return;
  }
  console.log("[ssdp] Starting fast SSDP scan (<3s) — valid TV only (no mocks unless no valid found)...");
  // Valid-only: reset to empty before each scan, only real SSDP results are kept
  discovered = [];
  lastValidScan = [];
  const raw = rawSsdpScan(2200);
  let nodeScan = Promise.resolve();
  try{
    const { Client } = require("node-ssdp");
    nodeScan = new Promise((resolve)=>{
      const client = new Client({ timeout: 2200, allowNative: true, ipVersion: 4 });
      client.on('response', (headers, s, rinfo) => {
        const st = headers.ST || headers.st || '';
        const server = headers.SERVER || headers.server || '';
        const location = headers.LOCATION || headers.location || '';
        const isTv = /dial|android|google|chromecast|cast|roku|firetv|philips|sony|tcl|hisense|bravia|upnp|mediarenderer|tv/i.test(st + ' ' + server + ' ' + location);
        if (isTv) {
          if (!discovered.some(d => d.ip === rinfo.address)) {
            const deviceName = headers['X-Device-Name'] || headers['X-Android-Device-Name'] || '';
            let name = deviceName || buildDeviceName(server, st, location, rinfo.address);
            if(!/tv|chromecast|cast/i.test(name)) name = `${name} TV`;
            name = name.replace(/UPnP.*/,'').trim() || `TV ${rinfo.address}`;
            discovered.push({ name: name.slice(0,40), ip:rinfo.address, model:st||'Android TV', via:'ssdp', location });
            console.log(`[ssdp] Found: ${name} at ${rinfo.address}`);
            // Enrich from Cast eureka_info / DIAL XML in background
            enrichDeviceName(rinfo.address, server, st, name, location).then(realName => {
              if(realName && realName !== name) {
                const dev = discovered.find(d => d.ip === rinfo.address);
                if(dev) {
                  const old = dev.name;
                  dev.name = realName.slice(0,40);
                  console.log(`[ssdp] enriched ${rinfo.address}: "${old}" → "${dev.name}"`);
                }
              }
            }).catch(()=>{});
          }
        }
      });
      ['urn:dial-multiscreen-org:service:dial:1','ssdp:all','urn:schemas-upnp-org:device:MediaRenderer:1'].forEach(t=> client.search(t));
      setTimeout(()=>{ try{ client.stop(); }catch{}; resolve(); }, 2200);
    });
  }catch(e){ if(e.code !== 'MODULE_NOT_FOUND') console.log("[ssdp] error:", e.message); }
  await Promise.all([raw, nodeScan]);
  // valid-only: only keep TVs that actually contain 'tv' (already filtered in rawSsdpScan)
  // Enrich from scan-results.json but only valid tv-named AND non-mock devices
  try{
    if(fs.existsSync('scan-results.json')){
      const j=JSON.parse(fs.readFileSync('scan-results.json','utf8'));
      (j.devices||[]).forEach(d=>{
        const name = d.name || '';
        const isMock = /\(mock\)|mock/i.test(name) || d.via==='mock';
        if(d.ip && /tv|cast|chromecast|android|google/i.test(name) && !isMock && !discovered.some(x=> x.ip===d.ip)){
          discovered.push({name:name||`TV ${d.ip}`, ip:d.ip, model:d.st||'Android TV', via:'scan.js'});
        }
      });
    }
  }catch{}
  lastValidScan = [...discovered];
  if(discovered.length===0){
    console.log(`[ssdp] Scan complete — 0 valid TVs (no tv-named device responded). Not adding mocks — valid-only mode.`);
    // Don't auto-add mocks; client will show "No valid TVs" and offer demo/manual
  } else {
    console.log(`[ssdp] Scan complete — ${discovered.length} valid TV(s) found`);
  }
}

// MIME helper
const MIME = {
  '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon'
};
function serveFile(res, filePath){
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data)=>{
    if(err){ res.writeHead(404, {'Content-Type':'text/plain'}); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': mime, 'Cache-Control':'no-cache'});
    res.end(data);
  });
}

function handleApi(req, res){
  // CORS + Private Network Access (lets a free-cloud https page talk to this
  // home-LAN bridge at http://192.168.x.x:5000 in Chrome/Edge — the phone app
  // flow. Without Allow-Private-Network the browser hard-blocks cloud→LAN.)
  const reqOrigin = req.headers && req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', reqOrigin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Private-Network','true');
  res.setHeader('Access-Control-Max-Age','600');
  if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if(p==='/status' || p==='/api/status'){
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:true, bridge:true, tvs: discovered, states: Object.fromEntries(states), transports:{adb:true, cast:transport.castAvailable()}, lanUrl: LAN_URL || undefined }));
    return true;
  }
  if(p==='/scan' || p==='/api/scan'){
    ssdpScan().then(()=>{
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ tvs: discovered }));
    });
    return true; // async
  }
  if(p==='/pair' || p==='/api/pair'){
    let body=''; req.on('data',c=> body+=c); req.on('end',()=>{
      try{ body=JSON.parse(body||'{}'); }catch{ body={}; }
      if(!body.ip || !/^\d{6}$/.test(String(body.code||''))){ res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false})); }
      if(String(body.code)==='000000'){ res.writeHead(401, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false})); }
      if(!isHosted) states.set(body.ip, {...(states.get(body.ip)||{}), paired:true});
      console.log(`[pair] ${body.ip} OK ${isHosted?'(hosted, not persisted)':''}`);
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    });
    return true;
  }
  if(p==='/validate' || p==='/api/validate'){
    const ip = parsed.query.ip;
    if(!ip){
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:false, valid:false, error:'no ip'}));
    }
    res.writeHead(200, {'Content-Type':'application/json'});
    // Transport-aware: ADB (full D-Pad) > Cast (Chromecast media keys) > DIAL (app quit).
    transport.validateTransport(ip, ()=> sendAdb(ip, ['shell','echo','test'])).then(v=>{
      console.log(`[validate] ${ip} → ${v.valid ? ('valid via '+v.via) : 'invalid'}${v.name ? ' "'+v.name+'"' : ''}`);
      if(v.valid) transport.setDeviceVia(ip, v.via);
      res.end(JSON.stringify({ok:true, valid:v.valid, via:v.via || undefined, name:v.name || undefined}));
    }).catch(err=>{
      res.end(JSON.stringify({ok:true, valid:false, error:err.message||String(err)}));
    });
    return true;
  }
  if(p==='/state'){
    res.writeHead(200, {'Content-Type':'application/json'});
    // Hosted: don't share state across users — pairing is per-browser localStorage
    const st = isHosted ? {paired:false, searchActive:false} : (states.get(parsed.query.ip)||{paired:false, searchActive:false});
    res.end(JSON.stringify(st));
    return true;
  }
  if(p==='/search' || p==='/api/search'){
    let body=''; req.on('data',c=> body+=c); req.on('end',()=>{
      try{ body=JSON.parse(body||'{}'); }catch{ body={}; }
      if(!isHosted) states.set(body.ip, {...(states.get(body.ip)||{}), searchActive: !!body.active});
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    });
    return true;
  }
  if(p==='/cmd' || p==='/api/cmd'){
    let body=''; req.on('data',c=> body+=c); req.on('end',()=>{
      try{ body=JSON.parse(body||'{}'); }catch{ body={}; }
      if(!body.ip){ res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'no ip'})); }
      // Add timeout to prevent hanging responses
      const timeoutId = setTimeout(()=>{
        console.error(`[cmd] Timeout for ${body.ip} ${body.cmd}`);
        if(!res.writableEnded){
          res.writeHead(504, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, sent:false, via:transport.getDeviceVia(body.ip), error:'command timeout'}));
        }
      }, 25000); // 25s cap covers the adb→cast→dial fallback chain
      transport.sendTransportCommand(body.ip, body.cmd, body.payload||'', {
        adbSend: (cmd, payload)=> sendAdbCommand(body.ip, cmd, payload||''),
      }).then(r=>{
        clearTimeout(timeoutId);
        console.log(`[cmd] ${body.ip} ${body.cmd} → ${r.ok ? ('SUCCESS via '+r.via) : ('FAILED ('+(r.error||'unknown')+')')}`);
        if(res.writableEnded) return;
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:r.ok, sent:r.ok, via:r.via || transport.getDeviceVia(body.ip), error:r.error}));
      }).catch(err=>{
        clearTimeout(timeoutId);
        console.error(`[cmd] ${body.ip} ${body.cmd} error: ${err.message}`);
        if(res.writableEnded) return;
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, sent:false, via:transport.getDeviceVia(body.ip), error:err.message}));
      });
    });
    return true; // async
  }
  return false; // not api
}

// ADB real-command sender — talks to the TV over adb on port 5555
function findAdbBin(){
  const candidates = [
    path.join(__dirname, 'platform-tools', process.platform==='win32'?'adb.exe':'adb'),
    path.join(__dirname, 'platform-tools', 'adb'),
    'adb',
  ];
  for(const c of candidates){
    try{ if(fs.existsSync(c) || c==='adb') return c; }catch{}
  }
  return 'adb';
}
const KEYEVENT = {
  DPAD_UP:19, DPAD_DOWN:20, DPAD_LEFT:21, DPAD_RIGHT:22, DPAD_CENTER:23,
  ENTER:66, BACK:4, HOME:3, MENU:82, VOLUME_UP:24, VOLUME_DOWN:25, MUTE:164, POWER:26,
  SEARCH:84, TEXT:0,
};
function sendAdb(ip, args){
  return new Promise((resolve)=>{
    const { execFile } = require('child_process');
    // First attempt
    execFile(findAdbBin(), ['-s', `${ip}:5555`].concat(args), {timeout: 8000}, (err, stdout, stderr)=>{
      if(err){
        // Try reconnecting once, then retry the command
        execFile(findAdbBin(), ['connect', `${ip}:5555`], {timeout: 4000}, (connErr, connOut, connErrOut)=>{
          // Wait a moment for the connection to establish
          setTimeout(() => {
            // Retry the original command after connection attempt
            execFile(findAdbBin(), ['-s', `${ip}:5555`].concat(args), {timeout: 8000}, (err2, o2, e2)=>{
              if(err2){
                console.error(`[adb] Failed to ${args.join(' ')} on ${ip}: ${err2.message}`);
                resolve(false);
              } else {
                console.log(`[adb] Retry succeeded for ${args.join(' ')} on ${ip}`);
                resolve(true);
              }
            });
          }, 500);
        });
        return;
      }
      resolve(true);
    });
  });
}
async function sendAdbCommand(ip, cmd, payload=""){
  if(cmd==='TEXT'){
    // Escape spaces and special chars for adb shell input text
    const safe = String(payload).replace(/ /g,'%s').replace(/&/g,'\\&').replace(/\|/g,'\\|').replace(/;/g,'\\;').replace(/[<>()]/g,'\\$&');
    return sendAdb(ip, ['shell','input','text', safe]);
  }
  const code = KEYEVENT[cmd];
  if(!code) return false;
  return sendAdb(ip, ['shell','input','keyevent', String(code)]);
}

function createMainServer(){
  const server = http.createServer((req,res)=>{
    // Try API first
    if(handleApi(req,res)) return;
    if(res.writableEnded) return;
    // Not API — serve static files
    let filePath = url.parse(req.url).pathname;
    if(filePath==='/' ) filePath='/index.html';
    filePath = path.join(__dirname, filePath);
    // Prevent directory traversal
    if(!filePath.startsWith(__dirname)){
      res.writeHead(403); return res.end('Forbidden');
    }
    // If file not found, serve index.html for SPA fallback
    if(!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()){
      filePath = path.join(__dirname, 'index.html');
    }
    serveFile(res, filePath);
  });

  server.listen(PORT, ()=>{
    const os = require('os');
    let lanIp = '';
    try {
      const nets = os.networkInterfaces();
      for(const name of Object.keys(nets)){
        for(const n of nets[name]||[]){
          if(n.family === 'IPv4' && !n.internal && (n.address.startsWith('192.168.') || n.address.startsWith('10.') || n.address.startsWith('172.'))){
            lanIp = n.address; break;
          }
        }
        if(lanIp) break;
      }
    } catch {}
    console.log(`\n✅ TV Control Hub running at http://localhost:${PORT}`);
    console.log(`   Website: http://localhost:${PORT}/`);
    if(lanIp){
      LAN_URL = `http://${lanIp}:${PORT}`;
      console.log(`   📱 From your PHONE on the same Wi-Fi, open:  ${LAN_URL}/`);
      console.log(`      (TV and phone must be on the SAME network as this PC: ${lanIp})`);
    }
    console.log(`   API:     http://localhost:${PORT}/status  http://localhost:${PORT}/scan`);
    console.log(`   Also listening on http://localhost:${BRIDGE_PORT} for old app.js compat`);
    console.log(`\n   Wi-Fi discovery: SSDP <3s, website shows real TVs in <2s (same network only)`);
    console.log(`   Real control via ADB on the TV's port 5555. Open the URL on any device on this Wi-Fi.\n`);
  });

  // Also listen on 5001 for old app.js that fetches http://localhost:5001/status (local only, not on hosted)
  if(!isHosted){
    const bridgeServer = http.createServer((req,res)=>{
      if(handleApi(req,res)) return;
      if(res.writableEnded) return;
      res.writeHead(404, {'Content-Type':'text/plain'});
      res.end('Bridge API only — open http://localhost:'+PORT+' for website');
    });
    bridgeServer.listen(BRIDGE_PORT, ()=>{
      console.log(`✅ Bridge compat listening on http://localhost:${BRIDGE_PORT}`);
    });
  } else {
    console.log(`ℹ️ Hosted mode — not binding extra port ${BRIDGE_PORT} (single PORT ${PORT} only, no cross-user state)`);
  }
}

createMainServer();
