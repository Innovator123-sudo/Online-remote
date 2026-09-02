/**
 * TV Control Hub — Unified Server (Website + Bridge)
 * Serves the gesture website AND the Wi-Fi discovery API on ONE port.
 * 
 * Run: node server.js
 * Then open: http://localhost:3000
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

const PORT = parseInt(process.env.PORT, 10) || 3000;
const BRIDGE_PORT = 3001; // also listen on 3001 for backward compat (local only)
const isHosted = !!process.env.VERCEL || !!process.env.RENDER || !!process.env.NETLIFY || process.env.NODE_ENV === 'production';
// When hosted (Vercel/Render/etc.) the server's LAN is the cloud, NOT the user's TV network.
// So we disable real SSDP and per-user state sharing — each client uses localStorage + simulated discovery.
// This ensures hosting doesn't leak one user's TVs to another.
let express, cors;
try { express=require('express'); cors=require('cors'); } catch(e){}

const MOCK_TVS = [
  { name:"Living Room TV", ip:"192.168.1.101", model:"TCL Android TV" },
  { name:"Bedroom TV", ip:"192.168.1.42", model:"Sony Bravia Google TV" },
];
// Valid-TV-only mode (fixes "scan the valid tv only"): start empty, only real SSDP results are valid.
// Mocks are only added as fallback demo if no valid found and client explicitly allows demo.
let discovered = [];
let states = new Map();
let lastValidScan = [];

// Reuse SSDP logic from bridge/server.js (fast, <3s)
function rawSsdpScan(timeout=2200){
  return new Promise((resolve)=>{
    const dgram = require('dgram');
    const found = new Map();
    const socket = dgram.createSocket({type:'udp4', reuseAddr:true});
    let finished=false;
    const finish=()=>{
      if(finished) return; finished=true;
      try{ socket.close(); }catch{}
      for(const [ip,info] of found){
        if(!discovered.some(d=> d.ip===ip)){
          discovered.push(info);
          console.log(`[ssdp-raw] found ${info.name} at ${ip}`);
        }
      }
      resolve();
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
          let name = '';
          if(/chromecast/i.test(server+' '+st)) name = `Chromecast TV ${rinfo.address.split('.').pop()}`;
          else if(/android/i.test(server+' '+st)) name = `Android TV ${rinfo.address.split('.').pop()}`;
          else { name = server.split(' ')[0] || ''; try{ if(!name && location) name = new URL(location).hostname; }catch{}; name = name || `TV ${rinfo.address}`; }
          if(!/tv/i.test(name)) name = `TV ${name}`;
          name = name.replace(/UPnP\/.*/,'').trim() || `TV ${rinfo.address}`;
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
    console.log("[ssdp] Hosted mode — skipping real SSDP (cloud LAN != user LAN). Client uses simulated + local bridge.");
    if(discovered.length===0) discovered.push(...MOCK_TVS.map(m=>({...m, via:'demo'})));
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
            let name = headers['X-Device-Name'] || '';
            if(!name && /chromecast/i.test(server)) name='Chromecast TV';
            else if(!name && /android/i.test(server)) name='Android TV';
            else if(!name && location){ try{ name=new URL(location).hostname.replace('.local',''); }catch{} }
            else if(!name && server) name=server.split(',')[0].split(' ')[0];
            name = (name||`TV ${rinfo.address}`);
            if(!/tv/i.test(name)) name = `TV ${name}`;
            name = name.replace(/UPnP.*/,'').trim() || `TV ${rinfo.address}`;
            discovered.push({ name: name.slice(0,40), ip:rinfo.address, model: st||'Android TV', via:'ssdp' });
            console.log(`[ssdp] Found: ${name} at ${rinfo.address}`);
          }
        }
      });
      ['urn:dial-multiscreen-org:service:dial:1','ssdp:all','urn:schemas-upnp-org:device:MediaRenderer:1'].forEach(t=> client.search(t));
      setTimeout(()=>{ try{ client.stop(); }catch{}; resolve(); }, 2200);
    });
  }catch(e){ if(e.code !== 'MODULE_NOT_FOUND') console.log("[ssdp] error:", e.message); }
  await Promise.all([raw, nodeScan]);
  // valid-only: only keep TVs that actually contain 'tv' (already filtered in rawSsdpScan)
  // Enrich from scan-results.json but only valid tv-named
  try{
    if(fs.existsSync('scan-results.json')){
      const j=JSON.parse(fs.readFileSync('scan-results.json','utf8'));
      (j.devices||[]).forEach(d=>{
        if(d.ip && /tv/i.test(d.name||'') && !discovered.some(x=> x.ip===d.ip)){
          discovered.push({name:d.name||`TV ${d.ip}`, ip:d.ip, model:d.st||'Android TV', via:'scan.js'});
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
  // CORS
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if(p==='/status' || p==='/api/status'){
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:true, bridge:true, tvs: discovered, states: Object.fromEntries(states) }));
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
      res.writeHead(200, {'Content-Type':'application/json'});
      if(!body.ip){ return res.end(JSON.stringify({ok:false, error:'no ip'})); }
      sendAdbCommand(body.ip, body.cmd, body.payload||'').then(ok=>{
        console.log(`[cmd] ${body.ip} ${body.cmd} → ${ok?'REAL ADB':'unavailable'}`);
        res.end(JSON.stringify({ok, sent:ok, via:'adb'}));
      });
    });
    return true;
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
    execFile(findAdbBin(), ['-s', `${ip}:5555`].concat(args), {timeout: 8000}, (err, stdout, stderr)=>{
      if(err){
        // Try reconnecting once, then retry the command
        execFile(findAdbBin(), ['connect', `${ip}:5555`], {timeout: 4000}, ()=>{
          execFile(findAdbBin(), ['-s', `${ip}:5555`].concat(args), {timeout: 8000}, (err2, o2, e2)=>{
            resolve(!err2);
          });
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
    console.log(`\n✅ TV Control Hub running at http://localhost:${PORT}`);
    console.log(`   Website: http://localhost:${PORT}/`);
    console.log(`   API:     http://localhost:${PORT}/status  http://localhost:${PORT}/scan`);
    console.log(`   Also listening on http://localhost:${BRIDGE_PORT} for old app.js compat`);
    console.log(`\n   Wi-Fi discovery: SSDP <3s, website shows TVs in <2s`);
    console.log(`   No bridge needed — demo TVs appear instantly. Real TVs via SSDP if on same Wi-Fi.\n`);
  });

  // Also listen on 3001 for old app.js that fetches http://localhost:3001/status (local only, not on hosted)
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
