/**
 * Online Remote — optional home helper (zero dependencies).
 * The site works without it for Chromecast (direct Cast SDK).
 * Run it on ANY home-Wi-Fi machine for FULL control of Android TVs
 * (arrows + OK + typing over ADB) plus real network discovery:
 *
 *   node helper.js   →   http://localhost:5000  (+ 📱 LAN URL printed)
 *
 * Phones on the same Wi-Fi open EITHER the cloud URL (auto-finds this
 * helper if the IP was saved once) or the printed LAN URL (zero setup).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const remote2 = require('./remote2'); // Android TV Remote v2 (real remote protocol)

const PORT = parseInt(process.env.PORT, 10) || 5000;
let discovered = [];

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
function dialGet(ip, reqPath, ms=2000){
  return new Promise(resolve=>{
    try{
      const r = http.request({host:ip, port:8008, path:reqPath, method:'GET', timeout:ms}, rs=>{
        let d = ''; rs.on('data', c=> d += c);
        rs.on('end', ()=> resolve({status:rs.statusCode || 0, body:d}));
      });
      r.on('error', ()=> resolve(null));
      r.on('timeout', ()=>{ try{ r.destroy(); }catch{}; resolve(null); });
      r.end();
    }catch{ resolve(null); }
  });
}
function dialQuit(ip){
  const apps = ['YouTube', 'Netflix', 'Spotify', 'Hulu', 'Disney+', 'Twitch'];
  return (async()=>{
    for(const a of apps.slice(0, 4)){
      const s = await dialGet(ip, '/apps/' + encodeURIComponent(a), 1500);
      if(s === null) return false; // host unreachable — report failure, not success
      if(s.status === 200 && /<state>\s*running\s*<\/state>/i.test(s.body || '')){
        await new Promise(res=>{
          try{
            const r = http.request({host:ip, port:8008, path:'/apps/' + encodeURIComponent(a), method:'DELETE', timeout:2000}, ()=> res(true));
            r.on('error', ()=> res(false)); r.end();
          }catch{ res(false); }
        });
        return true;
      }
    }
    return true;
  })();
}

// ---------- ADB (system adb or ./platform-tools) ----------
function findAdb(){
  const cands = [
    path.join(__dirname, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'),
    'adb',
  ];
  for(const c of cands){ try{ if(c === 'adb' || fs.existsSync(c)) return c; }catch{} }
  return 'adb';
}
const KEYEVENT = {UP:19, DOWN:20, LEFT:21, RIGHT:22, OK:23, BACK:4, HOME:3, MUTE:164, POWER:26};
function adb(ip, args, ms=8000){
  return new Promise(resolve=>{
    try{
      const {execFile} = require('child_process');
      execFile(findAdb(), ['-s', `${ip}:5555`].concat(args), {timeout:ms}, err=>{
        if(!err) return resolve(true);
        execFile(findAdb(), ['connect', `${ip}:5555`], {timeout:4000}, ()=>{
          setTimeout(()=>{
            execFile(findAdb(), ['-s', `${ip}:5555`].concat(args), {timeout:ms}, err2=> resolve(!err2));
          }, 400);
        });
      });
    }catch{ resolve(false); }
  });
}
async function adbCmd(ip, cmd, payload){
  if(cmd === 'TEXT'){
    const safe = String(payload || '').replace(/ /g, '%s');
    return adb(ip, ['shell', 'input', 'text', safe]);
  }
  if(!(cmd in KEYEVENT)) return false;
  return adb(ip, ['shell', 'input', 'keyevent', String(KEYEVENT[cmd])]);
}

// ---------- transport orchestration ----------
const viaCache = new Map();
async function validateIp(ip){
  const [adbOk, dial, rem] = await Promise.all([
    adb(ip, ['shell', 'echo', 'ok'], 6000).catch(()=> false),
    dialGet(ip, '/ssdp/device-desc.xml', 2500),
    remote2.validateRemote(ip).catch(()=> ({ok:false})),
  ]);
  let name = '';
  if(dial && dial.body){
    const fn = (dial.body.match(/<friendlyName[^>]*>([^<]+)<\/friendlyName>/i) || [])[1];
    if(fn) name = fn.trim().slice(0, 40);
  }
  if(adbOk){ viaCache.set(ip, 'adb'); return {valid:true, via:'adb', name}; }
  if(rem && rem.ok){ viaCache.set(ip, 'remote'); return {valid:true, via:'remote', name}; }
  if(dial && dial.status === 200){ viaCache.set(ip, 'dial'); return {valid:true, via:'dial', name}; }
  if(dial && dial.body){ viaCache.set(ip, 'dial'); return {valid:true, via:'dial', name}; }
  if(rem && rem.needPair) return {valid:false, needPair:true};
  return {valid:false};
}
async function runCmd(ip, cmd, payload){
  const via = viaCache.get(ip);
  const order = via ? [via, ...['adb', 'remote', 'dial'].filter(v=> v !== via)] : ['adb', 'remote', 'dial'];
  for(const t of order){
    if(t === 'adb'){
      const ok = await Promise.race([adbCmd(ip, cmd, payload), new Promise(r=> setTimeout(()=> r(false), 12000))]);
      if(ok){ viaCache.set(ip, 'adb'); return {ok:true, via:'adb'}; }
    } else if(t === 'remote'){
      try{
        const send = cmd === 'TEXT'
          ? remote2.sendRemoteText(ip, payload)
          : ((cmd in remote2.REMOTE_KEYS) ? remote2.sendRemoteKey(ip, remote2.REMOTE_KEYS[cmd]) : Promise.resolve(false));
        const ok = await Promise.race([send, new Promise(r=> setTimeout(()=> r(false), 12000))]);
        if(ok){ viaCache.set(ip, 'remote'); return {ok:true, via:'remote'}; }
        if(!(cmd in remote2.REMOTE_KEYS) && cmd !== 'TEXT') return {ok:false, via:'remote', error:'unsupported'};
      }catch(e){
        if(String((e && e.message) || e) === 'need-pair') return {ok:false, via:'remote', error:'need-pair'};
        try{ remote2.dropSession(ip); }catch{}
      }
    } else {
      if(cmd === 'HOME' || cmd === 'BACK' || cmd === 'POWER'){
        const ok = await dialQuit(ip);
        if(ok){ viaCache.set(ip, 'dial'); return {ok:true, via:'dial'}; }
        return {ok:false, via:'dial', error:'unreachable'};
      }
      return {ok:false, via:'dial', error:'diallimited'};
    }
  }
  return {ok:false, error:'unreachable'};
}

// ---------- SSDP discovery ----------
function ssdpScan(timeout=2200){
  return new Promise(resolve=>{
    const dgram = require('dgram');
    const found = new Map();
    const sock = dgram.createSocket({type:'udp4', reuseAddr:true});
    let done = false;
    const finish = ()=>{
      if(done) return; done = true;
      try{ sock.close(); }catch{}
      for(const [ip, info] of found){
        if(!discovered.some(d=> d.ip === ip)) discovered.push(info);
      }
      resolve();
    };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo)=>{
      const text = msg.toString('utf8');
      const H = {};
      text.split('\r\n').forEach(line=>{
        const i = line.indexOf(':');
        if(i > 0) H[line.slice(0, i).trim().toUpperCase()] = line.slice(i+1).trim();
      });
      const hay = `${H.ST || ''} ${H.SERVER || ''} ${H.LOCATION || ''}`;
      if(/dial|android|chromecast|cast|roku|firetv|bravia|upnp|mediarenderer|tv/i.test(hay) && !found.has(rinfo.address)){
        let name = 'TV';
        const srv = `${H.SERVER || ''} ${H.ST || ''}`;
        if(/chromecast|google/i.test(srv)) name = 'Chromecast';
        else if(/android/i.test(srv)) name = 'Android TV';
        else if(/roku/i.test(srv)) name = 'Roku TV';
        else if(/bravia|sony/i.test(srv)) name = 'Sony TV';
        found.set(rinfo.address, {name, ip:rinfo.address, model:H.ST || 'TV'});
      }
    });
    sock.bind(0, ()=>{
      try{ sock.addMembership('239.255.255.250'); }catch{}
      sock.setBroadcast(true);
      const mk = st=> Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
      ['urn:dial-multiscreen-org:service:dial:1', 'ssdp:all'].forEach((st, i)=>
        setTimeout(()=> sock.send(mk(st), 0, mk(st).length, 1900, '239.255.255.250', ()=>{}), i*100));
    });
    setTimeout(finish, timeout);
  });
}

// ---------- server ----------
const MIME = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon'};
const server = http.createServer((req, res)=>{
  pna(res, req);
  if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if(p === '/status'){ return json(res, {ok:true, bridge:true, tvs:discovered}); }
  if(p === '/scan'){ ssdpScan().then(()=> json(res, {tvs:discovered})); return; }
  if(p === '/validate'){
    const ip = parsed.query.ip || '';
    res.writeHead(200, {'Content-Type':'application/json'});
    if(!ip) return res.end(JSON.stringify({ok:false, valid:false}));
    validateIp(ip).then(v=>{
      console.log(`[validate] ${ip} → ${v.valid ? v.via : 'invalid'}`);
      res.end(JSON.stringify({ok:true, valid:v.valid, via:v.via, name:v.name}));
    }).catch(()=> res.end(JSON.stringify({ok:true, valid:false})));
    return;
  }
  if(p === '/cmd'){
    let body = '';
    req.on('data', c=> body += c);
    req.on('end', ()=>{
      try{ body = JSON.parse(body || '{}'); }catch{ body = {}; }
      if(!body.ip) return json(res, {ok:false, error:'no ip'}, 400);
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
      if(p === '/remote-status') return json(res, {ok:true, ...remote2.pairStatus(ip)});
      if(p === '/remote-pair'){
        const r = remote2.pairBegin(ip);
        console.log(`[remote-pair] ${ip} → ${r.ok ? (r.alreadyPaired ? 'already paired' : 'PIN requested') : r.error}`);
        return json(res, r);
      }
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
});

server.listen(PORT, ()=>{
  let lan = '';
  try{
    const nets = require('os').networkInterfaces();
    for(const n of Object.keys(nets)){
      for(const a of nets[n] || []){
        if(a.family === 'IPv4' && !a.internal && /^(192\.168\.|10\.|172\.)/.test(a.address)){ lan = a.address; break; }
      }
      if(lan) break;
    }
  }catch{}
  console.log(`\n✅ Online Remote helper at http://localhost:${PORT}/`);
  if(lan) console.log(`   📱 Same Wi-Fi phones:  http://${lan}:${PORT}/`);
  console.log('');
});
