/* Online Remote — gesture TV remote. One flow only:
   type TV IP → Send code to TV → type the TV code → Connect.
   Same-origin calls to the home PC (node helper.js). No cloud, no USB,
   no scan, no keys, nothing else.
   Gestures: palm position = arrows, thumbs-up/fist = OK, thumbs-down = back,
   two fingers = draw letters (type when Search is on). */

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const clamp = (v,a,b)=> Math.max(a, Math.min(b,v));
const now = ()=> performance.now();

function toast(msg, type=""){
  const stack = $("#toastStack");
  if(!stack) return null;
  while(stack.children.length >= 3) stack.firstChild.remove();
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  el.onclick = ()=> el.remove();
  stack.appendChild(el);
  setTimeout(()=> el.style.opacity = "0", 2200);
  setTimeout(()=> el.remove(), 2600);
  return el;
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
  tvs: [], connected: null, busy: false,
  searchActive: false,
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

// ---------- PAIR FLOW (the only flow: IP → code → connect) ----------
const DEFAULT_IP = "192.168.1.84";
function setPairStatus(t){ const el = $("#pairStatus"); if(el) el.textContent = t || ""; }
function getIp(){
  const v = (($("#tvIp") || {}).value || "").trim();
  const ip = v || DEFAULT_IP;
  try{ localStorage.setItem("tvIp", ip); }catch{}
  return ip;
}
function prefillIp(){
  let saved = "";
  try{ saved = localStorage.getItem("tvIp") || ""; }catch{}
  const el = $("#tvIp");
  if(el && !el.value) el.value = saved || DEFAULT_IP;
}
// Relay key for the cloud ADB path (fully-cloud, laptop off). Saved once —
// carried in invite links as ?key=, no visible box. Set the same value as
// the RELAY_KEY env var on Vercel.
let relayKey = "";
try{
  relayKey = localStorage.getItem("relayKey") || "";
  const qk = (new URLSearchParams(location.search).get("key") || "").trim();
  if(qk){ relayKey = qk; try{ localStorage.setItem("relayKey", relayKey); }catch{} }
}catch{}
function validTarget(s){
  s = (s || "").trim();
  if(!s || /\s/.test(s) || s.length > 260) return false;
  return /[0-9A-Za-z:.%-]/.test(s);
}
// Split "host", "host:port", "[v6]:port", bare IPv6 (default port 5555).
function parseHost(input){
  let s = (input || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  let m = /^\[([0-9a-fA-F:]+)\](?::(\d+))?$/.exec(s);
  if(m) return {host:m[1], port:clampPort(m[2])};
  const colons = (s.match(/:/g) || []).length;
  if(colons > 1) return {host:s, port:5555}; // bare IPv6
  m = /^(.*?):(\d+)$/.exec(s);
  if(m) return {host:m[1], port:clampPort(m[2])};
  return {host:s, port:5555};
}
function clampPort(p){
  const n = parseInt(p || "5555", 10);
  return Math.max(1, Math.min(65535, isNaN(n) ? 5555 : n));
}
// Home-LAN IPv4 goes to the home PC; global IPv6 / public names go
// through the Vercel ADB relay (works with the laptop OFF, TV on).
function isLanH(host){
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host || "");
  if(!m) return false;
  if(m.slice(1).some(o=> +o < 0 || +o > 255)) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}
async function relayApi(params, ms=15000){
  const r = await fetch(`/api/tv?key=${encodeURIComponent(relayKey)}&${params}`, {signal:AbortSignal.timeout(ms)});
  return JSON.parse(await r.text());
}
function relayErr(j){
  const e = (j && j.error) || "";
  if(e === "bad key") return "Relay key missing — open your invite link once (?key=…) and the same RELAY_KEY env must be set on Vercel.";
  if(e === "unreachable" || e.indexOf("no adb") === 0) return "TV not reachable from the internet — Wireless debugging ON? Global IPv6 or port-forward set?";
  if(e && e.indexOf("send failed") === 0) return "Send failed — TV asleep? On-TV prompt accepted?";
  if(e && e.indexOf("not a public") === 0) return "That's a home IP — it routes through the home PC instead.";
  return e || "Relay error — TV on? Reachable from the internet?";
}
async function sameOrigin(path, body, ms=25000){
  const opts = body === undefined
    ? {signal:AbortSignal.timeout(ms)}
    : {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), signal:AbortSignal.timeout(ms)};
  const r = await fetch(path, opts);
  return JSON.parse(await r.text());
}
function homePageHint(){
  return "Home page unreachable — open http://192.168.1.67:5000 on home Wi-Fi with node helper.js running on the PC.";
}
function addTv(ip, name){
  if(!ip) return null;
  let tv = state.tvs.find(x=> x.ip === ip);
  if(!tv){
    tv = {id:uid(), name:name || "TV", ip, model:"Android TV", via:"wifi"};
    state.tvs.push(tv);
  }
  if(name) tv.name = name;
  return tv;
}
function connectTv(tv){
  state.connected = tv;
  updateUI();
  toast(`Connected: ${tv.name}`, "good");
}
function disconnect(){
  state.connected = null;
  updateUI();
  toast("Disconnected");
}
// Step 1: type address → TV answers? connect at once : pair → code on TV.
// LAN IPv4 → home PC. Anything internet-reachable → cloud relay (laptop off).
async function sendPairRequest(){
  if(state.busy) return;
  const raw = getIp();
  if(!validTarget(raw)){ toast("Type the TV address first — e.g. 192.168.1.84", "bad"); return; }
  const t = parseHost(raw);
  if(!t.host){ toast("Type the TV address first — e.g. 192.168.1.84", "bad"); return; }
  state.busy = true;
  const btn = $("#sendCodeBtn");
  if(btn) btn.disabled = true;
  try{
    if(!isLanH(t.host)){ await cloudPairStart(t); return; }
    setPairStatus(`Checking ${t.host}…`);
    let v = null;
    try{ v = await sameOrigin(`/validate?ip=${encodeURIComponent(t.host)}`, undefined, 15000); }
    catch{ setPairStatus(homePageHint()); return; }
    if(v && v.valid){
      if(v.name) addTv(raw, v.name); else addTv(raw);
      setPairStatus("");
      connectTv(state.tvs.find(x=> x.ip === raw));
      return; // already paired before — straight in, no code needed
    }
    setPairStatus("Sending code to TV — look at the TV screen…");
    let p = null;
    try{ p = await sameOrigin("/remote-pair", {ip:t.host}, 12000); }
    catch{ setPairStatus(homePageHint()); return; }
    if(p && p.ok && p.alreadyPaired){
      let v2 = null;
      try{ v2 = await sameOrigin(`/validate?ip=${encodeURIComponent(t.host)}`, undefined, 15000); }catch{}
      if(v2 && v2.valid){ if(v2.name) addTv(raw, v2.name); else addTv(raw); setPairStatus(""); connectTv(state.tvs.find(x=> x.ip === raw)); return; }
    }
    if(p && p.ok){
      addTv(raw);
      setPairStatus("Code is on your TV — type it below, tap Connect.");
      toast("Code sent — read it on the TV", "good");
      const c = $("#tvCode"); if(c) c.focus();
    } else {
      setPairStatus((p && p.error) || "TV is quiet — TV ON? Same Wi-Fi as the PC? Remote enabled on TV?");
    }
  }finally{
    state.busy = false;
    if(btn) btn.disabled = false;
    updateUI();
  }
}
// Cloud path step 1: validate via relay; if the TV never saw this relay,
// guide to the TV's wireless-pair screen (host:pair-port + 6-digit code).
async function cloudPairStart(t){
  if(!relayKey){ setPairStatus("Relay key missing — open your invite link once (?key=…)."); toast("Relay key missing — open your invite link once", "bad"); return; }
  setPairStatus(`Checking ${t.host} from the cloud…`);
  let v = null;
  try{ v = await relayApi(`action=validate&host=${encodeURIComponent(t.host)}&port=${t.port}`, 15000); }
  catch{ setPairStatus("Cloud relay unreachable — Vercel function asleep? Reload and retry."); return; }
  if(v && v.valid){
    addTv(getIp(), v.model || "TV");
    setPairStatus("");
    connectTv(state.tvs.find(x=> x.ip === getIp()));
    return;
  }
  setPairStatus("TV not paired with the cloud yet — on the TV open Wireless debugging → “Pair device with pairing code”, then type host:pair-port above and the 6-digit code below, tap Connect.");
  toast("TV needs wireless pairing — see the TV screen", "warn");
}
// Step 2: type the TV code → Connect.
// LAN → home-PC code (digits or A–F). Cloud → wireless-pairing 6-digit code
// (type host:pair-port above when pairing for the first time).
async function submitCode(){
  if(state.busy) return;
  const raw = getIp();
  if(!validTarget(raw)){ toast("Type the TV address first — e.g. 192.168.1.84", "bad"); return; }
  const t = parseHost(raw);
  const code = (($("#tvCode") || {}).value || "").trim().replace(/\s+/g, "");
  if(!isLanH(t.host)){ await cloudSubmitCode(t, code, raw); return; }
  // If the TV was already paired, Connect works with no code at all.
  if(!code){
    state.busy = true;
    try{
      setPairStatus(`Checking ${t.host}…`);
      let v = null;
      try{ v = await sameOrigin(`/validate?ip=${encodeURIComponent(t.host)}`, undefined, 15000); }
      catch{ setPairStatus(homePageHint()); return; }
      if(v && v.valid){
        if(v.name) addTv(raw, v.name); else addTv(raw);
        setPairStatus("");
        connectTv(state.tvs.find(x=> x.ip === raw));
      } else {
        setPairStatus("TV needs a code — tap Send code to TV first.");
      }
    }finally{ state.busy = false; updateUI(); }
    return;
  }
  if(!/^[0-9A-Fa-f]{4,8}$/.test(code)){ toast("That code looks wrong — type the characters shown on the TV (digits, A–F ok)", "bad"); return; }
  state.busy = true;
  const btn = $("#connectBtn");
  if(btn) btn.disabled = true;
  try{
    setPairStatus("Sending code…");
    let j = null;
    try{ j = await sameOrigin("/remote-code", {ip:t.host, code}, 25000); }
    catch{ setPairStatus(homePageHint()); return; }
    if(j && j.ok){
      try{ $("#tvCode").value = ""; }catch{}
      toast("Paired ✓ — connecting…", "good");
      let v = null;
      try{ v = await sameOrigin(`/validate?ip=${encodeURIComponent(t.host)}`, undefined, 15000); }catch{}
      if(v && v.name) addTv(raw, v.name); else addTv(raw);
      setPairStatus("");
      connectTv(state.tvs.find(x=> x.ip === raw));
    } else {
      setPairStatus((j && j.error) || "Wrong code — tap Send code to TV for a fresh one.");
    }
  }finally{
    state.busy = false;
    if(btn) btn.disabled = false;
    updateUI();
  }
}
async function cloudSubmitCode(t, code, raw){
  if(!relayKey){ toast("Relay key missing — open your invite link once", "bad"); setPairStatus("Relay key missing — open your invite link once (?key=…)."); return; }
  state.busy = true;
  const btn = $("#connectBtn");
  if(btn) btn.disabled = true;
  try{
    if(!code){
      setPairStatus(`Checking ${t.host} from the cloud…`);
      let v = null;
      try{ v = await relayApi(`action=validate&host=${encodeURIComponent(t.host)}&port=${t.port}`, 15000); }
      catch{ setPairStatus("Cloud relay unreachable — reload and retry."); return; }
      if(v && v.valid){
        addTv(raw, v.model || "TV");
        setPairStatus("");
        connectTv(state.tvs.find(x=> x.ip === raw));
      } else {
        setPairStatus(relayErr(v));
      }
      return;
    }
    if(!/^\d{6}$/.test(code)){ toast("Wireless pairing codes are 6 digits — read the TV's pair screen", "bad"); return; }
    if(t.port === 5555){
      setPairStatus("First wireless pair needs the pairing port too — type host:pair-port (both shown on the TV's pair screen) above, code below, tap Connect again.");
      return;
    }
    setPairStatus("Pairing from the cloud…");
    let j = null;
    try{ j = await relayApi(`action=pair&host=${encodeURIComponent(t.host)}&port=${t.port}&code=${encodeURIComponent(code)}`, 15000); }
    catch{ setPairStatus("Cloud relay unreachable — reload and retry."); return; }
    if(j && j.ok){
      try{ $("#tvCode").value = ""; }catch{}
      try{ $("#tvIp").value = t.host; }catch{}
      toast("Cloud-paired ✓ — connecting…", "good");
      let v = null;
      try{ v = await relayApi(`action=validate&host=${encodeURIComponent(t.host)}&port=5555`, 15000); }catch{}
      if(v && v.valid){
        addTv(t.host, v.model || "TV");
        setPairStatus("");
        connectTv(state.tvs.find(x=> x.ip === t.host));
      } else {
        setPairStatus("Paired — now tap Connect once more (port 5555).");
      }
    } else {
      setPairStatus(relayErr(j));
    }
  }finally{
    state.busy = false;
    if(btn) btn.disabled = false;
    updateUI();
  }
}
function renderTvs(){
  const list = $("#tvList");
  if(!list) return;
  const others = state.tvs.filter(t=> t !== state.connected);
  list.innerHTML = others.length ? "" : `<div style="color:var(--muted);font-size:.85em">Connected TVs show here.</div>`;
  others.forEach(tv=>{
    const el = document.createElement("div");
    el.className = "tv-item";
    el.innerHTML = `<div class="tv-avatar">${(tv.name[0] || "T").toUpperCase()}</div>
      <div class="tv-item-main"><div class="tv-item-name">${tv.name}</div>
      <div class="tv-item-meta">${tv.ip}</div></div>
      <button class="btn small primary">Connect</button>`;
    el.onclick = ()=>{
      try{ $("#tvIp").value = tv.ip; }catch{}
      submitCode();
    };
    list.appendChild(el);
  });
}
function updateUI(){
  const c = !!state.connected;
  const pill = $("#connPill"), ctxt = $("#connText");
  if(pill) pill.classList.toggle("connected", c);
  if(ctxt) ctxt.textContent = c ? state.connected.name : "Not connected";
  const cp = $("#connectedPanel"), rp = $("#remotePanel");
  if(cp) cp.classList.toggle("hidden", c);
  if(rp) rp.classList.toggle("hidden", !c);
  if(c){
    const tn = $("#tvName"), ta = $("#tvAvatar"), tm = $("#tvMeta"), hn = $("#heroTvName");
    if(tn) tn.textContent = state.connected.name;
    if(ta) ta.textContent = (state.connected.name[0] || "T").toUpperCase();
    if(tm) tm.textContent = `${state.connected.ip} • paired`;
    if(hn) hn.textContent = state.connected.name;
  } else {
    const hn = $("#heroTvName");
    if(hn) hn.textContent = "No TV yet";
  }
  renderTvs();
}

// ---------- SEND (one signal per keypress, like a real remote) ----------
async function sendCommand(cmd, payload=""){
  if(!state.connected){ errToastOnce("Not connected — pair first"); return; }
  const tv = state.connected;
  if(cmd === "TEXT" && !state.searchActive){
    state.word += payload;
    paintWord();
    toast(`Search off: “${payload}” buffered — turn 🔍 Search on to type`, "bad");
    return;
  }
  try{
    const t = parseHost(tv.ip || "");
    // Fully-cloud path: Vercel ADB relay straight to the TV (laptop off).
    if(t.host && !isLanH(t.host)){
      if(!relayKey){ errToastOnce("Relay key missing — open your invite link once"); return; }
      const p = (cmd === "TEXT")
        ? `action=cmd&host=${encodeURIComponent(t.host)}&port=${t.port}&cmd=TEXT&payload=${encodeURIComponent(payload || "")}`
        : `action=cmd&host=${encodeURIComponent(t.host)}&port=${t.port}&cmd=${encodeURIComponent(cmd)}`;
      let j = null;
      try{ j = await relayApi(p, 15000); }
      catch{ errToastOnce("Cloud relay unreachable"); return; }
      if(j && j.ok){ if(cmd === "TEXT") toast(`Typed “${payload}”`, "good"); flashCmd(cmd); }
      else errToastOnce(relayErr(j));
      return;
    }
    const j = await sameOrigin("/cmd", {ip:t.host || tv.ip, cmd, payload:payload || ""}, 12000);
    if(j && j.ok){ if(cmd === "TEXT") toast(`Typed “${payload}”`, "good"); flashCmd(cmd); }
    else if(j && j.error === "need-pair"){
      errToastOnce("TV needs approval again — type the IP, tap Send code to TV");
      disconnect();
    }
    else errToastOnce("TV ignored the key — on? Approved?");
  }catch{ errToastOnce(homePageHint()); }
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
const _discBtn = $("#disconnectBtn");
if(_discBtn) _discBtn.onclick = disconnect;
const _sendCodeBtn = $("#sendCodeBtn");
if(_sendCodeBtn) _sendCodeBtn.onclick = sendPairRequest;
const _connectBtn = $("#connectBtn");
if(_connectBtn) _connectBtn.onclick = submitCode;
const _tvCode = $("#tvCode");
if(_tvCode) _tvCode.addEventListener("keydown", e=>{ if(e.key === "Enter") submitCode(); e.stopPropagation(); });
const _tvIp = $("#tvIp");
if(_tvIp) _tvIp.addEventListener("keydown", e=>{ if(e.key === "Enter") sendPairRequest(); e.stopPropagation(); });
const _searchToggle = $("#searchToggle");
if(_searchToggle) _searchToggle.onchange = e=>{
  state.searchActive = e.target.checked;
  toast(state.searchActive ? "🔍 Search ON — drawn letters type on the TV" : "Search off — letters buffer only", state.searchActive ? "good" : "");
};
const _sendTextBtn = $("#sendTextBtn");
if(_sendTextBtn) _sendTextBtn.onclick = ()=>{
  const v = $("#textInput").value;
  if(!v) return;
  for(const ch of v) sendCommand("TEXT", ch);
  $("#textInput").value = "";
};
const _textInput = $("#textInput");
if(_textInput) _textInput.addEventListener("keydown", e=>{ if(e.key === "Enter") $("#sendTextBtn").click(); e.stopPropagation(); });
function paintWord(){
  const dw = $("#drawWord"), fl = $("#fsDrawLetter");
  if(dw) dw.textContent = state.word;
  if(fl) fl.textContent = state.word.slice(-1) || "";
}
const _sendWordBtn = $("#sendWordBtn");
if(_sendWordBtn) _sendWordBtn.onclick = ()=>{
  if(!state.word){ toast("Word is empty — draw with ✌️ first", "bad"); return; }
  if(!state.searchActive){ toast("Turn 🔍 Search on to type the word", "bad"); return; }
  for(const ch of state.word) sendCommand("TEXT", ch);
  state.word = ""; paintWord();
};
const _clearWordBtn = $("#clearWordBtn");
if(_clearWordBtn) _clearWordBtn.onclick = ()=>{ state.word = ""; paintWord(); const dl = $("#drawLetter"); if(dl) dl.textContent = "—"; };
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

// ---------- BOOT (static shell + gesture preload, no backend calls) ----------
function bootProgress(pct, step){
  const f = $("#bootFill"), s = $("#bootStep");
  if(f) f.style.width = Math.max(5, Math.min(100, pct)) + "%";
  if(s && step) s.textContent = step;
}
const BOOT_TIPS = [
  "Tip: type the TV IP, send the code, type it back — connected.",
  "Tip: 👍 thumbs-up = OK, 👎 thumbs-down = Back.",
  "Tip: hold your palm steady in a grid zone to click.",
  "Tip: ✌️ two fingers draws letters when search is open.",
  "Tip: one approval on the TV, then it remembers.",
];
let _tipTimer = null;
function bootTips(){
  let i = 0;
  const el = $("#bootTip");
  clearInterval(_tipTimer);
  _tipTimer = setInterval(()=>{
    i = (i + 1) % BOOT_TIPS.length;
    if(el) el.textContent = BOOT_TIPS[i];
  }, 2100);
}
function hideSplash(){
  clearInterval(_tipTimer);
  bootProgress(100, "Ready ✓");
  setTimeout(()=>{
    const sp = $("#bootSplash");
    if(sp){ sp.classList.add("done"); setTimeout(()=> sp.remove(), 500); }
  }, 250);
}
(async function boot(){
  const t0 = now();
  const splash = $("#bootSplash");
  if(splash) splash.addEventListener("click", hideSplash, {once:true});
  bootTips();
  try{
    bootProgress(12, "Preparing offline cache…");
    try{
      if("serviceWorker" in navigator && (location.protocol === "https:" || ["localhost","127.0.0.1"].includes(location.hostname))){
        navigator.serviceWorker.register("sw.js?v=5", {updateViaCache:"none"}).then(r=>{ try{ r.update(); }catch{} }).catch(()=>{});
      }
    }catch{}
    bootProgress(46, "Loading gesture engine…");
    try{ if(typeof Hands !== "undefined") await initHands(); }catch{}
    bootProgress(80, "Ready…");
    prefillIp();
    paintWord();
    try{ resizeOverlays(); drawZones(); }catch{}
    updateUI();
    bootProgress(94, "Ready — pair your TV to begin");
  }catch{}
  const wait = Math.max(0, 1400 - (now() - t0));
  setTimeout(hideSplash, wait);
  setTimeout(()=>{ const sp = $("#bootSplash"); if(sp){ sp.classList.add("done"); setTimeout(()=> sp.remove(), 500); } }, 8000);
  window.addEventListener("beforeunload", ()=>{ if(running) stopCamera(); });
  window.TVRemote = {sendCommand, recognizeLetter};
})();
