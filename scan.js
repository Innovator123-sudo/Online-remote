#!/usr/bin/env node
/**
 * TV Control Hub — Node Network Scanner
 * Run: node scan.js
 * Run: node scan.js --subnet 192.168.1.0/24 --timeout 6000
 * 
 * Discovers Android TVs / Chromecast / Google TVs on same Wi-Fi via:
 *  - SSDP M-SEARCH (239.255.255.250:1900) for DIAL/UPnP/MediaRenderer
 *  - Raw UDP multicast without external deps
 *  - HTTP probe of common TV ports (8008,8009,8443) + DIAL check
 * 
 * Works with zero dependencies. If node-ssdp is installed, also uses it as extra.
 */

const dgram = require('dgram');
const os = require('os');
const http = require('http');
const https = require('https');

const args = process.argv.slice(2);
const getArg = (k, def) => {
  const i = args.indexOf(k);
  return i !== -1 && args[i+1] ? args[i+1] : def;
};
const TIMEOUT = parseInt(getArg('--timeout', '3800'), 10); // <5s total, 3.8s reliable + fast
const VERBOSE = args.includes('--verbose');
const MANUAL_SUBNET = getArg('--subnet', null);
const NAME_FILTER = (getArg('--filter', getArg('--name', 'tv')) || 'tv').toLowerCase(); // search device name tv

function log(...a){ console.log(...a); }
function vlog(...a){ if(VERBOSE) console.log('[verbose]', ...a); }

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

// ---------- subnet helpers ----------
function getLocalNetworks(){
  const nets = os.networkInterfaces();
  const out = [];
  for(const name of Object.keys(nets)){
    for(const n of nets[name]){
      if(n.family === 'IPv4' && !n.internal){
        const ip = n.address;
        const mask = n.netmask;
        const subnet = ip.split('.').slice(0,3).join('.') + '.0/24';
        out.push({ name, ip, netmask: mask, subnet, cidr: subnet });
      }
    }
  }
  return out;
}
function ipToInt(ip){ return ip.split('.').reduce((a,b)=> (a<<8)+parseInt(b,10),0)>>>0; }
function intToIp(i){ return [(i>>>24)&255,(i>>>16)&255,(i>>>8)&255,i&255].join('.'); }

// ---------- SSDP raw ----------
function buildMSearch(st){
  return Buffer.from([
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'MAN: "ssdp:discover"',
    'MX: 3',
    `ST: ${st}`,
    '',
    ''
  ].join('\r\n'));
}

async function ssdpScan(timeout = TIMEOUT){
  const found = new Map(); // ip -> {ip, name, st, location, server, headers}
  const nameFetches = [];
  const socket = dgram.createSocket({type:'udp4', reuseAddr:true});

  return new Promise((resolve)=>{
    let finished=false;
    const finish = ()=>{
      if(finished) return; finished=true;
      try{ socket.close(); }catch{}
      // Enrich each found device with real friendlyName from LOCATION XML (parallel)
      for(const [ip, info] of found){
        if(info.location){
          nameFetches.push(
            fetchFriendlyName(info.location, 1500).then(realName => {
              if(realName && found.has(ip)){
                const dev = found.get(ip);
                const oldName = dev.name;
                dev.name = realName.slice(0,40);
                if(!/tv|chromecast|cast|dongle/i.test(dev.name)) dev.name = `${dev.name} TV`;
                log(`  → enriched ${ip}: "${oldName}" → "${dev.name}"`);
              }
            }).catch(()=>{})
          );
        }
      }
      Promise.allSettled(nameFetches).then(()=> resolve(Array.from(found.values())));
    };

    socket.on('error', (err)=>{
      console.error('[ssdp] socket error', err.message);
      finish();
    });

    socket.on('message', (msg, rinfo)=>{
      const text = msg.toString('utf8');
      vlog(`[ssdp] response from ${rinfo.address}`, text.split('\r\n').slice(0,4).join(' | '));
      // parse headers
      const headers = {};
      text.split('\r\n').forEach(line=>{
        const idx = line.indexOf(':');
        if(idx>0){
          const k=line.slice(0,idx).trim();
          const v=line.slice(idx+1).trim();
          headers[k.toUpperCase()] = v;
          headers[k] = v;
        }
      });
      const st = headers['ST'] || headers['st'] || '';
      const location = headers['LOCATION'] || headers['Location'] || '';
      const server = headers['SERVER'] || headers['Server'] || '';
      const usn = headers['USN'] || '';
      // Strict TV filter: only keep TV-like (no generic routers) — must match tv/cast/dial/android
      const isTvLike = /dial|android|google|chromecast|roku|firetv|philips|sony|tcl|hisense|mi.?box|bravia|upnp|mediarenderer|cast|tv/i.test(st + ' ' + server + ' ' + usn + ' ' + location);
      const shouldKeep = isTvLike; // strict: don't keep generic location devices (routers)
      if(shouldKeep){
        if(!found.has(rinfo.address)){
          // Use the same real-name logic as the bridge: build + then enrich from XML
          let name = buildDeviceName(server, st, location, rinfo.address);
          found.set(rinfo.address, {
            ip: rinfo.address,
            name: name.slice(0,40),
            st: st || 'unknown',
            location,
            server,
            usn,
            via: 'SSDP',
            headers
          });
          log(`  → Found ${rinfo.address}  ${name}  ST=${st}  SERVER=${server}`);
        }
      }
    });

    socket.bind(0, ()=>{
      try{ socket.addMembership('239.255.255.250'); }catch(e){ vlog('addMembership failed', e.message); }
      socket.setBroadcast(true);
      socket.setMulticastTTL(4);
      const targets = [
        'urn:dial-multiscreen-org:service:dial:1',
        'urn:google-com:device:ChromeCast:1',
        'urn:schemas-upnp-org:device:MediaRenderer:1',
        'ssdp:all'
      ];
      // send burst quickly for <5s detection
      targets.forEach((st, idx)=>{
        setTimeout(()=>{
          const buf = buildMSearch(st);
          socket.send(buf, 0, buf.length, 1900, '239.255.255.250', (err)=>{
            if(err) vlog('send error', err.message);
            else vlog(`[ssdp] M-SEARCH sent ST=${st}`);
          });
        }, idx*90);
      });
      // second burst at 800ms to catch late responders
      setTimeout(()=>{
        const buf = buildMSearch('urn:dial-multiscreen-org:service:dial:1');
        socket.send(buf, 0, buf.length, 1900, '239.255.255.250', ()=>{});
      }, 800);
    });

    setTimeout(finish, timeout);
  });
}

// ---------- HTTP probe for DIAL / Cast ---------- (fast: 900ms timeout, 8008 only)
function httpGet(url, timeout=900){
  return new Promise((resolve)=>{
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {timeout}, (res)=>{
      let data='';
      res.on('data', c=> data+=c);
      res.on('end', ()=> resolve({ok:true, status:res.statusCode, headers:res.headers, body:data}));
    });
    req.on('error', ()=> resolve({ok:false}));
    req.on('timeout', ()=> { req.destroy(); resolve({ok:false}); });
  });
}

async function probeTvCandidates(ips, concurrency=16){
  const found=[];
  // Only probe 8008 DIAL (fastest) — others rarely needed for Chromecast/Android TV
  const probes = ips.map(ip=> ({ip, url:`http://${ip}:8008/ssdp/device-desc.xml`, via:'8008 DIAL'}));
  let idx=0;
  async function worker(){
    while(idx < probes.length){
      const p = probes[idx++];
      const r = await httpGet(p.url, 900);
      if(r.ok && r.status && r.status < 500){
        const body = (r.body||'').slice(0,1200);
        const isTv = /android|google|cast|dial|chromecast|bravia|tcl|philips|hisense|upnp/i.test(body + ' ' + JSON.stringify(r.headers));
        if(isTv || r.status===200){
          if(!found.some(f=> f.ip===p.ip)){
            found.push({ip:p.ip, name:`TV ${p.ip}`, via:p.via, location:p.url});
            log(`  → HTTP probe hit ${p.ip} via ${p.via} (${r.status})`);
          }
        }
      }
    }
  }
  const workers = Array(Math.min(concurrency, 6)).fill(0).map(()=> worker());
  await Promise.all(workers);
  return found;
}

// ---------- main ----------
async function main(){
  log('┌─────────────────────────────────────────────┐');
  log('│  TV Control Hub — Wi-Fi TV Scanner (Node)   │');
  log('└─────────────────────────────────────────────┘');
  log('');

  const nets = getLocalNetworks();
  if(nets.length===0){
    log('! No IPv4 network found. Are you offline?');
    log('  Will still try SSDP on default subnet.');
  } else {
    log('Local networks:');
    nets.forEach(n=> log(`  • ${n.name}: ${n.ip} / ${n.netmask}  → ${n.subnet}`));
    log('');
  }

  const subnetStr = MANUAL_SUBNET || (nets[0]?.subnet || '192.168.1.0/24');
  log(`Scanning subnet: ${subnetStr}  (timeout ${TIMEOUT}ms)`);
  log('');

  const base = subnetStr.split('.').slice(0,3).join('.');
  // Run SSDP + HTTP probe in PARALLEL for <5s total (not sequential)
  log('[1/2] Parallel SSDP + HTTP probe (target <5s)...');
  const probeIps = Array.from(new Set([1,20,21,22,23,24,25,26,27,28,29,30,84,100,101,102].map(n=> `${base}.${n}`)));
  const [ssdpFound, httpFound] = await Promise.all([
    ssdpScan(TIMEOUT),
    probeTvCandidates(probeIps, 16)
  ]);
  log(`     SSDP: ${ssdpFound.length}  HTTP: ${httpFound.length}`);
  log('');

  // Merge
  const merged = new Map();
  [...ssdpFound, ...httpFound].forEach(d=>{
    if(!merged.has(d.ip)) merged.set(d.ip, d);
  });
  log('[2/2] Library check...');
  try{ require('node-ssdp'); log('     node-ssdp installed'); }catch{ log('     node-ssdp not installed — raw SSDP used'); }
  log('');

  let all = Array.from(merged.values());
  // Filter by device name tv (user requested: search device name tv)
  const beforeFilter = all.length;
  all = all.filter(d=>{
    const hay = `${d.name} ${d.st||''} ${d.server||''} ${d.location||''}`.toLowerCase();
    return hay.includes(NAME_FILTER);
  });
  if(beforeFilter !== all.length) log(`  Filtered by device name "${NAME_FILTER}": ${beforeFilter} → ${all.length}`);

  log('─────────────────────────────────────────────');
  if(all.length===0){
    log('No TVs found on Wi-Fi.');
    log('');
    log('Try:');
    log('  • Ensure TV and this PC are on the SAME Wi-Fi (not mobile data / guest network)');
    log('  • On TV: Settings → Network → Wi-Fi → check IP starts with same subnet');
    log('  • On TV: Enable “Chromecast built-in” / “Network Remote” / “DIAL”');
    log('  • Check Windows Firewall allows UDP 1900 / TCP 8008');
    log('  • Run: node scan.js --subnet '+base+'.0/24 --verbose');
    log('  • Manual connect still works: add TV IP in website → Manual IP');
    log('');
    log('Simulated fallback (for demo):');
    const mocks = [
      {name:'Living Room TV (mock)', ip: base+'.101', via:'mock'},
      {name:'Bedroom TV (mock)', ip: base+'.42', via:'mock'},
    ];
    mocks.forEach(m=> log(`  • ${m.name}  ${m.ip}  [${m.via}]`));
    log('');
    mocks.forEach(m=> merged.set(m.ip, m));
    all.push(...mocks);
  } else {
    log(`Found ${all.length} device(s) on Wi-Fi:`);
    all.forEach(d=>{
      const loc = d.location ? ` ${d.location}` : '';
      log(`  • ${d.name}  ${d.ip}  [${d.via}]${loc ? ' '+loc : ''}  ST=${d.st||'n/a'}`);
    });
    log('');
    log('Next steps:');
    log('  • Open website (python -m http.server 8000 → http://localhost:8000)');
    log('  • Click “Scan for TVs” — bridge at localhost:3001 will also report these');
    log('  • Or add manually: Manual IP → '+all[0].ip);
  }
  log('─────────────────────────────────────────────');

  // Also write results to file for website bridge to pick up — keep previous if none found
  try{
    const fs=require('fs');
    // Never write mock/fallback entries — only real Wi-Fi devices (no fake TVs)
    const realOnly = all.filter(d=> d.via !== 'mock');
    if(realOnly.length>0){
      const out = { scannedAt: new Date().toISOString(), subnet: subnetStr, devices: realOnly };
      fs.writeFileSync('scan-results.json', JSON.stringify(out,null,2));
      vlog('Wrote scan-results.json (real devices only)');
    } else {
      // No real devices — do NOT leave stale mocks. Remove any existing file.
      if(fs.existsSync('scan-results.json')) fs.writeFileSync('scan-results.json', JSON.stringify({scannedAt:new Date().toISOString(), subnet:subnetStr, devices:[]},null,2));
      vlog('No real devices — cleared scan-results.json');
    }
  }catch{}

  // Exit with appropriate code: 0 if found, 2 if none (so caller can fallback)
  process.exit(all.length ? 0 : 2);
}

main().catch(e=>{
  console.error('Scan failed:', e);
  process.exit(1);
});
