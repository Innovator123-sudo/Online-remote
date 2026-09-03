/**
 * cast-transport.js — shared TV transport layer: ADB (via caller) + Chromecast Cast v2 + DIAL.
 * Required by server.js (repo root) and bridge/server.js.
 *
 * Zero hard dependencies: castv2-client is lazy-loaded from bridge/node_modules
 * when present. Every external call is timeout-bounded and never throws —
 * failures resolve to {ok:false} / null so a dead TV can never hang /cmd.
 */
'use strict';

const http = require('http');
const path = require('path');

const deviceVia = new Map(); // ip -> 'adb' | 'cast' | 'dial' (learned, reused)
function setDeviceVia(ip, via){ if(ip && via) deviceVia.set(ip, via); }
function getDeviceVia(ip){ return deviceVia.get(ip) || null; }

// ---------- tiny helpers ----------
function safeTimeout(promise, ms, fallback = null){
  return Promise.race([
    Promise.resolve(promise).catch(()=> fallback),
    new Promise(res=> setTimeout(()=> res(fallback), ms)),
  ]);
}
const clamp = (v,a,b)=> Math.max(a, Math.min(b, v));

// ---------- optional castv2-client ----------
let _castLib = null, _castTried = false;
function getCastLib(){
  if(_castTried) return _castLib;
  _castTried = true;
  const tries = [path.join(__dirname, 'bridge', 'node_modules', 'castv2-client'), 'castv2-client'];
  for(const p of tries){
    try{
      const c = require(p);
      if(c && c.Client){ _castLib = c; break; }
    }catch{}
  }
  console.log(`[transport] castv2-client ${ _castLib ? 'available — Chromecast control enabled' : 'NOT found — Chromecast control disabled (run: cd bridge && npm install)' }`);
  return _castLib;
}
function castAvailable(){ return !!getCastLib(); }

// Run fn(client) with a connected Cast client; always closes. Resolves null on any failure.
function withCastClient(ip, fn, timeoutMs = 6000){
  return new Promise((resolve)=>{
    const lib = getCastLib();
    if(!lib) return resolve(null);
    let done = false;
    let client = null;
    const finish = (v)=>{
      if(done) return; done = true;
      clearTimeout(timer);
      try{ client && client.close(); }catch{}
      resolve(v);
    };
    const timer = setTimeout(()=> finish(null), timeoutMs);
    try{
      client = new lib.Client();
      client.on('error', ()=> finish(null));
      client.connect(ip, ()=>{
        if(done) return;
        Promise.resolve()
          .then(()=> fn(client))
          .then(v=> finish(v === undefined ? true : v))
          .catch(()=> finish(null));
      });
    }catch{ finish(null); }
  });
}
function castGetStatusP(client){
  return new Promise((res)=>{
    try{ client.getStatus((err, status)=> res(err ? null : (status || null))); }
    catch{ res(null); }
  });
}
function parseReceiverStatus(status){
  if(!status) return null;
  const vol = status.volume || {};
  const apps = Array.isArray(status.applications) ? status.applications
    : (status.applications ? Object.values(status.applications) : []);
  return {
    level: (typeof vol.level === 'number') ? vol.level : null,
    muted: !!vol.muted,
    app: apps[0] || null, // {appId, displayName, sessionId, transportId, ...}
  };
}
async function castReceiverStatus(ip, timeoutMs = 5000){
  const raw = await withCastClient(ip, c=> castGetStatusP(c), timeoutMs);
  return parseReceiverStatus(raw);
}
async function castSetVolume(ip, patch){
  // patch: {level:0..1} or {muted:bool}
  return !!(await withCastClient(ip, (c)=> new Promise((res)=>{
    try{
      if(typeof c.setVolume !== 'function') return res(false);
      c.setVolume(patch, (err)=> res(!err));
    }catch{ res(false); }
  }), 6000));
}
async function castVolumeDelta(ip, delta){
  const st = await castReceiverStatus(ip, 5000);
  if(!st || st.level === null) return false;
  if(st.muted && delta !== 0){
    // Unmute first so Vol+/− is heard, then set level
    await castSetVolume(ip, {muted:false});
  }
  return castSetVolume(ip, {level: clamp(Math.round((st.level + delta) * 100) / 100, 0, 1)});
}
async function castMuteToggle(ip){
  const st = await castReceiverStatus(ip, 5000);
  if(!st) return false;
  return castSetVolume(ip, {muted: !st.muted});
}
async function castMedia(ip, action){
  // action: 'toggle' | 'play' | 'pause' | 'stop'
  const lib = getCastLib();
  if(!lib || !lib.DefaultMediaReceiver) return false;
  const st = await castReceiverStatus(ip, 5000);
  const app = st && st.app;
  if(!app || !app.transportId) return false; // nothing on screen to control
  return !!(await withCastClient(ip, (c)=> new Promise((res)=>{
    try{
      c.join(app, lib.DefaultMediaReceiver, (err, player)=>{
        if(err || !player) return res(false);
        const afterJoin = (cb)=>{ try{ cb(); }catch{ res(false); } };
        if(action === 'stop') return afterJoin(()=> player.stop(()=> res(true)));
        if(action === 'play') return afterJoin(()=> player.play(()=> res(true)));
        if(action === 'pause') return afterJoin(()=> player.pause(()=> res(true)));
        // toggle: read state first
        try{
          player.getStatus((e2, ms)=>{
            const state = ms && ms.playerState;
            afterJoin(()=>{
              if(state === 'PLAYING' || state === 'BUFFERING') player.pause(()=> res(true));
              else player.play(()=> res(true));
            });
          });
        }catch{ res(false); }
      });
    }catch{ res(false); }
  }), 9000));
}
async function castQuit(ip){
  // Quit current app back to the Chromecast backdrop (≈ Home)
  const st = await castReceiverStatus(ip, 5000);
  const app = st && st.app;
  if(!app) return true; // already on backdrop
  const stopped = await castMedia(ip, 'stop');
  if(stopped) return true;
  return !!(await withCastClient(ip, (c)=> new Promise((res)=>{
    try{
      if(typeof c.stop !== 'function') return res(false);
      c.stop(app.sessionId || app.transportId, ()=> res(true));
    }catch{ res(false); }
  }), 6000));
}

// ---------- DIAL (http://TV:8008) — launch / quit apps, device info ----------
function dialRequest(ip, method, reqPath, timeoutMs = 2500){
  return new Promise((resolve)=>{
    try{
      const req = http.request({host: ip, port: 8008, path: reqPath, method, timeout: timeoutMs}, (rs)=>{
        let d = '';
        rs.on('data', c=> d += c);
        rs.on('end', ()=> resolve({status: rs.statusCode || 0, body: d}));
      });
      req.on('error', ()=> resolve(null));
      req.on('timeout', ()=>{ try{ req.destroy(); }catch{}; resolve(null); });
      req.end();
    }catch{ resolve(null); }
  });
}
const DIAL_APPS = ['YouTube', 'Netflix', 'Spotify', 'Hulu', 'Disney+', 'Twitch', 'Plex'];
async function dialRunningApp(ip){
  for(const app of DIAL_APPS.slice(0, 5)){
    const r = await dialRequest(ip, 'GET', `/apps/${encodeURIComponent(app)}`, 1500);
    if(r && r.status === 200 && /<state>\s*running\s*<\/state>/i.test(r.body || '')) return app;
    if(r === null) break; // host unreachable — stop probing
  }
  return null;
}
async function dialDeviceInfo(ip){
  const r = await dialRequest(ip, 'GET', '/ssdp/device-desc.xml', 2500);
  if(!r || !r.status || r.status >= 500 || !r.body) return null;
  const fn = (r.body.match(/<friendlyName[^>]*>([^<]+)<\/friendlyName>/i) || [])[1] || '';
  const model = (r.body.match(/<modelName[^>]*>([^<]+)<\/modelName>/i) || [])[1] || '';
  if(!fn && !model && r.status !== 200) return null;
  const eureka = await dialRequest(ip, 'GET', '/setup/eureka_info?params=name,model_name', 2000);
  let castName = '';
  try{ const j = JSON.parse((eureka && eureka.body) || ''); if(j && j.name) castName = String(j.name).trim(); }catch{}
  return {name: (castName || fn || model || '').slice(0, 40), model: (model || '').slice(0, 40)};
}
async function dialQuitCurrent(ip){
  const app = await dialRunningApp(ip);
  if(!app) return true; // nothing running
  const r = await dialRequest(ip, 'DELETE', `/apps/${encodeURIComponent(app)}`, 2500);
  return !!(r && (r.status === 200 || r.status === 202 || r.status === 404));
}

// ---------- orchestration ----------
async function validateTransport(ip, adbProbe){
  // Parallel race: ADB (full D-Pad) > Cast (media keys) > DIAL (app quit only).
  const adbP = (async()=>{ try{ return !!(await safeTimeout(adbProbe(), 7000, false)); }catch{ return false; } })();
  const castP = (async()=>{ try{ return await safeTimeout(castReceiverStatus(ip, 5000), 6000, null); }catch{ return null; } })();
  const dialP = (async()=>{ try{ return await safeTimeout(dialDeviceInfo(ip), 5000, null); }catch{ return null; } })();
  const [adbOk, castSt, dialInfo] = await Promise.all([adbP, castP, dialP]);
  const name = (dialInfo && dialInfo.name) || '';
  if(adbOk){ setDeviceVia(ip, 'adb'); return {valid: true, via: 'adb', name}; }
  if(castSt){ setDeviceVia(ip, 'cast'); return {valid: true, via: 'cast', name}; }
  if(dialInfo){ setDeviceVia(ip, 'dial'); return {valid: true, via: 'dial', name}; }
  return {valid: false, via: null, name};
}

async function castCommand(ip, cmd){
  switch(cmd){
    case 'VOLUME_UP': return {ok: await castVolumeDelta(ip, 0.05), via: 'cast'};
    case 'VOLUME_DOWN': return {ok: await castVolumeDelta(ip, -0.05), via: 'cast'};
    case 'MUTE': return {ok: await castMuteToggle(ip), via: 'cast'};
    case 'DPAD_CENTER':
    case 'ENTER': return {ok: await castMedia(ip, 'toggle'), via: 'cast'};
    case 'HOME':
    case 'POWER': return {ok: await castQuit(ip), via: 'cast'};
    case 'BACK': {
      const stopped = await castMedia(ip, 'stop');
      return {ok: stopped || await castQuit(ip), via: 'cast'};
    }
    case 'DPAD_UP': case 'DPAD_DOWN': case 'DPAD_LEFT': case 'DPAD_RIGHT':
      return {ok: false, via: 'cast', error: 'cast-nodpad'};
    default:
      return {ok: false, via: 'cast', error: 'cast-unsupported'};
  }
}
async function dialCommand(ip, cmd){
  switch(cmd){
    case 'HOME': case 'BACK': case 'POWER':
      return {ok: await dialQuitCurrent(ip), via: 'dial'};
    default:
      return {ok: false, via: 'dial', error: 'dial-limited'};
  }
}

// ctx: {adbSend: async(cmd,payload)=>bool, viaHint?: 'adb'|'cast'|'dial'}
async function sendTransportCommand(ip, cmd, payload, ctx = {}){
  const adbSend = ctx.adbSend || (async ()=> false);
  const hint = ctx.viaHint || getDeviceVia(ip);
  const order = hint ? [hint, ...['adb', 'cast', 'dial'].filter(v=> v !== hint)] : ['adb', 'cast', 'dial'];
  let lastError = 'unreachable';
  for(const t of order){
    try{
      if(t === 'adb'){
        const ok = await safeTimeout(adbSend(cmd, payload || ''), 12000, false);
        if(ok){ setDeviceVia(ip, 'adb'); return {ok: true, via: 'adb'}; }
        lastError = 'adb-failed';
      } else if(t === 'cast'){
        if(!castAvailable()){ lastError = 'cast-missing'; continue; }
        const r = await safeTimeout(castCommand(ip, cmd), 11000, null);
        if(r && r.ok){ setDeviceVia(ip, 'cast'); return r; }
        if(r && (r.error === 'cast-nodpad' || r.error === 'cast-unsupported')){
          lastError = r.error; break; // transport works, command meaningless — don't fall through
        }
        lastError = (r && r.error) || 'cast-failed';
      } else if(t === 'dial'){
        const r = await safeTimeout(dialCommand(ip, cmd), 8000, null);
        if(r && r.ok){ setDeviceVia(ip, 'dial'); return r; }
        lastError = (r && r.error) || 'dial-failed';
        if(lastError === 'dial-limited') break;
      }
    }catch(e){ lastError = (e && e.message) || 'error'; }
  }
  return {ok: false, via: hint, error: lastError};
}

module.exports = {
  deviceVia, setDeviceVia, getDeviceVia,
  castAvailable, castReceiverStatus, castSetVolume, castMedia, castQuit,
  dialRequest, dialRunningApp, dialDeviceInfo, dialQuitCurrent,
  validateTransport, sendTransportCommand, safeTimeout,
};
