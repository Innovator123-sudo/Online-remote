/* Online Remote — gesture TV remote. NO Cast, NO cloud control.
   Your phone (or any home device) running `node server.js` sends real remote
   signals (ADB keyevents) that the TV processes exactly like a physical
   remote: stateless, nothing opens on screen, Home never "disconnects".
   Gestures: palm position = arrows, thumbs-up/fist = OK, thumbs-down = back,
   two fingers = draw letters (type when Search is on). */

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
  setTimeout(()=> el.style.opacity = "0", 2200);
  setTimeout(()=> el.remove(), 2600);
}
let _lastErrToastAt = 0;
function errToastOnce(msg){
  const t = performance.now();
  if(t - _lastErrToastAt < 3000) return;
  _lastErrToastAt = t;
  toast(msg, "bad");
}

// ---------- STATE ----------
const state = {
  tvs: [], connected: null, scanning: false,
  subnet: null, bridge: false, searchActive: false,
  pause: false, deadPct: 32, DWELL_MS: 1200,
  _dwellKey: null, _dwellStart: 0, _dwellFired: false,
  _lastPalm: {px:0.5, py:0.5},
  _fistFrames: 0, _thumbDownFrames: 0, _thumbUpFrames: 0,
  drawing: false, drawPoints: [], lastDrawEnd: 0, _drawTimer: null,
  word: "",
};
function uid(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }

// ---------- THEME + NAV ----------
try{ if(localStorage.getItem("theme")) document.documentElement.setAttribute("data-theme", localStorage.getItem("theme")); }catch{}
const themeToggle = $("#themeToggle");
if(themeToggle) themeToggle.onclick = ()=>{
  const cur = document.documentElement.getAttribute("data-theme");
  const nxt = cur === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", nxt);
  try{ localStorage.setItem("theme", nxt); }catch{}
};
const navToggleEl = $("#navToggle");
if(navToggleEl) navToggleEl.onclick = ()=> $("#navLinks").classList.toggle("open");

// ---------- SUBNET ----------
async function detectSubnet(){
  try{
    const pc = new RTCPeerConnection({iceServers:[]});
    pc.createDataChannel("");
    await pc.setLocalDescription(await pc.createOffer());
    const ip = await new Promise(res=>{
      let found = "";
      pc.onicecandidate = e=>{
        if(!e.candidate){ res(found); return; }
        const m = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
        if(m && !m[1].startsWith("0.") && !m[1].startsWith("169.") && !found) found = m[1];
      };
      setTimeout(()=> res(found), 700);
    });
    pc.close();
    if(ip) state.subnet = ip.split(".").slice(0,3).join(".");
  }catch{}
  if(!state.subnet) state.subnet = "192.168.1";
}

// ---------- HELPER CLIENT (quiet, cached, no log spam) ----------
// The helper is just `node server.js` on your network — Termux on this very
// phone works: the page then talks to http://localhost:5000 same-origin.
let bridgeBase = null;
try{ bridgeBase = localStorage.getItem("bridgeBase") || null; }catch{}
try{
  const qb = (new URLSearchParams(location.search).get("bridge") || "").trim().replace(/\/+$/,"");
  if(qb){
    let v = qb; if(!v.startsWith("http")) v = "http://" + v; if(!/:\d+$/.test(v)) v += ":5000";
    if(/^https?:\/\/(\d{1,3}\.){3}\d{1,3}:\d+$/.test(v)){ bridgeBase = v; try{ localStorage.setItem("bridgeBase", v); }catch{} }
  }
}catch{}
function bridgeCandidates(){
  const list = [];
  if(location.origin && location.origin.startsWith("http")) list.push(location.origin);
  if(bridgeBase && !list.includes(bridgeBase)) list.push(bridgeBase);
  for(const u of ["http://localhost:5000"]){ if(!list.includes(u)) list.push(u); }
  return list;
}
async function probeBridgeBase(base, ms=1000){
  try{
    const r = await fetch(`${base}/status`, {method:"GET", signal:AbortSignal.timeout(ms)});
    if(!r.ok) return false;
    const j = JSON.parse(await r.text());
    return !!(j && (j.ok || j.bridge));
  }catch{ return false; }
}
async function fetchBridge(path, opts={}){
  const tried = [];
  if(bridgeBase) tried.push(bridgeBase);
  for(const c of bridgeCandidates()){ if(!tried.includes(c)) tried.push(c); }
  let lastErr = null;
  for(const base of tried){
    try{
      const r = await fetch(`${base}${path}`, opts);
      if(r){
        if(base !== bridgeBase){ bridgeBase = base; try{ localStorage.setItem("bridgeBase", base); }catch{} }
        return r;
      }
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error("no helper");
}
let _bridgeToastShown = false, _wasBridge = false;
async function checkBridge(){
  if(document.hidden) return;
  for(const base of bridgeCandidates()){
    if(await probeBridgeBase(base, 900)){
      bridgeBase = base;
      try{ localStorage.setItem("bridgeBase", base); }catch{}
      state.bridge = true;
      if(!_bridgeToastShown){ _bridgeToastShown = true; toast("Helper found — full remote ready", "good"); }
      try{
        const r = await fetch(`${base}/status`, {signal:AbortSignal.timeout(1500)});
        const j = JSON.parse(await r.text());
        if(j.tvs) j.tvs.forEach(t=> addTv({name:t.name, ip:t.ip, model:t.model || "TV"}, true));
      }catch{}
      if(!_wasBridge){ _wasBridge = true; autoResume(); setTimeout(()=>{ if(!state.connected && !state.scanning) doScan(); }, 1500); }
      updateUI();
      return;
    }
  }
  state.bridge = false; _wasBridge = false;
  updateUI();
}
checkBridge();
setInterval(checkBridge, 15000);

// ---------- TV LIST + CONNECT ----------
function isValidIpv4(ip){
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((ip || "").trim());
  return !!m && m.slice(1).every(o=> +o >= 0 && +o <= 255);
}
function sameSubnet(ip){ return !state.subnet || ip.split(".").slice(0,3).join(".") === state.subnet; }
function addTv({name, ip, model}, quiet){
  if(ip && state.tvs.some(t=> t.ip === ip)) return;
  state.tvs.push({id:uid(), name:name || "TV", ip:ip || "", model:(model || "TV").slice(0,32), via:"helper"});
  if(!quiet) updateUI();
}
// Validation = "is this TV real, on my network, answering?" Only then connect.
async function validateTv(tv){
  if(!isValidIpv4(tv.ip)) return {ok:false, reason:"Bad IP address"};
  if(!sameSubnet(tv.ip)) return {ok:false, reason:`${tv.ip} is not on your Wi-Fi (${state.subnet}.0/24)`};
  if(!state.bridge) return {ok:false, reason:"Helper not running — start it, then Scan"};
  try{
    const r = await fetchBridge(`/validate?ip=${encodeURIComponent(tv.ip)}`, {signal:AbortSignal.timeout(12000)});
    const j = JSON.parse(await r.text());
    if(j && j.valid) return {ok:true, via:"helper-" + (j.via || "adb"), name:j.name || ""};
    return {ok:false, reason:`${tv.ip} is quiet — TV on? Same Wi-Fi? Network debugging enabled on the TV?`};
  }catch{ return {ok:false, reason:"Helper unreachable"}; }
}
async function initiateConnect(tv){
  if(state.connected === tv){ toast("Already connected"); return; }
  toast(`Checking ${tv.name}…`);
  const v = await validateTv(tv);
  if(!v.ok){ toast(v.reason, "bad"); updateUI(); return; }
  if(v.via) tv.via = v.via;
  if(v.name && /^tv|android/i.test(tv.name)) tv.name = v.name;
  connectTv(tv);
}
function connectTv(tv){
  state.connected = tv; // stateless from here: every key is its own signal
  try{
    localStorage.setItem("savedTvName", tv.name);
    if(tv.ip) localStorage.setItem("savedTvIp", tv.ip);
  }catch{}
  updateUI();
  toast(`Connected: ${tv.name}`, "good");
}
function disconnect(){
  state.connected = null;
  try{ localStorage.removeItem("savedTvIp"); }catch{}
  updateUI();
  toast("Disconnected");
}
async function autoResume(){
  if(state.connected || state.scanning) return;
  let ip = null;
  try{ ip = localStorage.getItem("savedTvIp"); }catch{}
  if(!ip || !isValidIpv4(ip) || !sameSubnet(ip)) return;
  for(let i = 0; i < 20 && !state.subnet; i++) await new Promise(r=> setTimeout(r, 100));
  if(!sameSubnet(ip)) return;
  addTv({name:"Saved TV", ip}, true);
  const tv = state.tvs.find(t=> t.ip === ip);
  if(tv){
    const v = await validateTv(tv);
    if(v.ok){ if(v.via) tv.via = v.via; connectTv(tv); }
  }
  updateUI();
}
function renderTvs(){
  const list = $("#tvList");
  if(!list) return;
  const others = state.tvs.filter(t=> t !== state.connected);
  list.innerHTML = others.length ? "" : `<div style="color:var(--muted);font-size:.85em">No other TVs found yet — tap Scan.</div>`;
  others.forEach(tv=>{
    const el = document.createElement("div");
    el.className = "tv-item";
    el.innerHTML = `<div class="tv-avatar">${(tv.name[0] || "T").toUpperCase()}</div>
      <div class="tv-item-main"><div class="tv-item-name">${tv.name}</div>
      <div class="tv-item-meta">${tv.ip || ""} • ${tv.model}</div></div>
      <button class="btn small primary">Connect</button>`;
    el.onclick = ()=> initiateConnect(tv);
    list.appendChild(el);
  });
}
function updateUI(){
  const c = !!state.connected;
  $("#connPill").classList.toggle("connected", c);
  $("#connText").textContent = c ? state.connected.name : "Not connected";
  $("#connectedPanel").classList.toggle("hidden", c);
  $("#remotePanel").classList.toggle("hidden", !c);
  if(c){
    $("#tvName").textContent = state.connected.name;
    $("#tvAvatar").textContent = (state.connected.name[0] || "T").toUpperCase();
    $("#tvMeta").textContent = `${state.connected.ip} • ${state.connected.via === "helper-adb" ? "Full control — arrows + typing" : "Basic — Home/Back quit app"}`;
    $("#heroTvName").textContent = state.connected.name;
  } else {
    $("#heroTvName").textContent = "No TV yet";
  }
  const bh = $("#bridgeHint");
  if(bh) bh.innerHTML = state.bridge
    ? `Helper OK — full remote signals ready.`
    : `Helper not found. Run <code>node server.js</code> on this phone (Termux) or any home PC, same Wi-Fi — then Scan.`;
  renderTvs();
}

// ---------- SEND (one signal per keypress, like a real remote) ----------
async function sendCommand(cmd, payload=""){
  if(!state.connected){ errToastOnce("Not connected — scan and connect first"); return; }
  const tv = state.connected;
  if(cmd === "TEXT" && !state.searchActive){
    state.word += payload;
    paintWord();
    toast(`Search off: “${payload}” buffered — turn 🔍 Search on to type`, "bad");
    return;
  }
  if(!state.bridge || !bridgeBase){ errToastOnce("Helper not running"); return; }
  try{
    const r = await fetch(`${bridgeBase}/cmd`, {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ip:tv.ip, cmd, payload}), signal:AbortSignal.timeout(10000)});
    const j = JSON.parse(await r.text());
    if(j && j.ok){ if(cmd === "TEXT") toast(`Typed “${payload}”`, "good"); flashCmd(cmd); }
    else errToastOnce(j && j.error === "diallimited" ? "Basic TV — Home/Back quit the app" : "TV ignored the key — on? Same Wi-Fi?");
  }catch{ errToastOnce("Helper unreachable"); state.bridge = false; checkBridge(); }
}
const ZONE_OF_CMD = {UP:"UP", DOWN:"DOWN", LEFT:"LEFT", RIGHT:"RIGHT", OK:"CENTER"};
function flashCmd(cmd){
  const zone = ZONE_OF_CMD[cmd];
  if(zone) $$("#dpadMini .mini-btn").forEach(b=> b.classList.toggle("active", b.dataset.zone === zone));
  $$(".dpad-btn").forEach(b=> b.classList.toggle("active", b.dataset.cmd === cmd));
  setTimeout(()=>{
    $$("#dpadMini .mini-btn").forEach(b=> b.classList.remove("active"));
    $$(".dpad-btn").forEach(b=> b.classList.remove("active"));
  }, 420);
}

// ---------- REMOTE UI ----------
$$(".dpad-btn, .qbtn").forEach(b=>{ b.onclick = ()=>{ if(b.dataset.cmd) sendCommand(b.dataset.cmd); }; });
$("#disconnectBtn").onclick = disconnect;
$("#scanBtn").onclick = ()=>{
  if(!state.bridge){ toast("Helper not found — start it first (Termux on phone, or PC)", "bad"); checkBridge(); return; }
  doScan();
};
$("#addManualBtn").onclick = async ()=>{
  const ip = $("#manualIp").value.trim();
  if(!isValidIpv4(ip)){ toast("Type a valid IP like 192.168.1.84", "bad"); return; }
  addTv({name:"Manual TV", ip});
  $("#manualIp").value = "";
  const tv = state.tvs.find(t=> t.ip === ip);
  if(tv) initiateConnect(tv);
};
$("#searchToggle").onchange = e=>{
  state.searchActive = e.target.checked;
  toast(state.searchActive ? "🔍 Search ON — drawn letters type on the TV" : "Search off — letters buffer only", state.searchActive ? "good" : "");
};
$("#sendTextBtn").onclick = ()=>{
  const v = $("#textInput").value;
  if(!v) return;
  for(const ch of v) sendCommand("TEXT", ch);
  $("#textInput").value = "";
};
$("#textInput").addEventListener("keydown", e=>{ if(e.key === "Enter") $("#sendTextBtn").click(); e.stopPropagation(); });
function paintWord(){
  $("#drawWord").textContent = state.word;
  $("#fsDrawLetter").textContent = state.word.slice(-1) || "";
}
$("#sendWordBtn").onclick = ()=>{
  if(!state.word){ toast("Word is empty — draw with ✌️ first", "bad"); return; }
  if(!state.searchActive){ toast("Turn 🔍 Search on to type the word", "bad"); return; }
  for(const ch of state.word) sendCommand("TEXT", ch);
  state.word = ""; paintWord();
};
$("#clearWordBtn").onclick = ()=>{ state.word = ""; paintWord(); $("#drawLetter").textContent = "—"; };
document.addEventListener("keydown", e=>{
  if(/INPUT|TEXTAREA/.test(e.target.tagName || "")) return;
  if(e.code === "Space"){ e.preventDefault(); const cb = $("#pauseGestures"); if(cb){ cb.checked = !cb.checked; state.pause = cb.checked; } return; }
  const map = {ArrowUp:"UP", ArrowDown:"DOWN", ArrowLeft:"LEFT", ArrowRight:"RIGHT"};
  if(map[e.key]){ e.preventDefault(); sendCommand(map[e.key]); }
  else if(e.key === "Enter") sendCommand("OK");
  else if(e.key === "Backspace") sendCommand("BACK");
  else if(e.key.toLowerCase() === "h") sendCommand("HOME");
  else if(e.key.toLowerCase() === "m") sendCommand("MUTE");
});

// ---------- SCAN (helper, quiet) ----------
async function doScan(){
  if(state.scanning) return;
  if(!state.bridge){ toast("Helper not found — start it first", "bad"); checkBridge(); return; }
  state.scanning = true;
  toast("Scanning your Wi-Fi…");
  try{
    const r = await fetchBridge("/scan", {signal:AbortSignal.timeout(8000)});
    const j = JSON.parse(await r.text());
    if(j && j.tvs) for(const t of j.tvs){
      if(!t.ip || state.tvs.some(x=> x.ip === t.ip)) continue;
      addTv({name:t.name, ip:t.ip, model:t.model || "TV"}, true);
    }
  }catch{}
  updateUI();
  if(!state.connected && state.tvs.length){
    for(const tv of state.tvs){
      const v = await validateTv(tv);
      tv._v = v;
      if(v.ok){ tv.via = v.via; if(v.name && /^tv|android/i.test(tv.name)) tv.name = v.name; }
    }
    updateUI();
    let pick = null;
    try{ const s = localStorage.getItem("savedTvIp"); pick = s && state.tvs.find(t=> t.ip === s && t._v && t._v.ok); }catch{}
    pick = pick || state.tvs.find(t=> t._v && t._v.ok);
    if(pick) connectTv(pick);
    else toast("TVs seen but quiet — TV on? Same Wi-Fi? Network debugging?", "bad");
  } else if(!state.tvs.length){
    toast("No TVs answered — TV on? Same Wi-Fi as helper?", "bad");
  }
  state.scanning = false;
  updateUI();
}

// ---------- GESTURE ENGINE ----------
function angleAt(a,b,c){
  const ux=a.x-b.x, uy=a.y-b.y, vx=c.x-b.x, vy=c.y-b.y;
  const dot=ux*vx+uy*vy, lu=Math.hypot(ux,uy), lv=Math.hypot(vx,vy);
  if(!lu || !lv) return 180;
  return Math.acos(Math.max(-1, Math.min(1, dot/(lu*lv))))*180/Math.PI;
}
const FINGER_DEFS = [{tip:4,a:2,b:3},{tip:8,a:5,b:6},{tip:12,a:9,b:10},{tip:16,a:13,b:14},{tip:20,a:17,b:18}];
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
function isTwoFinger(landmarks){
  const mask = fingerMask(landmarks);
  if(!(mask[1] === 1 && mask[2] === 1 && mask[3] === 0 && mask[4] === 0)) return false;
  const p8 = landmarks[8], p12 = landmarks[12];
  const palm = landmarks[9], wrist = landmarks[0];
  const hand = Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  if(Math.hypot(p8.x-p12.x, p8.y-p12.y) < hand*0.28) return false;
  const straight = Math.max(angleAt(landmarks[5], landmarks[6], landmarks[8]), angleAt(landmarks[9], landmarks[10], landmarks[12]));
  return straight > 160 && (palm.y - (p8.y+p12.y)/2) > -0.05;
}
function isThumbDown(landmarks){
  const mask = fingerMask(landmarks);
  if(mask[1] === 1 || mask[2] === 1 || mask[3] === 1 || mask[4] === 1) return false;
  const wrist = landmarks[0], palm = landmarks[9];
  const hand = Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  const tMcp = landmarks[2], tTip = landmarks[4];
  if(!tMcp || !tTip) return false;
  if(Math.hypot(tTip.x-wrist.x, tTip.y-wrist.y) < Math.hypot(tMcp.x-wrist.x, tMcp.y-wrist.y)*1.2) return false;
  const dropY = tTip.y - tMcp.y, sideX = Math.abs(tTip.x - tMcp.x);
  return dropY >= hand*0.25 && sideX <= dropY*0.8;
}
function isFist(landmarks){
  const mask = fingerMask(landmarks);
  if(mask[1] === 1 || mask[2] === 1 || mask[3] === 1 || mask[4] === 1) return false;
  const wrist = landmarks[0], palm = landmarks[9];
  const hand = Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  let close = 0;
  [[8,6],[12,10],[16,14],[20,18]].forEach(([tip,pip])=>{
    const t = landmarks[tip], p = landmarks[pip];
    if(t && p && Math.hypot(t.x-p.x, t.y-p.y) < hand*0.50) close++;
  });
  if(close < 3) return false;
  const tt = landmarks[4], tm = landmarks[2];
  if(tt && tm && (tt.y - tm.y) > hand*0.2) return false;
  return true;
}
function isThumbUp(landmarks){
  const mask = fingerMask(landmarks);
  if(mask[1] === 1 || mask[2] === 1 || mask[3] === 1 || mask[4] === 1) return false;
  const wrist = landmarks[0], palm = landmarks[9];
  const hand = Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  const tMcp = landmarks[2], tTip = landmarks[4];
  if(!tMcp || !tTip) return false;
  if(Math.hypot(tTip.x-wrist.x, tTip.y-wrist.y) < Math.hypot(tMcp.x-wrist.x, tMcp.y-wrist.y)*1.15) return false;
  return (tMcp.y - tTip.y) >= hand*0.22;
}
function isNavHand(landmarks){
  if(isFist(landmarks) || isThumbDown(landmarks) || isThumbUp(landmarks)) return false;
  const w = landmarks[0];
  let open = 0;
  [[8,6],[12,10]].forEach(([tip,pip])=>{
    const t = landmarks[tip], p = landmarks[pip];
    if(t && p && Math.hypot(t.x-w.x,t.y-w.y) > Math.hypot(p.x-w.x,p.y-w.y)*1.02) open++;
  });
  return open >= 1;
}
function mapZone(x, y){
  const dead = state.deadPct/100;
  const x0 = 0.5-dead/2, x1 = 0.5+dead/2, y0 = 0.5-dead/2, y1 = 0.5+dead/2;
  if(x >= x0 && x <= x1 && y >= y0 && y <= y1) return "CENTER";
  const dx = x-0.5, dy = y-0.5;
  return Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? "UP" : "DOWN") : (dx < 0 ? "LEFT" : "RIGHT");
}
const ZONE_CMD = {UP:"UP", DOWN:"DOWN", LEFT:"LEFT", RIGHT:"RIGHT"};

// letter recognizer ($1-style, A–Z 0–9)
const RN = 64;
function rdist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function rpathLength(pts){ let d = 0; for(let i = 1; i < pts.length; i++) d += rdist(pts[i-1], pts[i]); return d; }
function resample(pts, n){
  if(!pts.length) return [];
  const I = rpathLength(pts)/(n-1);
  let D = 0;
  const out = [pts[0]];
  for(let i = 1; i < pts.length; i++){
    const d = rdist(pts[i-1], pts[i]);
    if((D+d) >= I && d > 0){
      const q = {x:pts[i-1].x + ((I-D)/d)*(pts[i].x-pts[i-1].x), y:pts[i-1].y + ((I-D)/d)*(pts[i].y-pts[i-1].y)};
      out.push(q); pts.splice(i, 0, q); D = 0;
    } else D += d;
  }
  if(out.length === n-1) out.push(pts[pts.length-1]);
  while(out.length < n) out.push(pts[pts.length-1]);
  return out.slice(0, n);
}
function rnormalize(pts){
  if(!pts.length) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pts.forEach(p=>{ minX = Math.min(minX,p.x); minY = Math.min(minY,p.y); maxX = Math.max(maxX,p.x); maxY = Math.max(maxY,p.y); });
  const size = Math.max(maxX-minX, maxY-minY) || 1;
  const norm = pts.map(p=>({x:(p.x-minX)/size, y:(p.y-minY)/size}));
  let cx = 0, cy = 0;
  norm.forEach(p=>{ cx += p.x; cy += p.y; });
  cx /= norm.length; cy /= norm.length;
  return norm.map(p=>({x:p.x-cx+0.5, y:p.y-cy+0.5}));
}
function rpathDist(a,b){ let d = 0; for(let i = 0; i < a.length; i++) d += rdist(a[i], b[i]); return d/a.length; }
function tpl(...raw){
  const pts = [];
  for(let i = 0; i < raw.length; i += 2) pts.push({x:raw[i], y:raw[i+1]});
  return rnormalize(resample(pts, RN));
}
const TEMPLATES = {
  "A": tpl(20,90, 50,10, 80,90, 65,55, 35,55),
  "B": tpl(20,90, 20,10, 60,15, 60,40, 20,45, 65,55, 65,80, 20,90),
  "C": tpl(80,20, 30,15, 15,50, 30,85, 80,80),
  "D": tpl(20,90, 20,10, 60,15, 75,50, 60,85, 20,90),
  "E": tpl(80,15, 20,15, 20,90, 80,90, 20,90, 20,50, 60,50),
  "F": tpl(80,15, 20,15, 20,90, 20,50, 60,50),
  "G": tpl(80,20, 30,10, 15,50, 30,85, 75,85, 75,50, 45,50),
  "H": tpl(20,10, 20,90, 20,50, 80,50, 80,10, 80,90),
  "I": tpl(20,15, 80,15, 50,15, 50,90, 20,90, 80,90),
  "J": tpl(20,15, 80,15, 50,15, 50,80, 30,90, 20,80),
  "K": tpl(20,10, 20,90, 20,50, 80,10, 20,50, 80,90),
  "L": tpl(20,10, 20,90, 80,90),
  "M": tpl(20,90, 20,10, 50,50, 80,10, 80,90),
  "N": tpl(20,90, 20,10, 80,90, 80,10),
  "O": tpl(50,10, 15,30, 15,70, 50,90, 85,70, 85,30, 50,10),
  "P": tpl(20,90, 20,10, 65,15, 65,45, 20,50),
  "Q": tpl(50,10, 15,30, 15,70, 50,90, 85,70, 85,30, 50,10, 65,65, 85,85),
  "R": tpl(20,90, 20,10, 65,15, 65,45, 20,50, 70,90),
  "S": tpl(80,20, 30,15, 20,40, 75,55, 70,85, 20,80),
  "T": tpl(20,15, 80,15, 50,15, 50,90),
  "U": tpl(20,10, 20,70, 50,90, 80,70, 80,10),
  "V": tpl(20,10, 50,90, 80,10),
  "W": tpl(20,10, 30,90, 50,50, 70,90, 80,10),
  "X": tpl(20,10, 80,90, 50,50, 80,10, 20,90),
  "Y": tpl(20,10, 50,50, 80,10, 50,50, 50,90),
  "Z": tpl(20,15, 80,15, 20,90, 80,90),
  "0": tpl(50,10, 15,30, 15,70, 50,90, 85,70, 85,30, 50,10),
  "1": tpl(30,20, 50,10, 50,90, 20,90, 80,90),
  "2": tpl(20,30, 35,15, 70,15, 70,45, 20,90, 80,90),
  "3": tpl(20,20, 70,15, 70,45, 30,50, 70,65, 70,85, 20,80),
  "4": tpl(70,10, 20,50, 80,50, 70,10, 70,90),
  "5": tpl(80,15, 20,15, 20,50, 70,50, 70,80, 20,90),
  "6": tpl(70,15, 20,20, 15,50, 30,85, 70,85, 70,50, 20,50),
  "7": tpl(20,15, 80,15, 50,90),
  "8": tpl(50,20, 20,35, 50,50, 80,65, 50,85, 20,65, 50,50, 80,35, 50,20),
  "9": tpl(20,80, 80,80, 85,50, 70,15, 30,15, 30,50, 80,50),
};
function recognizeLetter(rawPts){
  if(!rawPts || rawPts.length < 10) return null;
  let pts = resample(rawPts.map(p=>({x:p.x, y:p.y})), RN);
  pts = rnormalize(pts);
  let best = null, bestDist = Infinity;
  for(const [letter, tmpl] of Object.entries(TEMPLATES)){
    const d = rpathDist(pts, tmpl);
    if(d < bestDist){ bestDist = d; best = letter; }
  }
  if(bestDist > 0.33) return null;
  return {letter:best, score:clamp(1 - bestDist/0.5, 0, 1)};
}

// ---------- CAMERA / OVERLAYS ----------
const video = $("#video"), overlay = $("#overlay"), zoneOverlay = $("#zoneOverlay"), videoWrap = $("#videoWrap");
const gestureLabel = $("#gestureLabel"), zoneLabel = $("#zoneLabel"), confLabel = $("#confLabel"), fpsLabel = $("#fpsLabel");
const camToggle = $("#camToggle"), mirrorToggle = $("#mirrorToggle"), showLandmarks = $("#showLandmarks");
let hands = null, camera = null, running = false, rafId = null, lastStream = null;
let _inferBusy = false, lastFpsUpdate = now(), frames = 0, _fsGridFresh = false;

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
    c.width = rect.width*dpr; c.height = rect.height*dpr;
    c.style.width = rect.width + "px"; c.style.height = rect.height + "px";
  });
  drawZones();
  clearTrail();
}
window.addEventListener("resize", resizeOverlays);
function drawZones(){
  if(!zoneOverlay) return;
  const ctx = zoneOverlay.getContext("2d");
  const dpr = window.devicePixelRatio || 1, w = zoneOverlay.width, h = zoneOverlay.height;
  ctx.clearRect(0, 0, w, h);
  const dead = state.deadPct/100;
  const cx0 = (0.5-dead/2)*w, cx1 = (0.5+dead/2)*w, cy0 = (0.5-dead/2)*h, cy1 = (0.5+dead/2)*h;
  ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = 1*dpr;
  ctx.setLineDash([6*dpr, 6*dpr]);
  ctx.strokeRect(cx0, cy0, cx1-cx0, cy1-cy0);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.font = `${11*dpr}px Inter`; ctx.textAlign = "center";
  ctx.fillText("CENTER — idle", w/2, cy0 - 8*dpr);
}
function clearTrail(){
  if(zoneOverlay){ zoneOverlay.getContext("2d").clearRect(0, 0, zoneOverlay.width, zoneOverlay.height); drawZones(); }
}
$("#cooldownRange").oninput = e=>{ state.DWELL_MS = parseInt(e.target.value); $("#cooldownVal").textContent = (state.DWELL_MS/1000) + "s"; };
$("#deadRange").oninput = e=>{ state.deadPct = parseInt(e.target.value); $("#deadVal").textContent = state.deadPct + "%"; drawZones(); _fsGridFresh = false; };
$("#pauseGestures").onchange = e=> state.pause = e.target.checked;
if(mirrorToggle) mirrorToggle.onchange = ()=> videoWrap.classList.toggle("mirror", mirrorToggle.checked);
if(videoWrap && mirrorToggle) videoWrap.classList.toggle("mirror", mirrorToggle.checked);

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
  const cx0 = (0.5-dead/2)*w, cx1 = (0.5+dead/2)*w, cy0 = (0.5-dead/2)*h, cy1 = (0.5+dead/2)*h;
  ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 2*dpr;
  ctx.setLineDash([8*dpr, 8*dpr]);
  ctx.strokeRect(cx0, cy0, cx1-cx0, cy1-cy0);
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(79,124,255,.14)"; ctx.lineWidth = 2*dpr;
  ctx.beginPath(); ctx.moveTo(cx0,0); ctx.lineTo(cx0,h); ctx.moveTo(cx1,0); ctx.lineTo(cx1,h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,cy0); ctx.lineTo(w,cy0); ctx.moveTo(0,cy1); ctx.lineTo(w,cy1); ctx.stroke();
}
function strokeTrail(ctx, pts, w, h, dpr){
  if(!pts || pts.length < 2) return;
  ctx.strokeStyle = "rgba(0,245,255,1)"; ctx.lineWidth = 4*dpr;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(0,245,255,.7)"; ctx.shadowBlur = 8*dpr;
  ctx.beginPath();
  pts.forEach((p,i)=>{ const x = p.nx*w, y = p.ny*h; if(i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
  ctx.stroke();
  ctx.shadowBlur = 0;
}
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
  const pts = landmarks.map(lm=>({x:ox + (mirror ? 1-lm.x : lm.x)*w, y:oy + lm.y*h}));
  const ctx = fsO.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0, 0, cw, ch);
  strokeFsGrid(ctx, cw, ch, dpr);
  strokeFsSkeleton(ctx, pts, dpr);
  if(state.drawing && state.drawPoints.length > 1){
    const px = state.drawPoints.map(p=>{
      const qx = mirror ? 1-p.nx : p.nx;
      return {nx:(ox + qx*vw*scale)/cw, ny:(oy + p.ny*vh*scale)/ch};
    });
    strokeTrail(ctx, px, cw, ch, dpr);
  }
  _fsGridFresh = true;
}
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
  syncFsVideo(); resizeFsOverlay(); showPage("page-zones");
  if(!running) startCamera();
}
function leaveFullscreen(){
  showPage("page-home");
  try{ if(document.exitFullscreen) document.exitFullscreen(); }catch{}
  const fsV = $("#fsVideo"); if(fsV) fsV.srcObject = null;
}
$("#enterZonesBtn").onclick = ()=> enterFullscreenGesture();
$("#exitZonesBtn").onclick = ()=> leaveFullscreen();
function resizeFsOverlay(){
  const fsO = $("#fsOverlay");
  if(!fsO) return;
  const dpr = window.devicePixelRatio || 1;
  fsO.width = window.innerWidth*dpr; fsO.height = window.innerHeight*dpr;
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
  ctx.clearRect(0, 0, w, h);
  strokeFsGrid(ctx, w, h, dpr);
  _fsGridFresh = true;
}

// dwell-to-click
function enterDwell(key){
  if(state._dwellKey !== key){ state._dwellKey = key; state._dwellStart = now(); state._dwellFired = false; }
}
function resetDwell(){
  state._dwellKey = null; state._dwellStart = 0; state._dwellFired = false;
  state._lastPalm = {px:0.5, py:0.5};
}
function dwellProgress(){
  if(!state._dwellStart) return 0;
  return clamp((now() - state._dwellStart)/state.DWELL_MS, 0, 1);
}
function drawDwellRing(prog){
  const fsO = $("#fsOverlay"), fsV = $("#fsVideo");
  if(!fsO || prog <= 0) return;
  const rect = fsO.getBoundingClientRect();
  if(rect.width < 50) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = rect.width*dpr, ch = rect.height*dpr;
  const vw = (fsV && fsV.videoWidth > 0) ? fsV.videoWidth : (video.videoWidth || 1280);
  const vh = (fsV && fsV.videoHeight > 0) ? fsV.videoHeight : (video.videoHeight || 720);
  const scale = Math.max(cw/vw, ch/vh);
  let x = state._lastPalm.px;
  if(mirrorToggle && mirrorToggle.checked) x = 1 - x;
  const sx = (cw-vw*scale)/2 + x*vw*scale, sy = (ch-vh*scale)/2 + state._lastPalm.py*vh*scale;
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

// draw handling — two-finger trail, lift to recognize + type
function handleDrawPoint(nx, ny){
  if(!state.drawing){
    state.drawing = true;
    state.drawPoints = [];
    clearTimeout(state._drawTimer); state._drawTimer = null;
    gestureHud("✌️ Drawing — lift fingers to send");
  }
  state.drawPoints.push({nx, ny});
  state.lastDrawEnd = now();
  state._stroke = state.drawPoints.slice();
  if(zoneOverlay && state.drawPoints.length > 1){
    const dpr = window.devicePixelRatio || 1;
    const ctx = zoneOverlay.getContext("2d");
    const a = state.drawPoints[state.drawPoints.length-2], b = state.drawPoints[state.drawPoints.length-1];
    ctx.strokeStyle = "rgba(0,245,255,1)"; ctx.lineWidth = 4*dpr;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(0,245,255,.7)"; ctx.shadowBlur = 8*dpr;
    ctx.beginPath();
    ctx.moveTo(a.nx*zoneOverlay.width, a.ny*zoneOverlay.height);
    ctx.lineTo(b.nx*zoneOverlay.width, b.ny*zoneOverlay.height);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
function scheduleDrawEnd(){
  if(state._drawTimer || !state.drawing) return;
  state._drawTimer = setTimeout(()=>{ state._drawTimer = null; finalizeStroke(); }, 700);
}
function finalizeStroke(){
  state.drawing = false;
  state.drawPoints = [];
  setTimeout(clearTrail, 2500);
  const pts = state._stroke || [];
  state._stroke = [];
  if(pts.length < 8){ gestureHud("Too short — draw one clear letter"); return; }
  const r = recognizeLetter(pts);
  if(!r){ gestureHud("Not recognized — draw slower, one stroke"); toast("Letter not recognized — try again", "bad"); return; }
  $("#drawLetter").textContent = r.letter;
  $("#fsDrawLetter").textContent = r.letter;
  setTimeout(()=>{ $("#drawLetter").textContent = "—"; $("#fsDrawLetter").textContent = ""; }, 2200);
  gestureHud(`Drew “${r.letter}”`);
  sendCommand("TEXT", r.letter);
}

async function initHands(){
  if(hands) return hands;
  if(typeof Hands === "undefined"){ toast("Hand tracking still loading — retry in a bit", "bad"); return null; }
  hands = new Hands({locateFile:f=> `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`});
  hands.setOptions({maxNumHands:1, modelComplexity:0, minDetectionConfidence:0.5, minTrackingConfidence:0.5});
  hands.onResults(onHandsResults);
  return hands;
}
function onHandsResults(results){
  frames++;
  const t = now();
  if(t - lastFpsUpdate > 500){
    const fps = Math.round(frames*1000/(t-lastFpsUpdate));
    if(fpsLabel) fpsLabel.textContent = fps;
    lastFpsUpdate = t; frames = 0;
  }
  if(state.pause) return;
  const ctx = overlay.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if(!results.multiHandLandmarks || !results.multiHandLandmarks.length){
    gestureHud("No hand"); setZoneHud("—");
    if(confLabel) confLabel.textContent = "—";
    resetDwell();
    if(state.drawing && (t - state.lastDrawEnd > 650)) finalizeStroke();
    if(!_fsGridFresh){ const fsO2 = $("#fsOverlay"); if(fsO2 && fsO2.width) syncFsOverlayState(); }
    return;
  }
  const landmarks = results.multiHandLandmarks[0];
  const handed = results.multiHandedness && results.multiHandedness[0] ? results.multiHandedness[0] : null;
  const confTxt = (handed ? handed.label : "Hand") + (handed && handed.score ? ` ${(handed.score*100|0)}%` : "");
  if(confLabel && confLabel._v !== confTxt){ confLabel._v = confTxt; confLabel.textContent = confTxt; }
  if(showLandmarks.checked && window.drawConnectors && window.drawLandmarks){
    ctx.save();
    if(mirrorToggle.checked){ ctx.scale(-1,1); ctx.translate(-overlay.width,0); }
    drawConnectors(ctx, landmarks, HAND_CONNECTIONS, {color:"rgba(79,124,255,.9)", lineWidth:2*dpr});
    drawLandmarks(ctx, landmarks, {color:"rgba(255,255,255,.95)", lineWidth:1, radius:3*dpr});
    ctx.restore();
  }
  fsPaint(landmarks);

  const two = isTwoFinger(landmarks);
  const fistRaw = isFist(landmarks);
  const downRaw = isThumbDown(landmarks);
  const upRaw = isThumbUp(landmarks);
  state._fistFrames = (fistRaw && !downRaw && !upRaw) ? state._fistFrames + 1 : 0;
  state._thumbDownFrames = downRaw ? state._thumbDownFrames + 1 : 0;
  state._thumbUpFrames = upRaw ? state._thumbUpFrames + 1 : 0;
  const fist = state._fistFrames >= 3, thumbDown = state._thumbDownFrames >= 3, thumbUp = state._thumbUpFrames >= 3;

  const tip = landmarks[8];
  let nx = tip.x, ny = tip.y;
  if(mirrorToggle.checked) nx = 1 - nx;
  const palm = landmarks[9];
  let px = palm.x, py = palm.y;
  if(mirrorToggle.checked) px = 1 - px;
  state._lastPalm = {px, py};
  const remain = ()=> Math.max(1, Math.ceil((1-dwellProgress())*state.DWELL_MS/1000));

  if(two && !fist && !thumbDown && !thumbUp){
    resetDwell();
    setZoneHud("DRAW");
    handleDrawPoint(nx, ny);
    return;
  }
  if(state.drawing && !two){ scheduleDrawEnd(); gestureHud("Finishing stroke…"); return; }

  if(thumbDown){
    gestureHud(`👎 Back — hold ${remain()}s`); setZoneHud("BACK");
    enterDwell("back"); drawDwellRing(dwellProgress());
    if(dwellProgress() >= 1 && !state._dwellFired){ state._dwellFired = true; sendCommand("BACK"); }
    return;
  }
  if(thumbUp || fist){
    gestureHud(`${thumbUp ? "👍" : "✊"} OK — hold ${remain()}s`); setZoneHud("OK");
    $$("#dpadMini .mini-btn").forEach(b=> b.classList.toggle("active", b.dataset.zone === "CENTER"));
    enterDwell("ok"); drawDwellRing(dwellProgress());
    if(dwellProgress() >= 1 && !state._dwellFired){ state._dwellFired = true; sendCommand("OK"); }
    return;
  }
  if(isNavHand(landmarks)){
    const zone = mapZone(px, py);
    setZoneHud(zone === "CENTER" ? "CENTER — idle" : zone);
    $$("#dpadMini .mini-btn").forEach(b=> b.classList.toggle("active", b.dataset.zone === zone));
    if(zone === "CENTER"){ gestureHud("Center idle — 👍 = OK"); resetDwell(); return; }
    gestureHud(`${zone} — hold ${remain()}s`);
    enterDwell("zone:" + zone); drawDwellRing(dwellProgress());
    if(dwellProgress() >= 1 && !state._dwellFired){ state._dwellFired = true; sendCommand(ZONE_CMD[zone]); }
  } else {
    gestureHud("Show your palm"); setZoneHud("—"); resetDwell();
  }
}

// ---------- CAMERA ----------
function isSecureForCamera(){
  return window.isSecureContext || ["localhost","127.0.0.1"].includes(location.hostname)
    || location.hostname.startsWith("192.168.") || location.hostname.startsWith("10.");
}
function showCameraError(title, details, retry=true){
  const ph = $("#videoPlaceholder");
  if(ph){
    ph.innerHTML = `<div style="padding:16px;max-width:340px;text-align:center">
      <div class="ph-icon" style="font-size:28px">⚠️</div>
      <p style="font-weight:800;margin:6px 0 4px">${title}</p>
      <small style="display:block;opacity:.75;line-height:1.5;margin-bottom:10px">${details}</small>
      ${retry ? `<button class="btn small primary" id="camRetryBtn">Try Again</button>` : ""}</div>`;
    ph.style.display = "grid";
    const rb = $("#camRetryBtn");
    if(rb) rb.onclick = ()=> startCamera();
  }
  if(videoWrap) videoWrap.classList.remove("has-video");
  setCamUI(false);
}
async function startCamera(){
  if(running) return;
  if(!isSecureForCamera()){ showCameraError("Camera needs HTTPS or same-Wi-Fi", `On <code>${location.hostname}</code> — open the <code>https://</code> site instead.`, false); return; }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ showCameraError("No camera API", "Use Chrome on Android or desktop.", false); return; }
  const h = await initHands();
  if(!h) return;
  let stream = null, lastErr = null;
  for(const c of [
    {video:{width:{ideal:1280}, height:{ideal:720}, facingMode:"user"}, audio:false},
    {video:{width:{ideal:640}, height:{ideal:480}, facingMode:"user"}, audio:false},
    {video:true, audio:false},
  ]){
    try{ stream = await navigator.mediaDevices.getUserMedia(c); break; }
    catch(e){ lastErr = e; if(e.name === "NotAllowedError") break; }
  }
  if(!stream){
    const e = lastErr || new Error("?");
    if(e.name === "NotAllowedError") showCameraError("Camera blocked", "Tap <strong>Try Again</strong>, then <strong>Allow</strong>.", true);
    else if(e.name === "NotFoundError") showCameraError("No camera", "This device has no camera.", false);
    else showCameraError("Camera busy/failed", `${e.name} — close other camera apps, then retry.`, true);
    return;
  }
  try{
    lastStream = stream;
    video.srcObject = stream;
    await video.play();
    resizeOverlays();
    if(videoWrap) videoWrap.classList.add("has-video");
    running = true; setCamUI(true);
    const ph2 = $("#videoPlaceholder");
    if(ph2) ph2.style.display = "none";
    toast("Camera on — steer with your palm", "good");
    if(typeof Camera !== "undefined"){
      camera = new Camera(video, {
        onFrame: async ()=>{
          if(_inferBusy || video.readyState < 2) return;
          _inferBusy = true;
          try{ await hands.send({image:video}); }catch{}
          _inferBusy = false;
        }, width:640, height:480,
      });
      camera.start();
    } else {
      const loop = async ()=>{
        if(!running) return;
        if(video.readyState >= 2 && !_inferBusy){
          _inferBusy = true;
          try{ await hands.send({image:video}); }catch{}
          _inferBusy = false;
        }
        rafId = requestAnimationFrame(loop);
      };
      loop();
    }
    lastFpsUpdate = now(); frames = 0;
  }catch(e){ showCameraError("Camera failed", e.message || String(e), true); setCamUI(false); }
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
  gestureHud("Camera off"); setZoneHud("—");
  overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
  drawZones();
}
if(camToggle) camToggle.onclick = ()=>{ running ? stopCamera() : startCamera(); };

// ---------- BOOT ----------
(async function boot(){
  await detectSubnet();
  paintWord();
  resizeOverlays(); drawZones(); updateUI();
  if(state.bridge) doScan();
  setTimeout(()=>{ if(state.bridge && !state.tvs.length) doScan(); }, 2500);
  window.addEventListener("beforeunload", ()=>{ if(running) stopCamera(); });
  window.TVRemote = {sendCommand, recognizeLetter};
})();
