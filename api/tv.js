/**
 * Cloud ADB relay — lets the hosted page drive a TV with NO localhost/helper.
 * GET /api/tv?action=version|validate|cmd&key=...&host=...&port=...&cmd=...&payload=...
 *
 * How it reaches the TV: the TV must be addressable from the internet —
 * router port-forward (publicIP:port → TV:5555) or a global IPv6 address,
 * with Network/USB debugging ON (accept the on-TV prompt once per key).
 * RFC1918/loopback targets are rejected here (they can never work from cloud;
 * the page auto-uses the LAN helper for those instead).
 */
const {execFile} = require('child_process');
const path = require('path');
const fs = require('fs');

const ADB = path.join(__dirname, 'bin', 'adb');
const ADB_HOME = '/tmp/adb-home';
try{ fs.mkdirSync(ADB_HOME, {recursive:true}); }catch{}
const ADB_ENV = {...process.env, HOME:ADB_HOME, ANDROID_ADB_SERVER_PORT:'5037'};

const KEYEVENT = {UP:19, DOWN:20, LEFT:21, RIGHT:22, OK:23, BACK:4, HOME:3, MUTE:164, POWER:26};

function send(obj, code=200){
  return {statusCode:code, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body:JSON.stringify(obj)};
}
function run(args, ms){
  return new Promise(resolve=>{
    execFile(ADB, args, {timeout:ms, env:ADB_ENV, maxBuffer:1024*1024}, (err, stdout)=>{
      resolve({err, out:String(stdout || '').trim()});
    });
  });
}
function validHost(h){
  if(!h || h.length > 253) return false;
  if(/^\d{1,3}(\.\d{1,3}){3}$/.test(h)){
    const o = h.split('.').map(Number);
    if(o.some(n=> n < 0 || n > 255)) return false;
    if(o[0] === 10) return false;                                    // CGNAT/private
    if(o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
    if(o[0] === 192 && o[1] === 168) return false;
    if(o[0] === 127 || o[0] === 0) return false;
    if(o[0] === 169 && o[1] === 254) return false;
    if(o[0] >= 224) return false;                                    // multicast/reserved
    return true;
  }
  if(/^[0-9a-fA-F:]+$/.test(h) && h.includes(':')){
    const low = h.toLowerCase();
    if(low === '::1' || low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return false;
    return true;                                                     // global IPv6
  }
  return /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(h);   // public hostname (DDNS)
}

module.exports = async function handler(req, res){
  const q = req.query || {};
  const deny = (msg)=> res.status(200).json({ok:false, error:msg});
  if(!process.env.RELAY_KEY || q.key !== process.env.RELAY_KEY) return deny('bad key');
  const action = q.action || 'status';

  if(action === 'status') return res.status(200).json({ok:true, relay:true});
  if(action === 'version'){
    const r = await run(['version'], 5000);
    return res.status(200).json(r.err ? {ok:false, error:'adb unavailable'} : {ok:true, version:r.out.split('\n')[0]});
  }

  const host = String(q.host || '').trim();
  const port = Math.max(1, Math.min(65535, parseInt(q.port || '5555', 10) || 5555));
  if(!validHost(host)) return deny('not a public address (home IPs use the LAN helper)');
  const target = `${host}:${port}`;

  if(action === 'validate'){
    const c = await run(['connect', target], 3500);
    if(c.err && !/already connected|connected/i.test(c.out)) return deny('unreachable');
    const t = await run(['-s', target, 'shell', 'echo', 'ok'], 5000);
    if(t.err) return deny('no adb answer (dep debugging on? prompt accepted?)');
    const m = await run(['-s', target, 'shell', 'getprop', 'ro.product.model'], 4000);
    return res.status(200).json({ok:true, valid:true, model:(m.out || '').slice(0,40) || undefined});
  }

  if(action === 'cmd'){
    const cmd = String(q.cmd || '').toUpperCase();
    const payload = String(q.payload || '');
    let args = null;
    if(cmd === 'TEXT') args = ['-s', target, 'shell', 'input', 'text', payload.replace(/ /g, '%s')];
    else if(KEYEVENT[cmd]) args = ['-s', target, 'shell', 'input', 'keyevent', String(KEYEVENT[cmd])];
    else return deny('bad command');
    await run(['connect', target], 3000);
    const r = await run(args, 5000);
    if(r.err) return deny('send failed (TV asleep? prompt accepted?)');
    return res.status(200).json({ok:true, sent:true});
  }

  return deny('bad action');
};
