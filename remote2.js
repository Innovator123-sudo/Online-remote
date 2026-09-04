/**
 * remote2.js — Android TV Remote v2 transport (the real remote protocol).
 * No ADB, no developer mode: talks to the TV's Remote Service (TCP 6466/6467
 * with TLS), exactly like the Google TV phone app. The TV shows a pairing PIN
 * once; the cert is then saved under ./remote-certs/ and reused forever.
 *
 * Used ONLY by helper.js (persistent process — pairing spans HTTP calls).
 * Zero hard dep failure: if `androidtv-remote` isn't installed, every call
 * resolves {ok:false} and the helper falls back to ADB.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

const CERT_DIR = path.join(__dirname, 'remote-certs');
try{ fs.mkdirSync(CERT_DIR, {recursive:true}); }catch{}

let Lib = null, libTried = false;
function lib(){
  if(libTried) return Lib;
  libTried = true;
  try{
    const m = require('androidtv-remote');
    const AR = m.AndroidRemote || (m.default && m.default.AndroidRemote);
    const KC = m.RemoteKeyCode || (m.default && m.default.RemoteKeyCode);
    const DIR = m.RemoteDirection || (m.default && m.default.RemoteDirection);
    if(typeof AR === 'function' && KC && KC.KEYCODE_DPAD_UP === 19){
      Lib = {AndroidRemote:AR, KC, SHORT:(DIR && DIR.SHORT) || 3};
      console.log('[remote2] androidtv-remote available — TV-protocol control enabled');
    }
  }catch(e){ console.log('[remote2] androidtv-remote NOT installed (TV-protocol disabled): ' + (e.message || e)); }
  return Lib;
}
function available(){ return !!lib(); }

const REMOTE_KEYS = {UP:19, DOWN:20, LEFT:21, RIGHT:22, OK:23, BACK:4, HOME:3, MUTE:164, POWER:26};
function certPath(ip){ return path.join(CERT_DIR, String(ip).replace(/[^a-zA-Z0-9.-]/g, '_') + '.json'); }
function loadCert(ip){
  try{
    const j = JSON.parse(fs.readFileSync(certPath(ip), 'utf8'));
    if(j && j.key && j.cert) return {key:j.key, cert:j.cert};
  }catch{}
  return null;
}
function saveCert(ip, cert){
  try{ fs.writeFileSync(certPath(ip), JSON.stringify({key:cert.key, cert:cert.cert})); return true; }
  catch{ return false; }
}
function hasCert(ip){ return !!loadCert(ip); }

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
function newRemote(ip, cert){
  const L = lib();
  return new L.AndroidRemote(ip, {
    pairing_port:6467, remote_port:6466, name:'OnlineRemote', cert:cert || {},
  });
}
// Raw port probe — no lib instance, no leak. Used for validation.
function probeRemotePort(ip, ms=3000){
  return new Promise(resolve=>{
    let done = false;
    const fin = v=>{ if(!done){ done = true; try{ s.destroy(); }catch{} resolve(v); } };
    const s = new net.Socket();
    s.setTimeout(ms);
    s.on('connect', ()=> fin(true));
    s.on('timeout', ()=> fin(false));
    s.on('error', ()=> fin(false));
    try{ s.connect(6466, ip); }catch{ fin(false); }
  });
}
async function validateRemote(ip){
  if(!lib()) return {ok:false};
  if(!hasCert(ip)){
    const alive = await probeRemotePort(ip, 2500);
    return {ok:false, needPair:alive};
  }
  const alive = await probeRemotePort(ip, 3000);
  if(!alive) return {ok:false};
  return {ok:true};
}

// ---------- pairing (stateful across HTTP calls — helper only) ----------
const pending = new Map(); // ip -> {remote, secretSeen, finished}
function pairStatus(ip){
  return {pairing:pending.has(ip), paired:hasCert(ip)};
}
function pairBegin(ip){
  if(!lib()) return {ok:false, error:'tv-protocol not installed (npm i androidtv-remote)'};
  if(hasCert(ip)) return {ok:true, alreadyPaired:true};
  const prev = pending.get(ip);
  if(prev && prev.finished){ try{ pending.delete(ip); }catch{} }
  else if(prev) return {ok:true, pairing:true};
  let remote;
  try{ remote = newRemote(ip, null); }
  catch(e){ return {ok:false, error:String((e && e.message) || e)}; }
  const rec = {remote, secretSeen:false, finished:false};
  pending.set(ip, rec);
  remote.on('secret', ()=>{ rec.secretSeen = true; });
  remote.on('error', ()=>{});
  // Run in background: pairing completes when the code is submitted via pairCode().
  // Swallow the terminal rejection (pairCode reports the outcome); always cleanup.
  remote.start().then(()=>{ rec.finished = true; }).catch(()=>{ rec.finished = true; });
  return {ok:true, pairing:true};
}
async function pairCode(ip, code){
  if(!lib()) return {ok:false, error:'tv-protocol not installed'};
  if(!/^\d{4,8}$/.test(String(code || ''))) return {ok:false, error:'code is the digits shown on the TV'};
  const rec = pending.get(ip);
  if(!rec) return {ok:false, error:'no pairing in progress — start pairing first'};
  let accepted = false;
  try{ accepted = rec.remote.sendCode(String(code)); }
  catch(e){ accepted = false; }
  if(!accepted){
    try{ pending.delete(ip); }catch{}
    return {ok:false, error:'wrong code — start pairing again for a fresh PIN'};
  }
  const ok = await waitEvent(rec.remote, 'ready', ['unpaired', 'error'], 15000);
  try{ pending.delete(ip); }catch{}
  if(!ok) return {ok:false, error:'pair timed out — retry with a fresh PIN'};
  try{ saveCert(ip, rec.remote.getCertificate()); }catch{}
  return {ok:true, paired:true};
}

// ---------- commands (one persistent session per TV) ----------
const sessions = new Map(); // ip -> remote (ready)
function sessionAlive(r){
  try{
    const c = r && r.remoteManager && r.remoteManager.client;
    return !!(c && !c.destroyed && !c.closed && c.writable);
  }catch{ return false; }
}
async function ensureSession(ip, ms=8000){
  if(!lib()) throw new Error('tv-protocol not installed');
  const cur = sessions.get(ip);
  if(cur){
    if(sessionAlive(cur)) return cur;
    dropSession(ip);
  }
  const cert = loadCert(ip);
  if(!cert) throw new Error('need-pair');
  const remote = newRemote(ip, cert);
  remote.on('error', ()=>{});
  // NOTE: remote.start() resolves at TLS secureConnect, but 'ready' fires
  // later after the configure handshake. Never race the two — start in the
  // background and wait for the 'ready' event with a timeout.
  remote.start().catch(()=>{});
  const ready = await waitEvent(remote, 'ready', ['unpaired', 'error'], ms);
  if(!ready){
    try{ if(remote.remoteManager && remote.remoteManager.client){ remote.remoteManager.client.removeAllListeners(); remote.remoteManager.client.destroy(); } }catch{}
    throw new Error('unreachable');
  }
  sessions.set(ip, remote);
  return remote;
}
function dropSession(ip){
  const cur = sessions.get(ip);
  sessions.delete(ip);
  try{
    if(cur && cur.remoteManager && cur.remoteManager.client){
      cur.remoteManager.client.removeAllListeners();
      cur.remoteManager.client.destroy();
    }
  }catch{}
}
async function sendRemoteKey(ip, keyCode){
  const remote = await ensureSession(ip);
  remote.sendKey(keyCode, (lib().SHORT) || 3);
  return true;
}
function charToKeyCode(ch){
  const c = ch.charCodeAt(0);
  if(c >= 65 && c <= 90) return 29 + (c - 65);   // A-Z
  if(c >= 97 && c <= 122) return 29 + (c - 97);  // a-z
  if(c >= 48 && c <= 57) return 7 + (c - 48);    // 0-9
  if(ch === ' ') return 62;
  return 0;
}
async function sendRemoteText(ip, text){
  const codes = String(text || '').split('').map(charToKeyCode).filter(n=> n > 0);
  if(!codes.length) return false;
  const remote = await ensureSession(ip);
  const SHORT = (lib().SHORT) || 3;
  for(const k of codes){
    remote.sendKey(k, SHORT);
    await new Promise(r=> setTimeout(r, 40));
  }
  return true;
}

module.exports = {
  available, REMOTE_KEYS,
  hasCert, pairStatus, pairBegin, pairCode,
  probeRemotePort, validateRemote,
  ensureSession, dropSession, sendRemoteKey, sendRemoteText,
};
