/**
 * Cloud Remote-protocol relay — drive the TV from anywhere with NO home
 * device on and NO TV settings touched.
 *
 * GET /api/remote?action=validate|cmd&key=...&host=<global IPv6>&cmd=...&payload=...
 *
 * How it works: the TV's Remote service (TCP 6466) needs no setup — but the
 * TV only trusts paired certificates. The cert from the one-time home
 * pairing lives in the REMOTE_CERT_JSON env var, so every call below
 * authenticates silently: no PIN, no prompt, no remote needed, ever.
 * Needs: TV with a global IPv6 reachable from the internet.
 */
'use strict';

const REMOTE_KEYS = {UP:19, DOWN:20, LEFT:21, RIGHT:22, OK:23, ENTER:23, BACK:4, HOME:3, MUTE:164, POWER:26};

let Lib = null;
function lib(){
  if(Lib) return Lib;
  const m = require('androidtv-remote');
  const AR = m.AndroidRemote || (m.default && m.default.AndroidRemote);
  const KC = m.RemoteKeyCode || (m.default && m.default.RemoteKeyCode);
  const DIR = m.RemoteDirection || (m.default && m.default.RemoteDirection);
  if(typeof AR !== 'function' || !KC || KC.KEYCODE_DPAD_UP !== 19) throw new Error('bad remote lib');
  Lib = {AndroidRemote:AR, SHORT:(DIR && DIR.SHORT) || 3};
  return Lib;
}
function envCert(){
  // 1) Explicit env var (preferred).
  try{
    const j = JSON.parse(process.env.REMOTE_CERT_JSON || '');
    if(j && j.key && j.cert) return {key:j.key, cert:j.cert};
  }catch{}
  // 2) Bundled cert deployed with the function (set up once, no dashboard).
  try{
    const path = require('path'), fs = require('fs');
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'remote-cert.json'), 'utf8'));
    if(j && j.key && j.cert) return {key:j.key, cert:j.cert};
  }catch{}
  return null;
}
function waitEvent(emitter, okEvents, failEvents, ms){
  return new Promise(resolve=>{
    const done = v=>{ cleanup(); resolve(v); };
    const onOk = ()=> done(true);
    const onFail = ()=> done(false);
    const timer = setTimeout(()=> done(false), ms);
    const cleanup = ()=>{
      clearTimeout(timer);
      (Array.isArray(okEvents) ? okEvents : [okEvents]).forEach(e=> emitter.removeListener(e, onOk));
      (Array.isArray(failEvents) ? failEvents : [failEvents]).forEach(e=> emitter.removeListener(e, onFail));
    };
    (Array.isArray(okEvents) ? okEvents : [okEvents]).forEach(e=> emitter.once(e, onOk));
    (Array.isArray(failEvents) ? failEvents : [failEvents]).forEach(e=> emitter.once(e, onFail));
  });
}
// One full session per call (serverless is stateless): connect → do → close.
async function withRemote(host, fn, ms=7000){
  const L = lib();
  const cert = envCert();
  if(!cert) throw new Error('no-cert');
  const remote = new L.AndroidRemote(host, {
    pairing_port:6467, remote_port:6466, name:'OnlineRemote', cert,
  });
  remote.on('error', ()=>{});
  remote.start().catch(()=>{});
  const ready = await waitEvent(remote, 'ready', ['unpaired', 'error'], ms);
  if(!ready){ drop(remote); throw new Error('unreachable'); }
  try{ return await fn(remote, L); }
  finally{ drop(remote); }
}
function drop(remote){
  try{
    if(remote && remote.remoteManager && remote.remoteManager.client){
      remote.remoteManager.client.removeAllListeners();
      remote.remoteManager.client.destroy();
    }
  }catch{}
}
function charToKeyCode(ch){
  const c = ch.charCodeAt(0);
  if(c >= 65 && c <= 90) return 29 + (c - 65);
  if(c >= 97 && c <= 122) return 29 + (c - 97);
  if(c >= 48 && c <= 57) return 7 + (c - 48);
  if(ch === ' ') return 62;
  return 0;
}

module.exports = async function handler(req, res){
  const q = req.query || {};
  const deny = (msg)=> res.status(200).json({ok:false, error:msg});
  if(!process.env.RELAY_KEY || q.key !== process.env.RELAY_KEY) return deny('bad key');
  const action = q.action || 'status';
  if(action === 'status'){
    let certOk = false;
    try{ certOk = !!envCert(); }catch{}
    return res.status(200).json({ok:true, relay:'remote', cert:certOk});
  }
  const host = String(q.host || '').trim().replace(/^\[|\]$/g, '');
  if(!host || /\s/.test(host)) return deny('bad host');
  if(!envCert()) return deny('no-cert (set REMOTE_CERT_JSON on Vercel)');

  if(action === 'validate'){
    try{
      await withRemote(host, async ()=> true, 7000);
      return res.status(200).json({ok:true, valid:true, via:'cloud-remote'});
    }catch(e){
      const m = String((e && e.message) || e);
      if(m === 'no-cert') return deny('no-cert (set REMOTE_CERT_JSON on Vercel)');
      return deny('unreachable');
    }
  }
  if(action === 'cmd'){
    const cmd = String(q.cmd || '').toUpperCase();
    const payload = String(q.payload || '');
    try{
      if(cmd === 'TEXT'){
        const codes = payload.split('').map(charToKeyCode).filter(n=> n > 0);
        if(!codes.length) return deny('bad command');
        await withRemote(host, async (remote, L)=>{
          for(const k of codes){ remote.sendKey(k, L.SHORT); await new Promise(r=> setTimeout(r, 40)); }
        }, 9000);
      } else {
        if(!REMOTE_KEYS[cmd]) return deny('bad command');
        await withRemote(host, async (remote, L)=>{ remote.sendKey(REMOTE_KEYS[cmd], L.SHORT); }, 8000);
      }
      return res.status(200).json({ok:true, sent:true});
    }catch(e){
      const m = String((e && e.message) || e);
      if(m === 'no-cert') return deny('no-cert (set REMOTE_CERT_JSON on Vercel)');
      return deny('send failed (TV asleep? Firewall blocking 6466?)');
    }
  }
  return deny('bad action');
};
