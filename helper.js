/**
 * Online Remote — home helper (NO Cast, NO ADB).
 * Single method: Android TV Remote v2 (TCP 6466/6467 TLS) — the same
 * protocol the official Google TV phone app uses.
 *
 *   node helper.js   →   http://localhost:5000  (+ LAN URL printed)
 *   (+ https://<LAN-IP>:5443 with an auto-generated certificate —
 *   Chrome blocks the camera on plain http, so gestures need the https URL.
 *   Accept the one-time certificate warning, then camera + pairing work.)
 *
 * Scan = active LAN sweep for the TV remote port + SSDP listen.
 * Connect = pair request → TV shows PIN/Allow → approve once →
 *           cert saved → keys + typing work forever.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const net = require('net');
const path = require('path');
const url = require('url');
const remote2 = require('./remote2'); // Android TV Remote v2 (real remote protocol)

// ---------- tiny .env loader (no dependency; .env is gitignored) ----------
try{
  const envP = path.join(__dirname, '.env');
  if(fs.existsSync(envP)){
    fs.readFileSync(envP, 'utf8').split(/\r?\n/).forEach(line=>{
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if(!m || process.env[m[1]] !== undefined) return;
      let v = m[2];
      if(v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    });
  }
}catch{}

// ---------- cloud bridge (Railway 24/7 <-> home PC) ----------
// Problem: cloud servers cannot reach 192.168.x.x. Fix: the home PC keeps
// ONE outbound WebSocket to the cloud instance; the cloud instance forwards
// LAN-targeted /validate /cmd /remote-* calls through it and returns the
// replies over plain HTTP. Browser needs no changes (same relative URLs).
//   cloud instance:  BRIDGE_MODE=cloud  (+ RELAY_KEY)
//   home PC helper:  CLOUD_SERVER_URL=wss://<host>/bridge  (+ same RELAY_KEY)
let WS = null;
try{ WS = require('ws'); }catch{ console.log('[bridge] ws module missing — run `npm install` to enable the cloud link'); }
const BRIDGE_MODE = String(process.env.BRIDGE_MODE || 'home').toLowerCase();
const CLOUD_URL = String(process.env.CLOUD_SERVER_URL || '').trim();
const RELAY_KEY = String(process.env.RELAY_KEY || '').trim();
const bridge = {home:null, pending:new Map(), seq:0};
function isLanIp(ip){
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
  if(!m || m.slice(1).some(o=> +o < 0 || +o > 255)) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}
// Server side: accept the home PC's socket (key-checked), route replies.
function attachBridge(server){
  if(!WS) return;
  const wss = new WS.Server({server, path:'/bridge'});
  wss.on('connection', (sock, req)=>{
    const q = url.parse(req.url || '', true).query;
    if(!RELAY_KEY || q.key !== RELAY_KEY){ try{ sock.close(4401, 'bad key'); }catch{} return; }
    if(bridge.home){ try{ bridge.home.close(4400, 'replaced'); }catch{} }
    bridge.home = sock;
    console.log('[bridge] home PC connected ✓');
    sock.on('message', raw=>{
      let m = null; try{ m = JSON.parse(String(raw)); }catch{ return; }
      if(m && m.id && bridge.pending.has(m.id)){
        const p = bridge.pending.get(m.id); bridge.pending.delete(m.id);
        clearTimeout(p.timer); p.resolve(m);
      }
    });
    const gone = ()=>{ if(bridge.home === sock){ bridge.home = null; console.log('[bridge] home PC disconnected'); } };
    sock.on('close', gone); sock.on('error', gone);
  });
}
function bridgeSend(op, data, ms=25000){
  return new Promise(resolve=>{
    const sock = bridge.home;
    if(!WS || !sock || sock.readyState !== WS.OPEN){ resolve(null); return; }
    const id = `b${Date.now().toString(36)}${(bridge.seq = (bridge.seq + 1) % 1e6)}`;
    const timer = setTimeout(()=>{ bridge.pending.delete(id); resolve(null); }, ms);
    bridge.pending.set(id, {resolve, timer});
    try{ sock.send(JSON.stringify({id, op, ...data})); }
    catch{ clearTimeout(timer); bridge.pending.delete(id); resolve(null); }
  });
}
// Client side (home PC): execute cloud-forwarded ops against the real LAN.
function connectHome(){
  if(!WS || !CLOUD_URL) return;
  if(!RELAY_KEY){ console.log('[bridge] RELAY_KEY missing — cloud link disabled'); return; }
  const sep = CLOUD_URL.includes('?') ? '&' : '?';
  const target = `${CLOUD_URL}${sep}key=${encodeURIComponent(RELAY_KEY)}`;
  let retry = 1000;
  const open = ()=>{
    let sock = null;
    try{ sock = new WS(target); }catch{ schedule(); return; }
    sock.on('open', ()=>{ retry = 1000; console.log('[bridge] linked to cloud ✓ — this PC now relays TV commands'); });
    sock.on('message', async raw=>{
      let m = null; try{ m = JSON.parse(String(raw)); }catch{ return; }
      if(!m || !m.id || !m.op) return;
      const rep = {id:m.id};
      try{
        if(m.op === 'validate'){ const v = await validateIp(m.ip); Object.assign(rep, {ok:true, valid:v.valid, via:v.via, name:v.name, needPair:!!v.needPair}); }
        else if(m.op === 'cmd'){ Object.assign(rep, await runCmd(m.ip, m.cmd, m.payload || '')); }
        else if(m.op === 'pair-begin'){ Object.assign(rep, remote2.pairBegin(m.ip)); }
        else if(m.op === 'pair-code'){ Object.assign(rep, await remote2.pairCode(m.ip, m.code || '')); }
        else if(m.op === 'pair-status'){ Object.assign(rep, {ok:true, ...remote2.pairStatus(m.ip)}); }
        else if(m.op === 'scan'){ Object.assign(rep, {ok:true, tvs:await fullScan()}); }
        else Object.assign(rep, {ok:false, error:'bad op'});
      }catch(e){ Object.assign(rep, {ok:false, error:String((e && e.message) || e)}); }
      try{ sock.send(JSON.stringify(rep)); }catch{}
    });
    sock.on('close', ()=> schedule());
    sock.on('error', ()=>{ try{ sock.close(); }catch{} });
  };
  const schedule = ()=> setTimeout(open, retry < 30000 ? (retry *= 2) : 30000);
  open();
}

const PORT = parseInt(process.env.PORT, 10) || 5000;
let discovered = [];
let lastScanAt = 0;

// ---------- helpers ----------
function pna(res, req){
  res.setHeader('Access-Control-Allow-Origin', (req.headers && req.headers.origin) || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}
function json(res, obj, code=200){
  res.writeHead(code, {'Content-Type':'application/json'});
  res.end(JSON.stringify(obj));
}
function upsertTv(info){
  if(!info || !info.ip) return;
  const i = discovered.findIndex(d=> d.ip === info.ip);
  const rec = {name:info.name || 'Android TV', ip:info.ip, model:info.model || 'Android TV', via:'remote'};
  if(i >= 0) discovered[i] = {...discovered[i], ...rec};
  else discovered.push(rec);
}
function probeTcp(ip, port, ms=900){
  return new Promise(resolve=>{
    let done = false;
    const fin = v=>{ if(!done){ done = true; try{ s.destroy(); }catch{} resolve(v); } };
    const s = new net.Socket();
    s.setTimeout(ms);
    s.on('connect', ()=> fin(true));
    s.on('timeout', ()=> fin(false));
    s.on('error', ()=> fin(false));
    try{ s.connect(port, ip); }catch{ fin(false); }
  });
}
// Brand fingerprint without Cast/ADB: which remote port answers?
async function fingerprintIp(ip){
  if(await probeTcp(ip, 6466, 900)) return {name:'Android TV', model:'Android TV', via:'remote'};
  if(await probeTcp(ip, 6467, 900)) return {name:'Android TV', model:'Android TV', via:'remote'};
  // Samsung Tizen (WS 8001/8002), LG webOS (3000/3001), Roku ECP (8060)
  if(await probeTcp(ip, 8060, 700)){
    let name = 'Roku TV';
    try{
      const info = await httpGet(ip, 8060, '/query/device-info', 2000);
      const m = info && info.match(/<friendly-device-name>([^<]+)<\/friendly-device-name>/i);
      if(m) name = m[1].trim().slice(0, 40);
    }catch{}
    return {name, model:'Roku', via:'remote'};
  }
  if(await probeTcp(ip, 8001, 700)) return {name:'Samsung TV', model:'Tizen', via:'remote'};
  if(await probeTcp(ip, 3000, 700)) return {name:'LG TV', model:'webOS', via:'remote'};
  return null;
}
function httpGet(ip, port, reqPath, ms=2000){
  return new Promise(resolve=>{
    try{
      const r = http.request({host:ip, port, path:reqPath, method:'GET', timeout:ms}, rs=>{
        let d = ''; rs.on('data', c=> d += c);
        rs.on('end', ()=> resolve(d));
      });
      r.on('error', ()=> resolve(null));
      r.on('timeout', ()=>{ try{ r.destroy(); }catch{}; resolve(null); });
      r.end();
    }catch{ resolve(null); }
  });
}
function getSubnetBases(){
  const bases = [];
  try{
    const nets = require('os').networkInterfaces();
    for(const n of Object.keys(nets)){
      for(const a of nets[n] || []){
        if(a.family !== 'IPv4' || a.internal) continue;
        const parts = a.address.split('.');
        if(parts.length !== 4) continue;
        const [x, y] = parts.map(Number);
        const isHome = x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
        if(!isHome) continue;
        const base = parts.slice(0, 3).join('.');
        if(!bases.includes(base)) bases.push(base);
      }
    }
  }catch{}
  if(!bases.length) bases.push('192.168.1');
  return bases;
}
// Active sweep: knock on the TV-remote port across the whole /24.
// This finds TVs even when multicast SSDP is blocked by the router.
async function sweepSubnet(base, onFound){
  const CONC = 64;
  const ips = [];
  for(let i = 1; i <= 254; i++) ips.push(`${base}.${i}`);
  let idx = 0;
  async function worker(){
    while(idx < ips.length){
      const ip = ips[idx++];
      try{
        if(await probeTcp(ip, 6466, 800)){
          const fp = await fingerprintIp(ip);
          upsertTv({ip, name:(fp && fp.name) || 'Android TV', model:(fp && fp.model) || 'Android TV'});
          if(onFound) onFound(ip);
        }
      }catch{}
    }
  }
  await Promise.all(Array.from({length:CONC}, ()=> worker()));
}

// ---------- SSDP discovery (supplementary listener, any device) ----------
function ssdpScan(timeout=2500){
  return new Promise(resolve=>{
    const dgram = require('dgram');
    const foundIps = new Set();
    const sock = dgram.createSocket({type:'udp4', reuseAddr:true});
    let done = false;
    const finish = async ()=>{
      if(done) return; done = true;
      try{ sock.close(); }catch{}
      // Fingerprint every SSDP speaker via TCP — no keyword filtering,
      // so TVs with unusual SERVER strings still show up.
      const jobs = [...foundIps].map(async ip=>{
        try{
          const fp = await fingerprintIp(ip);
          if(fp) upsertTv({ip, name:fp.name, model:fp.model});
          else upsertTv({ip, name:'TV', model:'TV'});
        }catch{}
      });
      await Promise.all(jobs);
      resolve();
    };
    sock.on('error', ()=> finish());
    sock.on('message', (msg, rinfo)=>{
      if(rinfo && rinfo.address && !foundIps.has(rinfo.address)) foundIps.add(rinfo.address);
    });
    sock.bind(0, ()=>{
      try{ sock.addMembership('239.255.255.250'); }catch{}
      try{ sock.setBroadcast(true); }catch{}
      const mk = st=> Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ns:01; ns=01;"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
      ['ssdp:all', 'upnp:rootdevice', 'urn:schemas-upnp-org:device:MediaRenderer:1'].forEach((st, i)=>{
        const b = mk(st);
        setTimeout(()=>{ try{ sock.send(b, 0, b.length, 1900, '239.255.255.250', ()=>{}); }catch{} }, i*150);
      });
    });
    setTimeout(finish, timeout);
  });
}

async function fullScan(){
  lastScanAt = Date.now();
  const bases = getSubnetBases();
  await Promise.all([
    ssdpScan(2500),
    ...bases.map(b=> sweepSubnet(b)),
  ]);
  // Second pass: other-brand ports for hosts SSDP saw but sweep missed
  // (sweep already covers 6466; fingerprint covers the rest on demand).
  return discovered;
}

// ---------- transport orchestration (Remote v2 ONLY — no adb, no cast) ----------
const viaCache = new Map();
async function validateIp(ip){
  // 1) Official remote protocol. Handles cert + PIN state internally.
  try{
    const rem = await remote2.validateRemote(ip).catch(()=> ({ok:false}));
    if(rem && rem.ok){
      viaCache.set(ip, 'remote');
      // Try to read a friendly name via brand HTTP (best-effort, non-cast)
      let name = '';
      try{
        if(await probeTcp(ip, 8060, 600)){
          const info = await httpGet(ip, 8060, '/query/device-info', 1500);
          const m = info && info.match(/<friendly-device-name>([^<]+)<\/friendly-device-name>/i);
          if(m) name = m[1].trim().slice(0, 40);
        }
      }catch{}
      return {valid:true, via:'remote', name};
    }
    if(rem && rem.needPair) return {valid:false, needPair:true};
  }catch{}
  // 2) Raw port probe even if the lib is missing — TV still "shows up",
  //    pairing step will explain what to do.
  try{
    if(await probeTcp(ip, 6466, 1200)) return {valid:false, needPair:true};
  }catch{}
  // 3) Other brands answer their own remote ports (no pairing needed to list)
  try{
    const fp = await fingerprintIp(ip);
    if(fp && fp.via === 'remote' && /Roku|Samsung|LG/i.test(fp.name||'')){
      viaCache.set(ip, 'remote');
      return {valid:true, via:'remote', name:fp.name};
    }
  }catch{}
  return {valid:false};
}
async function runCmd(ip, cmd, payload){
  // Approve-then-apply: only a paired TV accepts keys. If not paired,
  // tell the site so it opens the PIN flow instead of failing silently.
  try{
    const send = cmd === 'TEXT'
      ? remote2.sendRemoteText(ip, payload)
      : ((cmd in remote2.REMOTE_KEYS) ? remote2.sendRemoteKey(ip, remote2.REMOTE_KEYS[cmd]) : Promise.resolve(false));
    const ok = await Promise.race([send, new Promise(r=> setTimeout(()=> r(false), 12000))]);
    if(ok){ viaCache.set(ip, 'remote'); return {ok:true, via:'remote'}; }
    if(!(cmd in remote2.REMOTE_KEYS) && cmd !== 'TEXT') return {ok:false, error:'unsupported'};
  }catch(e){
    const msg = String((e && e.message) || e);
    if(msg === 'need-pair') return {ok:false, error:'need-pair'};
    try{ remote2.dropSession(ip); }catch{}
    // Re-check: TV visible but unpaired → guide user to approve
    try{
      const v = await validateIp(ip);
      if(v && v.needPair) return {ok:false, error:'need-pair'};
    }catch{}
    return {ok:false, error:'unreachable'};
  }
  // Key rejected — most likely TV not paired yet
  try{
    const v = await validateIp(ip);
    if(v && v.needPair) return {ok:false, error:'need-pair'};
  }catch{}
  return {ok:false, error:'unreachable'};
}

// In cloud mode, LAN targets execute on the home PC via the bridge.
// Returns true when the response was (or will be) sent through the bridge.
const cloudFor = ip => BRIDGE_MODE === 'cloud' && isLanIp(ip || '');
function bridgeJson(res, op, data, ms=25000){
  bridgeSend(op, data, ms).then(r=>{
    if(res.writableEnded) return;
    if(!r) return json(res, {ok:false, error:'home PC offline — start the helper on your home PC'});
    const {id, ...out} = r;
    json(res, (out && out.ok !== undefined) ? out : {ok:false, error:'bad bridge reply'});
  }).catch(()=>{ if(!res.writableEnded) json(res, {ok:false, error:'bridge failed'}); });
  return true;
}

// ---------- server ----------
const MIME = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon'};
function onReq(req, res){
  pna(res, req);
  if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if(p === '/status'){ return json(res, {ok:true, bridge:true, mode:BRIDGE_MODE, homeLinked:!!bridge.home, tvs:discovered, lastScanAt}); }
  if(p === '/health'){ return json(res, {ok:true, bridge:true}); }
  if(p === '/scan'){
    if(BRIDGE_MODE === 'cloud'){
      if(!bridge.home) return json(res, {tvs:[], error:'home PC offline'});
      bridgeSend('scan', {}, 120000).then(r=>{
        if(res.writableEnded) return;
        if(!r) return json(res, {tvs:discovered});
        const {id, ...out} = r;
        json(res, {tvs:(out && out.tvs) || discovered});
      });
      return;
    }
    // Longer budget: sweep of a /24 takes ~4-8s. Site shows progress.
    fullScan().then(()=> json(res, {tvs:discovered})).catch(()=> json(res, {tvs:discovered}));
    return;
  }
  if(p === '/validate'){
    const ip = parsed.query.ip || '';
    res.writeHead(200, {'Content-Type':'application/json'});
    if(!ip) return res.end(JSON.stringify({ok:false, valid:false}));
    if(cloudFor(ip)){
      bridgeSend('validate', {ip}, 20000).then(r=>{
        if(res.writableEnded) return;
        if(!r) return res.end(JSON.stringify({ok:false, valid:false, error:'home PC offline — start the helper on your home PC'}));
        const {id, ...out} = r;
        res.end(JSON.stringify(out));
      });
      return;
    }
    validateIp(ip).then(v=>{
      console.log(`[validate] ${ip} → ${v.valid ? v.via : (v.needPair ? 'need-pair' : 'invalid')}`);
      if(v.valid) upsertTv({ip, name:v.name || 'Android TV'});
      else if(v.needPair) upsertTv({ip, name:'Android TV'});
      res.end(JSON.stringify({ok:true, valid:v.valid, via:v.via, name:v.name, needPair:!!v.needPair}));
    }).catch(()=> res.end(JSON.stringify({ok:true, valid:false})));
    return;
  }
  if(p === '/cmd'){
    let body = '';
    req.on('data', c=> body += c);
    req.on('end', ()=>{
      try{ body = JSON.parse(body || '{}'); }catch{ body = {}; }
      if(!body.ip) return json(res, {ok:false, error:'no ip'}, 400);
      if(cloudFor(body.ip)) return bridgeJson(res, 'cmd', {ip:body.ip, cmd:body.cmd, payload:body.payload || ''}, 28000);
      const to = setTimeout(()=>{ if(!res.writableEnded) json(res, {ok:false, error:'timeout'}, 504); }, 25000);
      runCmd(body.ip, body.cmd, body.payload || '').then(r=>{
        clearTimeout(to);
        console.log(`[cmd] ${body.ip} ${body.cmd} → ${r.ok ? r.via : r.error}`);
        if(!res.writableEnded) json(res, {ok:r.ok, sent:r.ok, via:r.via, error:r.error});
      }).catch(e=>{
        clearTimeout(to);
        if(!res.writableEnded) json(res, {ok:false, error:String((e && e.message) || e)});
      });
    });
    return;
  }
  // TV-protocol (Remote v2) pairing: TV shows a PIN, user types it.
  if(p === '/remote-pair' || p === '/remote-code' || p === '/remote-status'){
    let body = '';
    req.on('data', c=> body += c);
    req.on('end', ()=>{
      try{ body = JSON.parse(body || '{}'); }catch{ body = {}; }
      const ip = body.ip || parsed.query.ip || '';
      if(!ip) return json(res, {ok:false, error:'no ip'}, 400);
      if(p === '/remote-status'){
        if(cloudFor(ip)) return bridgeJson(res, 'pair-status', {ip}, 15000);
        return json(res, {ok:true, ...remote2.pairStatus(ip)});
      }
      if(p === '/remote-pair'){
        if(cloudFor(ip)) return bridgeJson(res, 'pair-begin', {ip}, 15000);
        const r = remote2.pairBegin(ip);
        console.log(`[remote-pair] ${ip} → ${r.ok ? (r.alreadyPaired ? 'already paired' : 'PIN requested') : r.error}`);
        return json(res, r);
      }
      if(cloudFor(ip)) return bridgeJson(res, 'pair-code', {ip, code:body.code || ''}, 30000);
      remote2.pairCode(ip, body.code || '').then(r=>{
        console.log(`[remote-code] ${ip} → ${r.ok ? 'paired' : r.error}`);
        if(r.ok) viaCache.set(ip, 'remote');
        json(res, r);
      }).catch(e=> json(res, {ok:false, error:String((e && e.message) || e)}));
    });
    return;
  }

  let fp = parsed.pathname;
  if(fp === '/') fp = '/index.html';
  fp = path.join(__dirname, fp);
  if(!fp.startsWith(__dirname)){ res.writeHead(403); return res.end('Forbidden'); }
  if(!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(__dirname, 'index.html');
  fs.readFile(fp, (err, data)=>{
    if(err){ res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type':MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control':'no-cache'});
    res.end(data);
  });
}

function lanIp(){
  try{
    const nets = require('os').networkInterfaces();
    const found = [];
    for(const n of Object.keys(nets)){
      for(const a of nets[n] || []){
        if(a.family === 'IPv4' && !a.internal && /^(192\.168\.|10\.|172\.)/.test(a.address) && !found.includes(a.address)) found.push(a.address);
      }
    }
    // Prefer real home Wi-Fi over virtual adapters: 192.168.x > 10.x > 172.16-31.x
    const rank = ip => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2;
    found.sort((a, b) => rank(a) - rank(b));
    return found[0] || '';
  }catch{}
  return '';
}

// Self-signed certificate for the LAN https server (camera needs a secure
// context; plain http://192.168.x.x is not one). Generated once, reused.
function httpsCreds(){
  const dir = path.join(__dirname, 'https-cert');
  const keyP = path.join(dir, 'key.pem'), certP = path.join(dir, 'cert.pem');
  try{
    if(fs.existsSync(keyP) && fs.existsSync(certP)){
      return {key:fs.readFileSync(keyP), cert:fs.readFileSync(certP)};
    }
  }catch{}
  let selfsigned = null;
  try{ selfsigned = require('selfsigned'); }catch{ return null; }
  const lan = lanIp();
  const sans = [{name:'critical', cA:false}];
  const altNames = [{type:2, value:'localhost'}, {type:7, ip:'127.0.0.1'}, {type:7, ip:'::1'}];
  if(lan){
    altNames.push({type:2, value:lan});
    if(/^\d+\.\d+\.\d+\.\d+$/.test(lan)) altNames.push({type:7, ip:lan});
  }
  try{
    const pems = selfsigned.generate([{name:'commonName', value:lan || 'localhost'}], {
      keySize:2048, days:825, algorithm:'sha256',
      extensions:[{name:'basicConstraints', cA:false}, {name:'subjectAltName', altNames}],
    });
    try{ fs.mkdirSync(dir, {recursive:true}); }catch{}
    try{ fs.writeFileSync(keyP, pems.private); fs.writeFileSync(certP, pems.cert); }catch{}
    return {key:pems.private, cert:pems.cert};
  }catch(e){ console.log('[https] cert generation failed: ' + ((e && e.message) || e)); return null; }
}

const server = http.createServer(onReq);
server.listen(PORT, '0.0.0.0', ()=>{
  attachBridge(server); // accept home-PC socket on /bridge (both modes)
  connectHome();        // no-op unless CLOUD_SERVER_URL is set (home PC)
  const lan = lanIp();
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME);
  console.log(`\n✅ Online Remote helper at http://localhost:${PORT}/ (Remote v2 — no Cast, no ADB)`);
  if(process.env.RAILWAY_PUBLIC_DOMAIN) console.log(`   🌍 Public (Railway): https://${process.env.RAILWAY_PUBLIC_DOMAIN}/`);
  if(lan) console.log(`   📱 Same Wi-Fi phones (pairing):  http://${lan}:${PORT}/`);
  if(onRailway){
    // Railway gives ONE port and terminates TLS itself — no second https
    // listener. Camera + pairing work over the public https URL. TV certs
    // persist via REMOTE_CERT_JSON env (disk is ephemeral) or a Volume
    // mounted at REMOTE_CERT_DIR.
    console.log('   🚂 Railway mode: single-port http (TLS handled by Railway).');
    console.log('   Scan: LAN sweep (port 6466) + SSDP. Pair: approve PIN on TV once.\n');
    return;
  }
  // Camera needs https → second listener with auto-generated cert.
  const creds = httpsCreds();
  const SPORT = parseInt(process.env.SPORT, 10) || 5443;
  if(creds){
    try{
      https.createServer(creds, onReq).listen(SPORT, '0.0.0.0', ()=>{
        if(lan) console.log(`   📷 Same Wi-Fi phones (camera+pairing): https://${lan}:${SPORT}/  (accept the cert warning once)`);
        else console.log(`   📷 Camera page: https://localhost:${SPORT}/`);
      });
    }catch(e){ console.log('[https] disabled: ' + ((e && e.message) || e)); }
  } else {
    console.log('   📷 Camera needs https — run `npm i selfsigned` then restart to enable it.');
  }
  console.log('   Scan: LAN sweep (port 6466) + SSDP. Pair: approve PIN on TV once.\n');
});
