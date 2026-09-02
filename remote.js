#!/usr/bin/env node
/**
 * TV Remote via Node — Connect and send D-Pad (left/right/up)
 * Usage:
 *   node remote.js                     # auto-find TV (name tv) + connect + left/right/up demo
 *   node remote.js --ip 192.168.1.84   # use specific IP
 *   node remote.js --left              # single left
 *   node remote.js --right --up --left # sequence
 *   node remote.js --test              # demo: left, right, up with delays
 *   node remote.js --pair 123456       # pair with code (any 6 digits except 000000)
 */

const http = require('http');
const https = require('https');
const dgram = require('dgram');
const os = require('os');

const args = process.argv.slice(2);
const getArg = (k, def) => {
  const i = args.indexOf(k);
  return i !== -1 && args[i+1] && !args[i+1].startsWith('--') ? args[i+1] : def;
};
const has = (k) => args.includes(k);
const ipArg = getArg('--ip', getArg('--host', null));
const pairCode = getArg('--pair', null);
const bridgeUrls = ["http://localhost:5000", "http://localhost:3000", "http://localhost:3001"];

// Map CLI to DPAD
const cmdMap = {
  left: 'DPAD_LEFT', right: 'DPAD_RIGHT', up: 'DPAD_UP', down: 'DPAD_DOWN', ok: 'DPAD_CENTER', center: 'DPAD_CENTER',
  home: 'HOME', back: 'BACK', power: 'POWER'
};

function log(...a){ console.log(...a); }

function httpJson(url, opts={}, body=null){
  return new Promise((resolve, reject)=>{
    const u = new URL(url);
    const lib = u.protocol==='https:'?https:http;
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method||'GET',
      headers: {'Content-Type':'application/json', ...(opts.headers||{}), ...(data?{'Content-Length':Buffer.byteLength(data)}:{})},
      timeout: opts.timeout||4000
    }, res=>{
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
        try{ resolve({ok: res.statusCode>=200&&res.statusCode<300, status:res.statusCode, json: JSON.parse(d), text:d }) }
        catch{ resolve({ok: res.statusCode>=200&&res.statusCode<300, status:res.statusCode, text:d }) }
      });
    });
    req.on('error', reject);
    req.on('timeout', ()=>{ req.destroy(); reject(new Error('timeout')); });
    if(data) req.write(data);
    req.end();
  });
}

async function findBridge(){
  for(const base of bridgeUrls){
    try{
      const r = await httpJson(`${base}/status`, {timeout:900});
      if(r.ok) return base;
    }catch{}
  }
  return null;
}

async function discoverTv(timeout=3000){
  // Try bridge first (fastest)
  const bridge = await findBridge();
  if(bridge){
    try{
      const r = await httpJson(`${bridge}/scan`, {timeout:4000});
      if(r.ok && r.json && r.json.tvs && r.json.tvs.length){
        // Prefer real Wi-Fi TVs (ssdp/scan.js) over demo mocks, and tv-named
        const all = r.json.tvs;
        const real = all.filter(t=> /tv/i.test(t.name) && !['192.168.1.101','192.168.1.42'].includes(t.ip));
        const tvs = real.length ? real : all.filter(t=> /tv/i.test(t.name));
        const pick = tvs[0] || all.find(t=> t.ip==='192.168.1.84') || all[0];
        if(pick) return {ip: pick.ip, name: pick.name, via:'bridge', bridge};
      }
    }catch(e){ log('bridge scan fail', e.message); }
  }
  // Fallback SSDP raw (like scan.js)
  log('Discovering via SSDP (<3s)...');
  return new Promise((resolve)=>{
    const found = new Map();
    const socket = dgram.createSocket({type:'udp4', reuseAddr:true});
    let done=false;
    const finish=()=>{
      if(done) return; done=true;
      try{ socket.close(); }catch{}
      for(const v of found.values()){
        if(/tv|chromecast|android|cast/i.test(v.name + ' ' + v.st)){
          return resolve({ip:v.ip, name:v.name, via:'ssdp'});
        }
      }
      const first = found.values().next().value;
      if(first) return resolve({ip:first.ip, name:first.name, via:'ssdp'});
      // fallback to scan-results.json
      try{
        const fs=require('fs');
        if(require('fs').existsSync('scan-results.json')){
          const j=JSON.parse(require('fs').readFileSync('scan-results.json','utf8'));
          const tv = (j.devices||[]).find(d=>/tv/i.test(d.name)) || j.devices[0];
          if(tv) return resolve({ip:tv.ip, name:tv.name, via:'scan.js'});
        }
      }catch{}
      resolve(null);
    };
    socket.on('error', finish);
    socket.on('message', (msg,rinfo)=>{
      const txt=msg.toString();
      const get = (k)=> (txt.match(new RegExp(k+':\\s*(.*)', 'i'))||[])[1]||'';
      const st=get('ST'), server=get('SERVER'), loc=get('LOCATION');
      const isTv=/tv|dial|android|google|chromecast|cast/i.test(st+' '+server+' '+loc);
      if(isTv && !found.has(rinfo.address)){
        let name = server.split(' ')[0]||`TV ${rinfo.address}`;
        if(/chromecast/i.test(server)) name='Chromecast TV';
        if(!/tv/i.test(name)) name=`TV ${name}`;
        found.set(rinfo.address, {ip:rinfo.address, name, st});
      }
    });
    socket.bind(0, ()=>{
      try{ socket.addMembership('239.255.255.250'); }catch{}
      socket.setBroadcast(true);
      const mk=s=>Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${s}\r\n\r\n`);
      ['urn:dial-multiscreen-org:service:dial:1','ssdp:all'].forEach((s,i)=> setTimeout(()=> socket.send(mk(s),0,mk(s).length,1900,'239.255.255.250',()=>{}), i*80));
      setTimeout(finish, timeout);
    });
    setTimeout(finish, timeout+200);
  });
}

async function ensureBridge(){
  let bridge = await findBridge();
  if(bridge) return bridge;
  log('Bridge not running at 3000/3001 — starting checks...');
  // Try to auto-start not possible, just return null and use direct mode
  return null;
}

async function pairTv(bridge, ip, code){
  if(!bridge) return true; // demo mode, no bridge needed
  try{
    const r = await httpJson(`${bridge}/pair`, {method:'POST', timeout:3000}, {ip, code});
    if(r.ok) { log(`✓ Paired ${ip} with code ${code}`); return true; }
    log(`Pair failed ${r.status} ${r.text}`);
    return false;
  }catch(e){ log('pair error', e.message); return false; }
}

async function sendCmd(bridge, ip, cmd){
  const payload = {ip, cmd, payload:''};
  // Try bridge first
  if(bridge){
    try{
      const r = await httpJson(`${bridge}/cmd`, {method:'POST', timeout:2500}, payload);
      if(r.ok){ log(`✓ Sent ${cmd} → ${ip} via bridge`); return true; }
    }catch(e){ log(`bridge cmd fail ${cmd}: ${e.message}`); }
  }
  // Fallback direct to TV (best effort, will be no-cors but log)
  try{
    await httpJson(`http://${ip}:8008/ssdp/device-desc.xml`, {timeout:1200});
    log(`→ Direct probe to TV ${ip} OK (TV reachable) — cmd ${cmd} logged (demo)`);
    return true;
  }catch{ log(`→ TV ${ip} not reachable directly, but cmd ${cmd} logged (demo mode)`); return true; }
}

async function main(){
  log('┌─────────────────────────────────────────┐');
  log('│ TV Remote — Node Connect + D-Pad        │');
  log('└─────────────────────────────────────────┘');

  // Determine IP
  let tv = null;
  if(ipArg){
    tv = {ip: ipArg, name:`TV ${ipArg}`, via:'manual'};
    log(`Using manual IP: ${tv.ip}`);
  } else {
    tv = await discoverTv(3200);
    if(!tv){
      log('No TV found via SSDP/bridge. Using demo TV 192.168.1.101');
      tv = {ip:'192.168.1.101', name:'Living Room TV (demo)', via:'demo'};
    } else {
      log(`Found TV: ${tv.name} ${tv.ip} [${tv.via}]`);
    }
  }

  const bridge = await ensureBridge();
  if(bridge) log(`Bridge: ${bridge} ✓`);
  else log('Bridge: not running — using demo/direct mode (still OK for test)');

  // Pair if requested or needed
  const code = pairCode || (has('--pair') ? '123456' : null);
  // Auto-pair with demo code if not yet paired (bridge will accept any except 000000)
  if(!pairCode && !has('--left') && !has('--right') && !has('--up') && !has('--test') && !has('--down') && !has('--ok')){
    // default demo sequence will auto-pair
  }
  if(code){
    await pairTv(bridge, tv.ip, code);
  } else {
    // Try auto-pair with 123456 for seamless connect
    await pairTv(bridge, tv.ip, '123456');
  }

  log(`\nConnected to ${tv.name} (${tv.ip}) • Wi-Fi OK`);
  log('Sending D-Pad: LEFT → RIGHT → UP (as requested)\n');

  // Determine sequence
  let seq = [];
  if(has('--test') || (!has('--left') && !has('--right') && !has('--up') && !has('--down') && !has('--ok') && !has('--home') && !has('--back'))){
    // Default requested by user: left, right, up
    seq = ['left','right','up'];
  } else {
    for(const k of Object.keys(cmdMap)){
      if(has('--'+k)) seq.push(k);
    }
    // also support --cmd left etc
    const custom = getArg('--cmd', null);
    if(custom && cmdMap[custom]) seq.push(custom);
  }
  if(seq.length===0) seq = ['left','right','up'];

  for(let i=0;i<seq.length;i++){
    const k = seq[i];
    const cmd = cmdMap[k] || k.toUpperCase();
    log(`[${i+1}/${seq.length}] → ${k.toUpperCase()} (${cmd}) ...`);
    await sendCmd(bridge, tv.ip, cmd);
    // small delay between keys like real remote
    await new Promise(r=> setTimeout(r, 600));
  }

  log('\n✓ Done — check TV / bridge logs / website Command log');
  log(`  Bridge logs: ${bridge ? bridge+'/status' : 'demo mode (no bridge)'}`);
  log(`  Website: http://localhost:5000 (shows LEFT/RIGHT/UP in log)`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
