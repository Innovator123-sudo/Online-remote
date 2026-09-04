/* Cast Remote — phone → Chromecast directly. No PC, no bridge, no pairing codes.
   - Cast Web SDK: one-tap connect, auto-rejoin on return visits
   - Buttons + keyboard + hand-gesture zones drive Cast keys:
     UP/DOWN = volume, LEFT/RIGHT = ±30s seek, CENTER/fist = play-pause,
     thumb-down = back, HOME/BACK buttons quit to backdrop
*/

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const clamp = (v,a,b)=> Math.max(a, Math.min(b,v));
const now = ()=> performance.now();

function toast(msg, type=""){
  const stack = $("#toastStack");
  if(!stack) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(()=> el.style.opacity="0", 2200);
  setTimeout(()=> el.remove(), 2600);
}
let _lastErrToastAt = 0;
function errToastOnce(msg){
  const t = performance.now();
  if(t - _lastErrToastAt < 3000) return;
  _lastErrToastAt = t;
  toast(msg, "bad");
}

// ---------- THEME + NAV ----------
try{ if(localStorage.getItem("theme")) document.documentElement.setAttribute("data-theme", localStorage.getItem("theme")); }catch{}
const themeToggle = $("#themeToggle");
if(themeToggle) themeToggle.onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const nxt = cur === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", nxt);
  try{ localStorage.setItem("theme", nxt); }catch{}
};
const navToggleEl = $("#navToggle");
if(navToggleEl) navToggleEl.onclick = ()=> $("#navLinks").classList.toggle("open");

// ---------- CAST STATE ----------
const castDirect = {available:false, inited:false, session:null, player:null, controller:null};
const state = {
  connected: null, // {name}
  pause: false,
  deadPct: 32,
  DWELL_MS: 1200,
  _dwellKey: null,
  _dwellStart: 0,
  _dwellFired: false,
  _lastPalm: {px:0.5, py:0.5},
  _twoFrames: 0, _fistFrames: 0, _thumbDownFrames: 0,
};

function initCastApi(){
  try{
    if(castDirect.inited || !window.cast || !window.cast.framework || !window.chrome || !window.chrome.cast) return;
    const ctx = window.cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      resumeSavedSession: true,
    });
    castDirect.player = new window.cast.framework.RemotePlayer();
    castDirect.controller = new window.cast.framework.RemotePlayerController(castDirect.player);
    ctx.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, onCastSession);
    castDirect.inited = true;
    castDirect.available = true;
    const s = ctx.getCurrentSession();
    if(s){ castDirect.session = s; onCastSession({sessionState: "SESSION_RESUMED"}); }
  }catch{ castDirect.available = false; }
  updateCastUI();
}
window.__onGCastApiAvailable = function(ok){ if(ok) initCastApi(); };
window.addEventListener("load", ()=> setTimeout(()=>{ initCastApi(); if(window._gcastOk) initCastApi(); }, 600));

function castConnectTap(){
  try{
    if(!castDirect.available || !window.cast || !window.cast.framework) throw new Error("no-cast");
    const ctx = window.cast.framework.CastContext.getInstance();
    // Silent path: an existing session is adopted with no launch, no dialog.
    const existing = ctx.getCurrentSession();
    if(existing){
      castDirect.session = existing;
      onCastSession({sessionState: "SESSION_RESUMED"});
      return;
    }
    // A fresh connect must open the Cast channel on the TV (Google's rule —
    // every Cast remote does this). Ask once per visit so it's never a surprise.
    if(!window._castLaunchOk){
      if(!confirm("Connect opens the Cast screen on your TV (this is the remote channel — required by Chromecast). Continue?")) return;
      window._castLaunchOk = true;
    }
    ctx.requestSession();
  }catch{
    toast("Direct Cast needs Chrome on Android + same Wi-Fi as the TV", "bad");
  }
}
}
function sessionName(s){
  try{ const d = s.getCastDevice && s.getCastDevice(); if(d && d.friendlyName) return String(d.friendlyName).slice(0,40); }catch{}
  return "Chromecast";
}
function onCastSession(e){
  try{
    const st = (e && e.sessionState) || "";
    if(st === "SESSION_STARTED" || st === "SESSION_RESUMED"){
      const ctx = window.cast.framework.CastContext.getInstance();
      const s = ctx.getCurrentSession();
      if(!s) return;
      castDirect.session = s;
      const name = sessionName(s);
      state.connected = {name};
      try{ localStorage.setItem("castTvName", name); }catch{}
      updateCastUI();
      toast(`Connected: ${name}`, "good");
      try{
        const st = castDirect.player ? castDirect.player.playerState : null;
        if(!st || st === "IDLE") toast("Remote channel open — volume works now", "good");
      }catch{}
    } else if(st === "SESSION_ENDED" || st === "SESSION_ENDING"){
      castDirect.session = null;
      if(state.connected){ state.connected = null; updateCastUI(); }
    }
  }catch{}
  updateCastUI();
}
function updateCastUI(){
  const c = !!(state.connected && castDirect.session);
  const pill = $("#connPill"), txt = $("#connText");
  if(pill) pill.classList.toggle("connected", c);
  if(txt) txt.textContent = c ? state.connected.name : "Not connected";
  const cp = $("#connectedPanel"), rp = $("#remotePanel");
  if(cp) cp.classList.toggle("hidden", c);
  if(rp) rp.classList.toggle("hidden", !c);
  if(c){
    if($("#tvName")) $("#tvName").textContent = state.connected.name;
    if($("#tvMeta")) $("#tvMeta").textContent = "Cast direct — no PC";
    if($("#tvAvatar")) $("#tvAvatar").textContent = state.connected.name[0].toUpperCase();
    if($("#heroTvName")) $("#heroTvName").textContent = state.connected.name;
  } else {
    if($("#heroTvName")) $("#heroTvName").textContent = "No TV yet";
  }
  const showBtn = castDirect.available && !c;
  ["#castConnectBtn", "#castConnectHero"].forEach(id=>{
    const b = $(id);
    if(b) b.style.display = showBtn ? "" : "none";
  });
  const hs = $("#heroStatus");
  if(hs){
    if(!castDirect.available){
      hs.innerHTML = "<strong>⚠️ Direct Cast unavailable here:</strong> open this page in <em>Chrome on Android</em>, joined to your home Wi-Fi.";
    } else if(!c){
      hs.innerHTML = "<strong>✅ Nothing to set up:</strong> join your <em>home Wi-Fi</em> (mobile data off), tap Connect, pick your TV. First connect opens the Cast screen (the remote channel).";
    } else {
      hs.innerHTML = `<strong>✅ Connected to ${state.connected.name}.</strong> Buttons, keys and gestures are live.`;
    }
  }
}

// ---------- CAST COMMANDS ----------
function castStepVolume(delta){
  try{
    const s = castDirect.session;
    if(!s) return false;
    const v = s.getVolume() || {level: 0.5, muted: false};
    const nv = new window.chrome.cast.Volume(
      clamp(Math.round(((v.level == null ? 0.5 : v.level) + delta) * 100) / 100, 0, 1), false);
    s.setVolume(nv, ()=>{}, ()=>{});
    return true;
  }catch{ return false; }
}
function castSeek(delta){
  try{
    const p = castDirect.player, c = castDirect.controller;
    if(p && c && p.canSeek && isFinite(p.duration) && p.duration > 0){
      p.currentTime = clamp((p.currentTime || 0) + delta, 0, p.duration);
      c.seek();
      return true;
    }
  }catch{}
  return false;
}
const ZONE_OF_CMD = {VOL_UP:"UP", VOL_DOWN:"DOWN", SEEK_BACK:"LEFT", SEEK_FWD:"RIGHT", TOGGLE:"CENTER"};
function flashZoneForCmd(cmd){
  const zone = ZONE_OF_CMD[cmd];
  if(zone) $$("#dpadMini .mini-btn").forEach(b=> b.classList.toggle("active", b.dataset.zone===zone));
  $$(".dpad-btn").forEach(b=> b.classList.toggle("active", b.dataset.cmd===cmd));
  setTimeout(()=>{
    $$("#dpadMini .mini-btn").forEach(b=> b.classList.remove("active"));
    $$(".dpad-btn").forEach(b=> b.classList.remove("active"));
  }, 420);
}
async function sendCommand(cmd){
  if(!state.connected || !castDirect.session){
    errToastOnce("Not connected — tap 📺 Connect my TV first");
    return;
  }
  let ok = false, note = "";
  try{
    switch(cmd){
      case "VOL_UP": ok = castStepVolume(0.05); break;
      case "VOL_DOWN": ok = castStepVolume(-0.05); break;
      case "MUTE":
        if(castDirect.controller){ castDirect.controller.muteOrUnmute(); ok = true; }
        else {
          const v = castDirect.session.getVolume() || {level: 0.5, muted: false};
          const nv = new window.chrome.cast.Volume(v.level == null ? 0.5 : v.level, !v.muted);
          castDirect.session.setVolume(nv, ()=>{}, ()=>{});
          ok = true;
        }
        note = "Mute"; break;
      case "TOGGLE":
        if(castDirect.controller){ castDirect.controller.playOrPause(); ok = true; note = "Play/pause"; }
        break;
      case "SEEK_BACK": ok = castSeek(-30); note = "−30s"; if(!ok) toast("Nothing seekable playing", "bad"); break;
      case "SEEK_FWD": ok = castSeek(30); note = "+30s"; if(!ok) toast("Nothing seekable playing", "bad"); break;
      case "HOME": case "BACK": case "POWER":
        castDirect.session.endSession(true); // quit app → backdrop (≈ home)
        ok = true; note = cmd === "POWER" ? "Off (backdrop)" : "Back to home"; break;
      default: break;
    }
  }catch{ ok = false; }
  if(ok){ toast(note || cmd, "good"); flashZoneForCmd(cmd); }
  else if(cmd !== "SEEK_BACK" && cmd !== "SEEK_FWD") errToastOnce("That key did nothing — is media playing?");
}
function disconnect(){
  // Release the TV back to whatever it was showing — never trap the Cast screen.
  try{ if(castDirect.session) castDirect.session.endSession(true); }catch{}
  castDirect.session = null;
  state.connected = null;
  updateCastUI();
  toast("Disconnected — TV released");
}
// Auto-release: tab hidden 60s → give the TV back (no permanent Cast screen).
let _hideTimer = null;
document.addEventListener("visibilitychange", ()=>{
  if(document.hidden){
    clearTimeout(_hideTimer);
    _hideTimer = setTimeout(()=>{
      try{
        if(castDirect.session){
          castDirect.session.endSession(true);
          toast("TV released (tab was hidden)");
        }
      }catch{}
    }, 60000);
  } else {
    clearTimeout(_hideTimer);
    // Silently re-adopt a surviving session — no launch, no dialog.
    try{
      const s = window.cast.framework.CastContext.getInstance().getCurrentSession();
      if(s && !castDirect.session){ castDirect.session = s; onCastSession({sessionState: "SESSION_RESUMED"}); }
    }catch{}
  }
});

// ---------- BUTTONS + KEYBOARD ----------
$$(".dpad-btn, .qbtn").forEach(b=>{
  b.onclick = ()=>{ const cmd = b.dataset.cmd; if(cmd) sendCommand(cmd); };
});
const heroBtn = $("#castConnectHero");
if(heroBtn) heroBtn.onclick = castConnectTap;
const cardBtn = $("#castConnectBtn");
if(cardBtn) cardBtn.onclick = castConnectTap;
const discBtn = $("#disconnectBtn");
if(discBtn) discBtn.onclick = disconnect;
document.addEventListener("keydown", e=>{
  if(e.code === "Space" && !/INPUT|TEXTAREA/.test((e.target.tagName||""))){
    e.preventDefault();
    const cb = $("#pauseGestures");
    if(cb){ cb.checked = !cb.checked; state.pause = cb.checked; toast(state.pause ? "Gestures paused" : "Gestures resumed"); }
    return;
  }
  if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key)){
    e.preventDefault();
    sendCommand({ArrowUp:"VOL_UP", ArrowDown:"VOL_DOWN", ArrowLeft:"SEEK_BACK", ArrowRight:"SEEK_FWD"}[e.key]);
  }
  else if(e.key === "Enter") sendCommand("TOGGLE");
  else if(e.key === "Backspace") sendCommand("BACK");
  else if(e.key.toLowerCase() === "h") sendCommand("HOME");
  else if(e.key.toLowerCase() === "m") sendCommand("MUTE");
});

// ---------- GESTURE ENGINE (zones → Cast keys) ----------
const video = $("#video"), overlay = $("#overlay"), zoneOverlay = $("#zoneOverlay"), videoWrap = $("#videoWrap");
const gestureLabel = $("#gestureLabel"), zoneLabel = $("#zoneLabel"), confLabel = $("#confLabel"), fpsLabel = $("#fpsLabel");
const camToggle = $("#camToggle"), mirrorToggle = $("#mirrorToggle"), showLandmarks = $("#showLandmarks");
let hands = null, camera = null, running = false, rafId = null;
let lastStream = null;
let _inferBusy = false;
let lastFpsUpdate = now(), frames = 0;

function setCamUI(on){
  if(!camToggle) return;
  camToggle.textContent = on ? "Disable Camera" : "Enable Camera";
  camToggle.classList.toggle("primary", !on);
  if(videoWrap) videoWrap.classList.toggle("has-video", on);
}
function resizeOverlays(){
  if(!videoWrap) return;
  [overlay, zoneOverlay].forEach(c=>{
    if(!c) return;
    const rect = videoWrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    c.style.width = rect.width + "px";
    c.style.height = rect.height + "px";
  });
  drawZones();
}
window.addEventListener("resize", resizeOverlays);
function drawZones(){
  if(!zoneOverlay) return;
  const c = zoneOverlay, ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  const dead = state.deadPct / 100;
  const cx0 = (0.5 - dead/2)*w, cx1 = (0.5 + dead/2)*w;
  const cy0 = (0.5 - dead/2)*h, cy1 = (0.5 + dead/2)*h;
  ctx.strokeStyle = "rgba(255,255,255,.22)";
  ctx.lineWidth = 1*dpr;
  ctx.setLineDash([6*dpr, 6*dpr]);
  ctx.strokeRect(cx0, cy0, cx1-cx0, cy1-cy0);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.font = `${11*dpr}px Inter`;
  ctx.textAlign = "center";
  ctx.fillText("CENTER — idle", w/2, cy0 - 8*dpr);
}
const cooldownRange = $("#cooldownRange"), deadRange = $("#deadRange");
if(cooldownRange) cooldownRange.oninput = e=>{ state.DWELL_MS = parseInt(e.target.value); $("#cooldownVal").textContent = (state.DWELL_MS/1000) + "s"; };
if(deadRange) deadRange.oninput = e=>{ state.deadPct = parseInt(e.target.value); $("#deadVal").textContent = state.deadPct + "%"; drawZones(); _fsGridFresh = false; };
const pauseBox = $("#pauseGestures");
if(pauseBox) pauseBox.onchange = e=> state.pause = e.target.checked;
if(mirrorToggle) mirrorToggle.onchange = ()=> videoWrap.classList.toggle("mirror", mirrorToggle.checked);
if(videoWrap && mirrorToggle) videoWrap.classList.toggle("mirror", mirrorToggle.checked);

// Finger math (joint-angle + length — strict so zones don't misfire)
function angleAt(a, b, c){
  const ux = a.x-b.x, uy = a.y-b.y, vx = c.x-b.x, vy = c.y-b.y;
  const dot = ux*vx + uy*vy;
  const lu = Math.hypot(ux,uy), lv = Math.hypot(vx,vy);
  if(!lu || !lv) return 180;
  return Math.acos(Math.max(-1, Math.min(1, dot/(lu*lv)))) * 180/Math.PI;
}
const FINGER_DEFS = [
  {tip:4,  a:2,  b:3},
  {tip:8,  a:5,  b:6},
  {tip:12, a:9,  b:10},
  {tip:16, a:13, b:14},
  {tip:20, a:17, b:18},
];
function fingerMask(landmarks){
  const wrist = landmarks[0], palm = landmarks[9];
  const hand = Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  return FINGER_DEFS.map(({tip:a, a:an, b:bn})=>{
    const tp = landmarks[a], mcp2 = landmarks[an], jnt = landmarks[bn];
    if(!tp || !mcp2 || !jnt) return 0;
    if(a === 4){
      const dTip = Math.hypot(tp.x-wrist.x, tp.y-wrist.y);
      const dMcp = Math.hypot(mcp2.x-wrist.x, mcp2.y-wrist.y);
      return (dTip > dMcp*1.05 && angleAt(landmarks[1], jnt, tp) > 135) ? 1 : 0;
    }
    const dTip = Math.hypot(tp.x-wrist.x, tp.y-wrist.y);
    const dMcp = Math.hypot(mcp2.x-wrist.x, mcp2.y-wrist.y);
    const dTip2Mcp = Math.hypot(tp.x-mcp2.x, tp.y-mcp2.y);
    return (dTip > dMcp*1.05 && dTip2Mcp > hand*0.28 && angleAt(mcp2, jnt, tp) > 148) ? 1 : 0;
  });
}
function isFist(landmarks){
  const mask = fingerMask(landmarks);
  if(mask[1]===1 || mask[2]===1 || mask[3]===1 || mask[4]===1) return false;
  const wrist = landmarks[0], palm = landmarks[9];
  const hand = Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  let close = 0;
  [[8,6],[12,10],[16,14],[20,18]].forEach(([tip,pip])=>{
    const t = landmarks[tip], p = landmarks[pip];
    if(t && p && Math.hypot(t.x-p.x, t.y-p.y) < hand*0.60) close++;
  });
  if(close < 3) return false;
  const tt = landmarks[4], tm = landmarks[2];
  if(tt && tm && (tt.y - tm.y) > hand*0.2) return false; // thumb-down is BACK, not OK
  return true;
}
function isThumbDown(landmarks){
  const mask = fingerMask(landmarks);
  if(mask[1]===1 || mask[2]===1 || mask[3]===1 || mask[4]===1) return false;
  const wrist = landmarks[0], palm = landmarks[9];
  const hand = Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  const tMcp = landmarks[2], tTip = landmarks[4];
  if(!tMcp || !tTip) return false;
  const dTip = Math.hypot(tTip.x-wrist.x, tTip.y-wrist.y);
  const dMcp = Math.hypot(tMcp.x-wrist.x, tMcp.y-wrist.y);
  if(dTip < dMcp*1.1) return false;
  const dropY = tTip.y - tMcp.y;
  const sideX = Math.abs(tTip.x - tMcp.x);
  return dropY >= hand*0.18 && sideX <= dropY*0.95;
}
function isNavHand(landmarks){
  if(isFist(landmarks) || isThumbDown(landmarks)) return false;
  let open = 0;
  [[8,6],[12,10]].forEach(([tip,pip])=>{
    const t = landmarks[tip], p = landmarks[pip], w = landmarks[0];
    if(t && p && w && Math.hypot(t.x-w.x, t.y-w.y) > Math.hypot(p.x-w.x, p.y-w.y)*1.02) open++;
  });
  return open >= 1;
}
function mapZone(x, y){
  const dead = state.deadPct/100;
  const x0 = 0.5 - dead/2, x1 = 0.5 + dead/2;
  const y0 = 0.5 - dead/2, y1 = 0.5 + dead/2;
  if(x >= x0 && x <= x1 && y >= y0 && y <= y1) return "CENTER";
  const dx = x - 0.5, dy = y - 0.5;
  return Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? "UP" : "DOWN") : (dx < 0 ? "LEFT" : "RIGHT");
}
const ZONE_CMD = {UP:"VOL_UP", DOWN:"VOL_DOWN", LEFT:"SEEK_BACK", RIGHT:"SEEK_FWD"};

async function initHands(){
  if(hands) return hands;
  if(typeof Hands === "undefined"){ toast("Hand tracking still loading — try again in a few seconds", "bad"); return null; }
  hands = new Hands({locateFile: (file)=> `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
  hands.setOptions({maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5});
  hands.onResults(onHandsResults);
  return hands;
}

// Fullscreen painters (single clear → grid + skeleton per frame)
function strokeFsSkeleton(ctx, pts, dpr){
  if(typeof HAND_CONNECTIONS !== "undefined"){
    ctx.lineWidth = 2.5*dpr; ctx.lineCap = "round"; ctx.strokeStyle = "rgba(0,245,255,.9)";
    ctx.beginPath();
    HAND_CONNECTIONS.forEach(([a,b])=>{ const pa = pts[a], pb = pts[b]; ctx.moveTo(pa.x,pa.y); ctx.lineTo(pb.x,pb.y); });
    ctx.stroke();
  }
  ctx.fillStyle = "#ffffff";
  pts.forEach(p=>{ ctx.beginPath(); ctx.arc(p.x,p.y,3.5*dpr,0,7); ctx.fill(); });
  ctx.fillStyle = "rgba(255,80,190,1)";
  [4,8,12,16,20].forEach(i=>{ const p = pts[i]; ctx.beginPath(); ctx.arc(p.x,p.y,4.5*dpr,0,7); ctx.fill(); });
}
function strokeFsGrid(ctx, w, h, dpr){
  const dead = state.deadPct/100;
  const cx0 = (0.5-dead/2)*w, cx1 = (0.5+dead/2)*w;
  const cy0 = (0.5-dead/2)*h, cy1 = (0.5+dead/2)*h;
  ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 2*dpr;
  ctx.setLineDash([8*dpr, 8*dpr]);
  ctx.strokeRect(cx0, cy0, cx1-cx0, cy1-cy0);
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(79,124,255,.14)"; ctx.lineWidth = 2*dpr;
  ctx.beginPath(); ctx.moveTo(cx0,0); ctx.lineTo(cx0,h); ctx.moveTo(cx1,0); ctx.lineTo(cx1,h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,cy0); ctx.lineTo(w,cy0); ctx.moveTo(0,cy1); ctx.lineTo(w,cy1); ctx.stroke();
}
let _fsGridFresh = false;
function fsPaint(landmarks){
  const fsO = $("#fsOverlay");
  if(!fsO) return;
  const rect = fsO.getBoundingClientRect();
  if(rect.width < 50) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = rect.width*dpr, ch = rect.height*dpr;
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const scale = Math.max(cw/vw, ch/vh);
  const w = vw*scale, h = vh*scale, ox = (cw-w)/2, oy = (ch-h)/2;
  const mirror = mirrorToggle && mirrorToggle.checked;
  const pts = landmarks.map(lm=>({x: ox + (mirror ? 1-lm.x : lm.x)*w, y: oy + lm.y*h}));
  const ctx = fsO.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,cw,ch);
  strokeFsGrid(ctx, cw, ch, dpr);
  strokeFsSkeleton(ctx, pts, dpr);
  _fsGridFresh = true;
}

// Pages + fullscreen
function showPage(id){
  ["page-home","page-zones"].forEach(p=>{
    const el = document.getElementById(p);
    if(el){ const on = p === id; el.classList.toggle("active", on); el.classList.toggle("hidden", !on); }
  });
  if(id === "page-zones"){ try{ if(document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(()=>{}); }catch{} }
}
function syncFsVideo(){
  const fsV = $("#fsVideo");
  if(!fsV) return;
  if(lastStream){ fsV.srcObject = lastStream; fsV.play().catch(()=>{}); }
  if(mirrorToggle) fsV.classList.toggle("mirror", mirrorToggle.checked);
}
function enterFullscreenGesture(){
  syncFsVideo();
  resizeFsOverlay();
  showPage("page-zones");
  if(!running) startCamera();
}
function leaveFullscreen(){
  showPage("page-home");
  try{ if(document.exitFullscreen) document.exitFullscreen(); }catch{}
  const fsV = $("#fsVideo"); if(fsV) fsV.srcObject = null;
}
const enterZonesBtn = $("#enterZonesBtn");
if(enterZonesBtn) enterZonesBtn.onclick = ()=> enterFullscreenGesture();
const exitZonesBtn = $("#exitZonesBtn");
if(exitZonesBtn) exitZonesBtn.onclick = ()=> leaveFullscreen();
function resizeFsOverlay(){
  const fsO = $("#fsOverlay");
  if(!fsO) return;
  const dpr = window.devicePixelRatio || 1;
  fsO.width = window.innerWidth * dpr;
  fsO.height = window.innerHeight * dpr;
  _fsGridFresh = false;
}
window.addEventListener("resize", ()=> resizeFsOverlay());
function syncFsOverlayState(){
  const fsO = $("#fsOverlay");
  if(!fsO) return;
  const rect = fsO.getBoundingClientRect();
  if(rect.width < 50) return;
  const dpr = window.devicePixelRatio || 1;
  const w = rect.width*dpr, h = rect.height*dpr;
  const ctx = fsO.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,w,h);
  strokeFsGrid(ctx, w, h, dpr);
  _fsGridFresh = true;
}

// Dwell-to-click
function enterDwell(key){
  if(state._dwellKey !== key){ state._dwellKey = key; state._dwellStart = now(); state._dwellFired = false; }
}
function resetDwell(){
  state._dwellKey = null; state._dwellStart = 0; state._dwellFired = false;
  state._lastPalm = {px:0.5, py:0.5};
}
function dwellProgress(){
  if(!state._dwellStart) return 0;
  return clamp((now() - state._dwellStart) / state.DWELL_MS, 0, 1);
}
function drawDwellRing(prog){
  const fsO = $("#fsOverlay"), fsV = $("#fsVideo");
  if(!fsO || prog <= 0) return;
  const rect = fsO.getBoundingClientRect();
  if(rect.width < 50) return;
  const p = state._lastPalm;
  const dpr = window.devicePixelRatio || 1;
  const cw = rect.width*dpr, ch = rect.height*dpr;
  const vw = (fsV && fsV.videoWidth > 0) ? fsV.videoWidth : (video.videoWidth || 1280);
  const vh = (fsV && fsV.videoHeight > 0) ? fsV.videoHeight : (video.videoHeight || 720);
  const scale = Math.max(cw/vw, ch/vh);
  const ox = (cw - vw*scale)/2, oy = (ch - vh*scale)/2;
  let x = p.px; if(mirrorToggle && mirrorToggle.checked) x = 1 - x;
  const sx = ox + x*vw*scale, sy = oy + p.py*vh*scale;
  const ctx = fsO.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  ctx.strokeStyle = "rgba(255,255,255,.16)"; ctx.lineWidth = 6*dpr;
  ctx.beginPath(); ctx.arc(sx, sy, 30*dpr, 0, Math.PI*2); ctx.stroke();
  ctx.strokeStyle = prog >= 1 ? "rgba(52,211,153,.95)" : "rgba(0,245,255,.9)";
  ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(sx, sy, 30*dpr, -Math.PI/2, -Math.PI/2 + Math.PI*2*Math.min(prog,1)); ctx.stroke();
  ctx.fillStyle = prog >= 1 ? "rgba(52,211,153,.95)" : "rgba(255,255,255,.85)";
  ctx.font = `bold ${16*dpr}px ui-monospace, monospace`; ctx.textAlign = "center";
  ctx.fillText(prog >= 1 ? "GO" : `${Math.round(prog*100)}%`, sx, sy + 6*dpr);
}
function gestureHud(msg){
  if(gestureLabel && gestureLabel._v !== msg){ gestureLabel._v = msg; gestureLabel.textContent = msg; }
  const fsh = $("#fsGestureHud");
  if(fsh && fsh._v !== msg){ fsh._v = msg; fsh.textContent = msg; }
}
function setZoneHud(txt){
  if(zoneLabel && zoneLabel._v !== txt){ zoneLabel._v = txt; zoneLabel.textContent = txt; }
}

function onHandsResults(results){
  frames++;
  const t = now();
  if(t - lastFpsUpdate > 500){
    const fps = Math.round(frames*1000/(t-lastFpsUpdate));
    if(fpsLabel) fpsLabel.textContent = fps;
    lastFpsUpdate = t; frames = 0;
  }
  const ctx = overlay.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if(!results.multiHandLandmarks || results.multiHandLandmarks.length === 0){
    gestureHud("No hand");
    setZoneHud("—");
    if(confLabel && confLabel._v !== "—"){ confLabel._v = "—"; confLabel.textContent = "—"; }
    resetDwell();
    if(!_fsGridFresh){ const fsO2 = $("#fsOverlay"); if(fsO2 && fsO2.width) syncFsOverlayState(); }
    return;
  }
  const landmarks = results.multiHandLandmarks[0];
  const handedness = results.multiHandedness && results.multiHandedness[0] ? results.multiHandedness[0].label : "Hand";
  const score = results.multiHandedness && results.multiHandedness[0] ? (results.multiHandedness[0].score || 0) : 0;
  const confTxt = handedness + (score ? ` ${(score*100|0)}%` : "");
  if(confLabel && confLabel._v !== confTxt){ confLabel._v = confTxt; confLabel.textContent = confTxt; }
  if(showLandmarks.checked && window.drawConnectors && window.drawLandmarks){
    ctx.save();
    if(mirrorToggle.checked){ ctx.scale(-1,1); ctx.translate(-overlay.width,0); }
    drawConnectors(ctx, landmarks, HAND_CONNECTIONS, {color:"rgba(79,124,255,.9)", lineWidth:2*dpr});
    drawLandmarks(ctx, landmarks, {color:"rgba(255,255,255,.95)", lineWidth:1, radius:3*dpr});
    ctx.restore();
  }
  fsPaint(landmarks); // one clear + grid + skeleton

  const fistRaw = isFist(landmarks);
  const thumbDownRaw = isThumbDown(landmarks);
  const navRaw = isNavHand(landmarks);
  state._fistFrames = (fistRaw && !thumbDownRaw) ? state._fistFrames + 1 : 0;
  state._thumbDownFrames = thumbDownRaw ? state._thumbDownFrames + 1 : 0;
  const fist = state._fistFrames >= 3 && !thumbDownRaw;
  const thumbDown = state._thumbDownFrames >= 3 && !fist;
  const nav = !fist && !thumbDown && navRaw;

  let palm = landmarks[9];
  let px = palm.x, py = palm.y;
  if(mirrorToggle.checked) px = 1 - px;
  state._lastPalm = {px, py};

  const remain = ()=> Math.max(1, Math.ceil((1 - dwellProgress()) * state.DWELL_MS / 1000));
  if(thumbDown){
    gestureHud(`👎 Back — hold ${remain()}s`);
    setZoneHud("BACK");
    enterDwell("back");
    drawDwellRing(dwellProgress());
    if(dwellProgress() >= 1 && !state._dwellFired){ state._dwellFired = true; sendCommand("BACK"); }
    return;
  }
  if(fist){
    gestureHud(`✊ Play/pause — hold ${remain()}s`);
    setZoneHud("PLAY");
    $$("#dpadMini .mini-btn").forEach(b=> b.classList.toggle("active", b.dataset.zone === "CENTER"));
    enterDwell("fist");
    drawDwellRing(dwellProgress());
    if(dwellProgress() >= 1 && !state._dwellFired){ state._dwellFired = true; sendCommand("TOGGLE"); }
    return;
  }
  if(nav){
    const zone = mapZone(px, py);
    setZoneHud(zone === "CENTER" ? "CENTER — idle" : zone);
    $$("#dpadMini .mini-btn").forEach(b=> b.classList.toggle("active", b.dataset.zone === zone));
    if(zone === "CENTER"){
      gestureHud("Center idle — fist = play/pause");
      resetDwell();
      return;
    }
    gestureHud(`${zone} — hold ${remain()}s`);
    enterDwell("zone:" + zone);
    drawDwellRing(dwellProgress());
    if(dwellProgress() >= 1 && !state._dwellFired){ state._dwellFired = true; sendCommand(ZONE_CMD[zone]); }
  } else {
    gestureHud("Show your palm");
    setZoneHud("—");
    resetDwell();
  }
}

// ---------- CAMERA ----------
function isSecureForCamera(){
  return window.isSecureContext || ["localhost","127.0.0.1"].includes(location.hostname)
    || location.hostname.startsWith("192.168.") || location.hostname.startsWith("10.");
}
function showCameraError(title, details, canRetry = true){
  const ph = $("#videoPlaceholder");
  if(ph){
    ph.innerHTML = `<div style="padding:16px;max-width:340px;text-align:center">
      <div class="ph-icon" style="font-size:28px">⚠️</div>
      <p style="font-weight:800;margin:6px 0 4px">${title}</p>
      <small style="display:block;line-height:1.5;margin-bottom:10px;opacity:.75">${details}</small>
      ${canRetry ? `<button class="btn small primary" id="camRetryBtn" style="margin:4px">Try Again</button>` : ""}
    </div>`;
    ph.style.display = "grid";
    const rb = $("#camRetryBtn");
    if(rb) rb.onclick = ()=> startCamera();
  }
  if(videoWrap) videoWrap.classList.remove("has-video");
  setCamUI(false);
}
async function startCamera(){
  if(running) return;
  if(!isSecureForCamera()){
    showCameraError("Camera needs HTTPS or same-Wi-Fi", `You are on <code>${location.protocol}//${location.hostname}</code>. Open the <code>https://</code> site or the same-Wi-Fi link.`, false);
    return;
  }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    showCameraError("Camera API not available", "Use Chrome on Android or desktop.", false);
    return;
  }
  const h = await initHands();
  if(!h) return;
  let stream = null, lastErr = null;
  for(const constr of [
    {video:{width:{ideal:1280}, height:{ideal:720}, facingMode:"user"}, audio:false},
    {video:{width:{ideal:640}, height:{ideal:480}, facingMode:"user"}, audio:false},
    {video:true, audio:false},
  ]){
    try{ stream = await navigator.mediaDevices.getUserMedia(constr); break; }
    catch(e){ lastErr = e; if(e.name === "NotAllowedError") break; }
  }
  if(!stream){
    const e = lastErr || new Error("unknown");
    if(e.name === "NotAllowedError") showCameraError("Camera permission denied", "Tap <strong>Try Again</strong>, then <strong>Allow</strong> when asked.", true);
    else if(e.name === "NotFoundError") showCameraError("No camera found", "This device has no camera to use.", false);
    else if(e.name === "NotReadableError") showCameraError("Camera busy", "Close the other app using the camera, then Try Again.", true);
    else showCameraError("Camera failed", `${e.name}: ${e.message || "unknown"}`, true);
    return;
  }
  try{
    lastStream = stream;
    video.srcObject = stream;
    await video.play();
    resizeOverlays();
    if(videoWrap) videoWrap.classList.add("has-video");
    running = true;
    setCamUI(true);
    const ph2 = $("#videoPlaceholder");
    if(ph2) ph2.style.display = "none";
    toast("Camera on — show your palm", "good");
    if(typeof Camera !== "undefined"){
      camera = new Camera(video, {
        onFrame: async ()=>{
          if(_inferBusy || video.readyState < 2) return;
          _inferBusy = true;
          try{ await hands.send({image: video}); }catch{}
          _inferBusy = false;
        },
        width: 640, height: 480,
      });
      camera.start();
    } else {
      const loop = async ()=>{
        if(!running) return;
        if(video.readyState >= 2 && !_inferBusy){
          _inferBusy = true;
          try{ await hands.send({image: video}); }catch{}
          _inferBusy = false;
        }
        rafId = requestAnimationFrame(loop);
      };
      loop();
    }
    lastFpsUpdate = now(); frames = 0;
  }catch(e){
    showCameraError("Camera failed to start", e.message || String(e), true);
    setCamUI(false);
  }
}
async function stopCamera(){
  running = false;
  if(camera && camera.stop) try{ camera.stop(); }catch{}
  if(rafId) cancelAnimationFrame(rafId);
  if(video.srcObject){ video.srcObject.getTracks().forEach(t=> t.stop()); video.srcObject = null; }
  lastStream = null;
  const fsV = $("#fsVideo"); if(fsV) fsV.srcObject = null;
  if(videoWrap) videoWrap.classList.remove("has-video");
  setCamUI(false);
  gestureHud("Camera off");
  setZoneHud("—");
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  drawZones();
}
if(camToggle) camToggle.onclick = ()=>{ if(running) stopCamera(); else startCamera(); };

// ---------- BOOT ----------
resizeOverlays();
drawZones();
updateCastUI();
initCastApi();
window.addEventListener("beforeunload", ()=>{ if(running) stopCamera(); });
window.TVCast = {sendCommand, castConnectTap};
