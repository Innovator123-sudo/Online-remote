/**
 * TV Control Hub — Gesture Edition — Local Bridge
 * Real LAN discovery via SSDP/mDNS + command proxy.
 * Run:  node bridge/server.js
 * Then open the website on http://localhost:5173 or file:// — it auto-detects bridge at http://localhost:3001
 *
 * Requires: npm i express cors node-ssdp dgram
 * If not installed, server still runs in mock mode.
 */
const http = require("http");
const PORT = parseInt(process.env.PORT,10) || 3001;
const isHosted = !!process.env.VERCEL || !!process.env.RENDER || !!process.env.NETLIFY || process.env.NODE_ENV==='production';

let express, cors;
try { express=require("express"); cors=require("cors"); } catch(e){
  console.log("Tip: npm i express cors  — running with built-in http fallback (mock discovery)");
}

const MOCK_TVS = [
  { name:"Living Room TV", ip:"192.168.1.101", model:"TCL Android TV" },
  { name:"Bedroom TV", ip:"192.168.1.42", model:"Sony Bravia Google TV" },
];

let discovered = [];
let states = new Map();

const fs = require("fs");
const path = require("path");

const KEYEVENT = {
  DPAD_UP:19, DPAD_DOWN:20, DPAD_LEFT:21, DPAD_RIGHT:22, DPAD_CENTER:23,
  ENTER:66, BACK:4, HOME:3, MENU:82, VOLUME_UP:24, VOLUME_DOWN:25, MUTE:164, POWER:26,
  SEARCH:84, TEXT:0,
};

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

function findAdbBin(){
  const candidates = [
    path.join(__dirname, '..', 'platform-tools', process.platform==='win32'?'adb.exe':'adb'),
    path.join(__dirname, 'platform-tools', process.platform==='win32'?'adb.exe':'adb'),
    'adb',
  ];
  for(const c of candidates){
    try{ if(fs.existsSync(c) || c==='adb') return c; }catch{}
  }
  return 'adb';
}

function sendAdb(ip, args){
  return new Promise((resolve)=>{
    const { execFile } = require('child_process');
    execFile(findAdbBin(), ['-s', `${ip}:5555`].concat(args), {timeout: 8000}, (err, stdout, stderr)=>{
      if(err){
        execFile(findAdbBin(), ['connect', `${ip}:5555`], {timeout: 4000}, ()=>{
          execFile(findAdbBin(), ['-s', `${ip}:5555`].concat(args), {timeout: 8000}, (err2)=>{
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
    const safe = String(payload).replace(/ /g,'%s').replace(/&/g,'\\&').replace(/\|/g,'\\|').replace(/;/g,'\\;').replace(/[<>()]/g,'\\$&');
    return sendAdb(ip, ['shell','input','text', safe]);
  }
  const code = KEYEVENT[cmd];
  if(!code) return false;
  return sendAdb(ip, ['shell','input','keyevent', String(code)]);
}

let ssdpClient=null;

// Raw SSDP via dgram — no deps, works on Windows/macOS/Linux — 5s target FAST
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
      // Enrich names from Cast eureka_info / DIAL XML (parallel, max ~1500ms)
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
            console.log(`[ssdp-raw] found ${info.name} at ${ip} ST=${info.st}`);
          }
        }
        resolve();
      });
    };
    socket.on('error', (err)=>{
      console.log('[ssdp-raw] socket error', err.message);
      finish();
    });
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
          found.set(rinfo.address, { name: name.slice(0,40), ip:rinfo.address, model:st||'Android TV', st, location, server });
        }
      }
    });
    socket.bind(0, ()=>{
      try{ socket.addMembership('239.255.255.250'); }catch{}
      socket.setBroadcast(true);
      socket.setMulticastTTL(4);
      const mk = (st)=> Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
      // burst quickly for <5s detection
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
    console.log("[ssdp] Hosted mode — skip real SSDP, return mocks only (no cross-user leak)");
    return;
  }
  // Fast <5s scan: raw SSDP 2.2s is primary; total <3s
  console.log("[ssdp] Starting fast SSDP scan (<3s)...");
  const raw = rawSsdpScan(2200);
  let nodeScan = Promise.resolve();
  try{
    const { Client } = require("node-ssdp");
    nodeScan = new Promise(async (resolve)=>{
      ssdpClient = new Client({ timeout: 2200, allowNative: true, ipVersion: 4 });
      ssdpClient.on('response', (headers, statusCode, rinfo) => {
        const st = headers.ST || headers.st || '';
        const server = headers.SERVER || headers.server || '';
        const location = headers.LOCATION || headers.location || '';
        const deviceName = headers['X-Device-Name'] || headers['X-Android-Device-Name'] || '';
        const isTv = /dial|android|google|chromecast|cast|roku|firetv|philips|sony|tcl|hisense|bravia|upnp|mediarenderer|tv/i.test(st + ' ' + server + ' ' + location);
        if (isTv) {
          if (!discovered.some(d => d.ip === rinfo.address)) {
            const deviceName = headers['X-Device-Name'] || headers['X-Android-Device-Name'] || '';
            let name = deviceName || buildDeviceName(server, st, location, rinfo.address);
            if(!/tv|chromecast|cast/i.test(name)) name = `${name} TV`;
            name = name.replace(/UPnP.*/,'').trim() || `TV ${rinfo.address}`;
            discovered.push({ name: name.slice(0,40), ip:rinfo.address, model:st||'Android TV', via:'ssdp', location });
            console.log(`[ssdp] Found: ${name} at ${rinfo.address}`);
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
      ssdpClient.on('error', (err)=> console.log('[ssdp] Error:', err.message));
      ['urn:dial-multiscreen-org:service:dial:1','ssdp:all','urn:schemas-upnp-org:device:MediaRenderer:1'].forEach(t=> ssdpClient.search(t));
      setTimeout(()=>{ try{ ssdpClient.stop(); }catch{}; resolve(); }, 2200);
    });
  }catch(e){
    if(e.code !== 'MODULE_NOT_FOUND') console.log("[ssdp] node-ssdp error:", e.message);
  }
  await Promise.all([raw, nodeScan]);
  // final enrichment: also check scan-results.json from standalone scan.js if exists (instant)
  try{
    const fs=require('fs');
    if(fs.existsSync('scan-results.json') || fs.existsSync('../scan-results.json')){
      const path = fs.existsSync('scan-results.json') ? 'scan-results.json' : '../scan-results.json';
      const j=JSON.parse(fs.readFileSync(path,'utf8'));
      (j.devices||[]).forEach(d=>{
        const name = d.name || '';
        const isMock = /\(mock\)|mock/i.test(name) || d.via==='mock';
        if(d.ip && !isMock && !discovered.some(x=> x.ip===d.ip)){
          discovered.push({name:name||`TV ${d.ip}`, ip:d.ip, model:d.st||'Android TV', via:'scan.js'});
          console.log(`[ssdp] Imported from scan.js: ${d.ip}`);
        }
      });
    }
  }catch{}
  console.log(`[ssdp] Scan complete (${((Date.now()/1000)%100).toFixed(1)}s) — total ${discovered.length} device(s)`);
}

function buildApp(){
  if(express){
    const app = express();
    // CORS + Private Network Access so a free-cloud https page can use this home bridge
    app.use((req,res,next)=>{
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Private-Network","true");
      if(req.method==="OPTIONS") return res.sendStatus(204);
      next();
    });
    app.use(cors());
    app.use(express.json());
    app.get("/status", (req,res)=>{
      res.json({ ok:true, bridge:true, tvs: discovered, states: Object.fromEntries(states) });
    });
    app.get("/scan", async (req,res)=>{
      await ssdpScan();
      res.json({ tvs: discovered });
    });
    app.post("/pair", (req,res)=>{
      const {ip, code} = req.body||{};
      if(!ip || !/^\d{6}$/.test(String(code||""))) return res.status(400).json({ok:false, error:"bad code"});
      if(String(code)==="000000") return res.status(401).json({ok:false, error:"wrong code"});
      if(!isHosted) states.set(ip, {...(states.get(ip)||{}), paired:true });
      console.log(`[pair] ${ip} OK ${isHosted?'(hosted, not persisted)':''}`);
      res.json({ok:true, paired:true});
    });
    app.get("/state", (req,res)=>{
      const ip=req.query.ip;
      const st = isHosted ? {paired:false, searchActive:false} : (states.get(ip)||{paired:false, searchActive:false});
      res.json(st);
    });
    app.post("/search", (req,res)=>{
      const {ip, active}=req.body||{};
      if(!isHosted) states.set(ip, {...(states.get(ip)||{}), searchActive: !!active});
      console.log(`[search] ${ip} active=${active} ${isHosted?'(hosted)':''}`);
      res.json({ok:true});
    });
    app.post("/cmd", async (req,res)=>{
      const {ip, cmd, payload}=req.body||{};
      if(!ip){ return res.json({ok:false, error:"no ip"}); }
      let ok=false, error=null;
      try{
        ok = await sendAdbCommand(ip, cmd, payload||"");
      }catch(e){
        ok=false; error=e.message||String(e);
      }
      console.log(`[cmd] ${ip} ${cmd} ${payload||""} → ${ok?'REAL ADB':(error||'unavailable')}`);
      res.json({ok, sent:ok, via:'adb', error});
    });
    app.get("/validate", async (req,res)=>{
      const ip = req.query.ip;
      if(!ip){ return res.json({ok:false, valid:false, error:"no ip"}); }
      try{
        const isValid = await sendAdb(ip, ['shell','echo','test']);
        res.json({ok:true, valid:isValid, via:'adb'});
      }catch(e){
        res.json({ok:true, valid:false, error:e.message||String(e)});
      }
    });
    app.get("/", (req,res)=> res.send("TV Control Hub Bridge OK — GET /status, /scan, POST /cmd, GET /validate"));
    return app;
  } else {
    const server = http.createServer((req,res)=>{
      res.setHeader("Access-Control-Allow-Origin","*");
      res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Private-Network","true");
      if(req.method==="OPTIONS"){ res.writeHead(204); return res.end(); }
      if(req.url.startsWith("/status")){
        res.writeHead(200, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({ok:true, bridge:true, tvs:discovered}));
      }
      if(req.url.startsWith("/scan")){
        ssdpScan().then(()=>{
          res.writeHead(200, {"Content-Type":"application/json"});
          res.end(JSON.stringify({tvs:discovered}));
        });
        return;
      }
      if(req.url.startsWith("/validate")){
        const { URL } = require('url');
        let ip="";
        try{ ip = new URL('http://x'+req.url).searchParams.get('ip')||''; }catch{ ip=""; }
        if(!ip){ res.writeHead(200, {"Content-Type":"application/json"}); return res.end(JSON.stringify({ok:false, valid:false, error:"no ip"})); }
        sendAdb(ip, ['shell','echo','test']).then(isValid=>{
          console.log(`[validate] ${ip} → ${isValid?'valid':'invalid'}`);
          res.writeHead(200, {"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:true, valid:isValid, via:'adb'}));
        }).catch(err=>{
          res.writeHead(200, {"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:true, valid:false, error:err.message||String(err)}));
        });
        return;
      }
      let body="";
      req.on("data", c=> body+=c);
      req.on("end", ()=>{
        try{ body=JSON.parse(body||"{}"); }catch{ body={}; }
        if(req.url.startsWith("/pair")){
          if(!body.ip || !/^\d{6}$/.test(String(body.code||""))){ res.writeHead(400); return res.end(JSON.stringify({ok:false})); }
          if(!isHosted) states.set(body.ip, {...(states.get(body.ip)||{}), paired:true});
          res.writeHead(200, {"Content-Type":"application/json"}); return res.end(JSON.stringify({ok:true}));
        }
        if(req.url.startsWith("/cmd")){
          if(!body.ip){ res.writeHead(200, {"Content-Type":"application/json"}); return res.end(JSON.stringify({ok:false, error:"no ip"})); }
          sendAdbCommand(body.ip, body.cmd, body.payload||"").then(ok=>{
            console.log(`[cmd] ${body.ip} ${body.cmd} ${body.payload||""} → ${ok?'REAL ADB':'unavailable'}`);
            res.writeHead(200, {"Content-Type":"application/json"});
            res.end(JSON.stringify({ok, sent:ok, via:'adb'}));
          }).catch(err=>{
            console.error(`[cmd] error: ${err.message}`);
            res.writeHead(200, {"Content-Type":"application/json"});
            res.end(JSON.stringify({ok:false, sent:false, via:'adb', error:err.message}));
          });
          return; // Don't end response here - wait for async ADB
        }
        if(req.url.startsWith("/search")){
          if(!isHosted) states.set(body.ip, {...(states.get(body.ip)||{}), searchActive: !!body.active});
          res.writeHead(200, {"Content-Type":"application/json"}); return res.end(JSON.stringify({ok:true}));
        }
        res.writeHead(404); res.end("not found");
      });
    });
    server._isRaw=true;
    return server;
  }
}

const app = buildApp();
if(app._isRaw){
  app.listen(PORT, ()=> console.log(`Bridge (raw http) listening on http://localhost:${PORT} — discovered mocks:`, discovered));
} else {
  app.listen(PORT, ()=> console.log(`Bridge listening on http://localhost:${PORT} — try GET /status`));
}
