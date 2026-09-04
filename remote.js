/* Online Remote — gesture TV remote. NO Cast, NO ADB.
   Single method: Android TV Remote v2 over the LAN helper
   (phone → helper → TV on TCP 6466/6467, same as the Google TV app).
   Scan = LAN sweep for the TV remote port. Connect = pair request →
   approve the PIN on the TV once → keys + typing work.
   Every key is a stateless signal, like a physical remote.
   Gestures: palm position = arrows, thumbs-up/fist = OK, thumbs-down = back,
   two fingers = draw letters (type when Search is on). */

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const clamp = (v,a,b)=> Math.max(a, Math.min(b,v));
const now = ()=> performance.now();

function toast(msg, type=""){
  const stack = $("#toastStack");
  if(!stack) return null;
  // Cap pile-up (screenshot bug: "Checking..." + error stacked over Pair inputs).
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
// Cloud relay key (one paste ever — invite links carry ?key= and save it).
let relayKey = "";
try{
  relayKey = localStorage.getItem("relayKey") || "";
  const qk = (new URLSearchParams(location.search).get("key") || "").trim();
  if(qk){ relayKey = qk; try{ localStorage.setItem("relayKey", relayKey); }catch{} }
}catch{}
// A "target" is host[:port] — public IP/hostname/IPv6 goes via cloud relay,
// home-LAN IPv4 goes via the LAN helper. Same box, auto-routed.
function parseTarget(input){
  const s = (input || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const m = /:(\d+)$/.exec(s);
  if(m) return {host:s.slice(0, s.length - m[0].length), port:Math.max(1, Math.min(65535, parseInt(m[1], 10) || 5555))};
  return {host:s, port:5555};
}
function isLanIpv4(h){
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h || "");
  if(!m) return false;
  const a = +m[1], b = +m[2];
  if([a, +m[3], +m[4]].some(n=> n < 0 || n > 255) || b < 0 || b > 255) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}
async function cloudApi(params, ms=10000){
  const r = await fetch(`/api/tv?key=${encodeURIComponent(relayKey)}&${params}`, {signal:AbortSignal.timeout(ms)});
  return JSON.parse(await r.text());
}
function cloudErr(j){
  const e = (j && j.error) || "";
  if(e === "bad key") return "Relay key missing — open your invite link once";
  if(e === "unreachable") return "TV not reachable — same Wi-Fi? TV awake? Remote Control enabled?";
  if(e === "not a public address (home IPs use the LAN helper)") return "That's a home IP — run the LAN helper for it";
  if(e && e.indexOf("no adb") === 0) return "TV silent — approve the PIN on the TV screen?";
  if(e && e.indexOf("send failed") === 0) return "Send failed — TV asleep? Approved on the TV?";
  return "Check failed — TV awake, same Wi-Fi, approved?";
}
function isPublicPage(){
  try{
    const h = location.hostname || "";
    if(h === "localhost" || h === "127.0.0.1") return false;
    if(h.startsWith("192.168.") || h.startsWith("10.") || h.startsWith("172.")) return false;
    return location.protocol === "https:";
  }catch{ return false; }
}
function bridgeCandidates(){
  const list = [];
  const origin = (location.origin && location.origin.startsWith("http")) ? location.origin : null;
  // On a public deploy (Railway/Vercel) the page origin is the CLOUD server —
  // it can serve the UI but can never reach 192.168.x.x. Prefer a saved LAN
  // helper first so the D-pad talks to the home network, not the cloud VPC.
  if(isPublicPage()){
    if(bridgeBase && !list.includes(bridgeBase)) list.push(bridgeBase);
    for(const u of ["http://localhost:5000"]){ if(!list.includes(u)) list.push(u); }
    if(origin && !list.includes(origin)) list.push(origin);
  } else {
    if(origin) list.push(origin);
    if(bridgeBase && !list.includes(bridgeBase)) list.push(bridgeBase);
    for(const u of ["http://localhost:5000"]){ if(!list.includes(u)) list.push(u); }
  }
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
// Validation = "is this TV real and answering?" Only then connect.
// Home-LAN IPv4 → LAN helper. Anything public → cloud relay. Auto-routed.
async function validateTv(tv){
  const t = parseTarget(tv.ip);
  if(!t.host) return {ok:false, reason:"Type your TV's address"};
  if(isLanIpv4(t.host)){
    tv._t = t;
    if(!sameSubnet(t.host)) return {ok:false, reason:`${t.host} is a different home network (${state.subnet}.0/24 here)`};
    if(!state.bridge) return {ok:false, reason:"Helper not running — start it, then Scan"};
    try{
      const r = await fetchBridge(`/validate?ip=${encodeURIComponent(t.host)}`, {signal:AbortSignal.timeout(12000)});
      const j = JSON.parse(await r.text());
      if(j && j.valid) return {ok:true, via:"helper-" + (j.via || "remote"), name:j.name || ""};
      if(j && j.needPair) return {ok:false, needPair:true, reason:`${t.host} found — approve pairing on the TV`};
      return {ok:false, reason:`${t.host} is quiet — TV on? Same Wi-Fi? Android TV Remote Control enabled on the TV?`};
    }catch{ return {ok:false, reason:"Helper unreachable"}; }
  }
  tv._t = t;
  if(!relayKey) return {ok:false, reason:"Paste your relay key below (your invite link has it)"};
  try{
    const j = await cloudApi(`action=validate&host=${encodeURIComponent(t.host)}&port=${t.port}`, 14000);
    if(j && j.valid) return {ok:true, via:"cloud", name:j.model || ""};
    return {ok:false, reason:cloudErr(j)};
  }catch{ return {ok:false, reason:"Cloud relay unreachable"}; }
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
// Pair-request flow (Remote v2, no Cast/ADB): ask the helper to ping the TV.
// The TV pops a PIN/Allow prompt → user approves → cert saved → method applied.
function setScanStatus(t){ const el = $("#scanStatus"); if(el) el.textContent = t || ""; }
async function requestTvPin(tv){
  try{
    const r = await fetchBridge("/remote-pair", {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ip:(tv._t || parseTarget(tv.ip)).host}), signal:AbortSignal.timeout(10000)});
    const j = JSON.parse(await r.text());
    if(j && j.ok && j.alreadyPaired) return "paired";
    if(j && j.ok) return "pin-sent";
    return "failed";
  }catch{ return "failed"; }
}
async function pairConnect(tv){
  if(state.connected === tv){ toast("Already connected"); return; }
  toast(`Checking ${tv.name}…`);
  const first = await validateTv(tv);
  if(first.ok){
    if(first.via) tv.via = first.via;
    if(first.name && /tv|android|roku|samsung|lg/i.test(tv.name)) tv.name = first.name || tv.name;
    connectTv(tv);
    return;
  }
  // TV found but needs approval → send the pair request (TV shows PIN),
  // then guide the user to type that PIN into the pair box once.
  if(first.needPair){
    setScanStatus(`Pair request sent to ${tv.name} — look at the TV for the PIN…`);
    toast("Pair request sent — approve on your TV screen", "good");
    const pr = await requestTvPin(tv);
    if(pr === "paired"){
      const v2 = await validateTv(tv);
      if(v2.ok){ if(v2.via) tv.via = v2.via; setScanStatus(""); connectTv(tv); return; }
    }
    if(pr === "pin-sent"){
      setScanStatus("PIN is on your TV — type it into the 6-digit code box below, tap Pair once.");
      try{
        const ph = $("#pairHost"); if(ph && !ph.value) ph.value = (tv._t || parseTarget(tv.ip)).host;
        const pc = $("#pairCode"); if(pc) pc.focus();
        if($("#connect")) $("#connect").scrollIntoView({behavior:"smooth", block:"center"});
      }catch{}
      toast("Type the TV PIN below, tap Pair", "good");
      updateUI();
      return;
    }
  }
  setScanStatus("");
  toast(first.reason || "No approval seen — TV on? Same Wi-Fi? Remote Control enabled?", "bad");
  updateUI();
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
  let raw = null, savedName = "Saved TV";
  try{ raw = localStorage.getItem("savedTvIp"); savedName = localStorage.getItem("savedTvName") || savedName; }catch{}
  if(!raw) return;
  const t = parseTarget(raw);
  if(!t.host) return;
  for(let i = 0; i < 20 && !state.subnet; i++) await new Promise(r=> setTimeout(r, 100));
  if(isLanIpv4(t.host) && !sameSubnet(t.host)) return; // different home network — keep saved for later
  if(isLanIpv4(t.host) && !state.bridge) return; // helper not up yet; checkBridge will retry us
  addTv({name:savedName, ip:raw}, true);
  const tv = state.tvs.find(x=> x.ip === raw);
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
    el.onclick = ()=> pairConnect(tv);
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
    const viaTxt = state.connected.via === "cloud" ? "Cloud relay — no helper"
      : (state.connected.via || "").indexOf("helper-") === 0 ? "TV remote — arrows + typing (approved)"
      : "TV remote";
    $("#tvMeta").textContent = `${state.connected.ip} • ${viaTxt}`;
    $("#heroTvName").textContent = state.connected.name;
  } else {
    $("#heroTvName").textContent = "No TV yet";
  }
  // Relay key is ALWAYS shown on the website (never hidden after save).
  const rk = $("#relayKey");
  if(rk && document.activeElement !== rk) rk.value = relayKey || "";
  const ks = $("#keyStatus");
  if(ks) ks.textContent = relayKey ? "✓ saved on this device — shown below" : "(paste once from your invite link — then it stays shown here)";
  const kshow = $("#keyShow");
  if(kshow) kshow.textContent = relayKey ? `Saved key: ${relayKey.slice(0,3)}…${relayKey.slice(-3)} (${relayKey.length} chars — hidden for safety)` : "";
  const tgl = $("#toggleKeyBtn");
  if(tgl && rk) tgl.textContent = rk.type === "password" ? "Show" : "Hide";
  const bh = $("#bridgeHint");
  if(bh) bh.innerHTML = state.bridge
    ? `Helper OK — TV remote signals ready. Scan auto-connects your TV.`
    : isPublicPage()
    ? `Cloud mode — your saved TV auto-connects (needs relay key + a TV reachable from the internet). For same-Wi-Fi auto-scan, run the tiny helper on this phone (Termux) or a home PC, then Scan.`
    : `Helper not found. Run <code>node helper.js</code> on this phone (Termux) or any home PC, same Wi-Fi — then Scan (auto-connects).`;
  // The helper setup box was permanently hidden (class="hidden", no JS ever
  // removed it) — so users on a public deploy with a 192.168.x.x TV were told
  // to "run the helper" with no copy-paste command visible (screenshot bug).
  // Show it whenever we're disconnected without a helper; hide once connected
  // or the helper is found.
  try{
    const hb = $("#helperBox");
    if(hb) hb.classList.toggle("hidden", !(!c && !state.bridge));
    // Prefill the pair host from the saved/manual TV so the user never has to
    // retype the IP into the wrong box (screenshot showed the IP pasted into
    // the 6-digit code field).
    const ph = $("#pairHost");
    if(ph && !ph.value){
      let saved = null;
      try{ saved = localStorage.getItem("savedTvIp") || null; }catch{}
      const manual = ($("#manualIp") || {}).value || "";
      const src = manual.trim() || saved || (state.tvs[0] && state.tvs[0].ip) || "";
      if(src) ph.value = parseTarget(src).host || src;
    }
  }catch{}
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
  const t = tv._t || parseTarget(tv.ip);
  // --- cloud relay: phone → Vercel → TV. No helper involved at all. ---
  if(tv.via === "cloud"){
    if(!relayKey){ errToastOnce("Relay key missing — open your invite link once"); return; }
    try{
      const j = await cloudApi(`action=cmd&host=${encodeURIComponent(t.host)}&port=${t.port}&cmd=${encodeURIComponent(cmd)}&payload=${encodeURIComponent(payload)}`, 12000);
      if(j && j.ok){ if(cmd === "TEXT") toast(`Typed “${payload}”`, "good"); flashCmd(cmd); }
      else errToastOnce(cloudErr(j));
    }catch{ errToastOnce("Cloud relay unreachable"); }
    return;
  }
  // --- LAN helper (Remote v2 only — no Cast, no ADB) ---
  if(!state.bridge || !bridgeBase){ errToastOnce("Helper not running"); return; }
  try{
    const r = await fetch(`${bridgeBase}/cmd`, {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ip:t.host, cmd, payload}), signal:AbortSignal.timeout(10000)});
    const j = JSON.parse(await r.text());
    if(j && j.ok){ if(cmd === "TEXT") toast(`Typed “${payload}”`, "good"); flashCmd(cmd); }
    else if(j && j.error === "need-pair"){
      errToastOnce("TV needs approval — tap Connect, approve the PIN on the TV");
      try{ pairConnect(tv); }catch{}
    }
    else errToastOnce("TV ignored the key — on? Same Wi-Fi? Approved?");
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
  if(state._cloudBusy) return;
  if(!state.bridge){ cloudRefresh(true); checkBridge(); return; }
  doScan();
};
// No-helper path: re-check every known TV through the cloud relay and
// auto-connect the first one that answers. Silent on boot, chatty on tap.
async function cloudRefresh(manual){
  if(state._cloudBusy) return;
  state._cloudBusy = true;
  const scanBtn = $("#scanBtn");
  if(scanBtn) scanBtn.disabled = true;
  try{
  let raw = null, savedName = "Saved TV";
  try{ raw = localStorage.getItem("savedTvIp"); savedName = localStorage.getItem("savedTvName") || savedName; }catch{}
  const cands = [];
  if(raw) cands.push({name:savedName, ip:raw});
  state.tvs.forEach(t=>{ if(!cands.some(c=> c.ip === t.ip)) cands.push({name:t.name, ip:t.ip}); });
  if(!cands.length){
    if(manual) toast("No TV saved yet — type your TV's public address below, tap Connect once. After that it auto-connects.", "bad");
    return;
  }
  if(!relayKey){ if(manual) toast("Paste your relay key below (your invite link has it)", "bad"); return; }
  // Home-only candidates can't go through the cloud — tell the truth instead
  // of the generic "couldn't reach" (this was the screenshot bug).
  const cloudable = cands.filter(c=>{ const t = parseTarget(c.ip); return t.host && !isLanIpv4(t.host); });
  if(!cloudable.length){
    if(manual) toast("Saved TV is a home IP — run the tiny helper (Termux / home PC), then Scan.", "warn");
    setScanStatus("Home IP detected — the cloud can't reach 192.168.x.x. Run the helper below, then Scan.");
    try{
      const hb = $("#helperBox"); if(hb) hb.classList.remove("hidden");
      const ph = $("#pairHost");
      if(ph && !ph.value && cands[0]) ph.value = parseTarget(cands[0].ip).host || "";
      const hs = $("#helperStatus");
      if(hs) hs.textContent = "Paste the command in Termux (same Wi-Fi), then tap “I've started it”.";
    }catch{}
    updateUI();
    setTimeout(()=> setScanStatus(""), 9000);
    return;
  }
  const checkingEl = manual ? toast("Checking saved TV through the cloud relay…") : null;
  if(manual) setScanStatus("Checking saved TV through the cloud relay…");
  let connected = false, lastReason = "";
  for(const c of cloudable){
    addTv({name:c.name, ip:c.ip}, true);
    const tv = state.tvs.find(x=> x.ip === c.ip);
    if(tv){
      const v = await validateTv(tv);
      if(v.ok){ if(checkingEl) checkingEl.remove(); setScanStatus(""); if(v.via) tv.via = v.via; connectTv(tv); connected = true; return; }
      if(v.reason) lastReason = v.reason;
    }
  }
  if(checkingEl) checkingEl.remove();
  setScanStatus(lastReason);
  setTimeout(()=> setScanStatus(""), 8000);
  if(manual && !connected) toast(lastReason ? `Cloud relay: ${lastReason}` : "Cloud relay couldn't reach a saved TV — TV awake? Reachable from the internet? Key correct?", "bad");
  updateUI();
  }finally{
    state._cloudBusy = false;
    if(scanBtn) scanBtn.disabled = false;
  }
}
$("#addManualBtn").onclick = async ()=>{
  const raw = $("#manualIp").value.trim();
  const t = parseTarget(raw);
  if(!t.host || !/[.:]/.test(t.host) || /\s/.test(t.host)){ toast("Type a TV address — public IP, name.ddns.net, or 192.168.1.84", "bad"); return; }
  addTv({name:"Manual TV", ip:raw});
  try{ const ph = $("#pairHost"); if(ph) ph.value = t.host; }catch{}
  $("#manualIp").value = "";
  const tv = state.tvs.find(x=> x.ip === raw);
  if(tv) pairConnect(tv);
};
// Helper setup box: previously dead buttons (no handlers) + permanently hidden.
// Wire Copy (Termux command) and "Check again" (re-probe helper, then scan).
const copyHelperBtn = $("#copyHelperBtn");
if(copyHelperBtn) copyHelperBtn.onclick = async ()=>{
  const cmd = (($("#helperCmd") || {}).textContent || "").trim();
  if(!cmd) return;
  try{ await navigator.clipboard.writeText(cmd); toast("Helper command copied — paste it in Termux", "good"); }
  catch{
    try{
      const r = document.createRange(); r.selectNodeContents($("#helperCmd"));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand("copy"); sel.removeAllRanges();
      toast("Helper command copied — paste it in Termux", "good");
    }catch{ toast("Copy failed — long-press the command to copy", "bad"); }
  }
};
const helperRetryBtn = $("#helperRetryBtn");
if(helperRetryBtn) helperRetryBtn.onclick = async ()=>{
  const hs = $("#helperStatus");
  if(hs) hs.textContent = "Looking for the helper…";
  await checkBridge();
  if(state.bridge){
    if(hs) hs.textContent = "Helper found — scanning…";
    toast("Helper found — scanning for your TV…", "good");
    doScan();
  } else {
    if(hs) hs.textContent = "Still not found — same Wi-Fi? Termux session still running?";
    toast("Helper still not found — same Wi-Fi? Termux running?", "bad");
  }
  updateUI();
};
const rkInput = $("#relayKey");
if(rkInput) rkInput.value = relayKey || "";
$("#saveKeyBtn").onclick = ()=>{
  relayKey = (($("#relayKey") || {}).value || "").trim();
  try{ localStorage.setItem("relayKey", relayKey); }catch{}
  toast(relayKey ? "Key saved — connect your TV" : "Key cleared", relayKey ? "good" : "");
  updateUI();
};
const toggleKeyBtn = $("#toggleKeyBtn");
if(toggleKeyBtn) toggleKeyBtn.onclick = ()=>{
  const inp = $("#relayKey");
  if(!inp) return;
  inp.type = inp.type === "password" ? "text" : "password";
  toggleKeyBtn.textContent = inp.type === "password" ? "Show" : "Hide";
};
const copyKeyBtn = $("#copyKeyBtn");
if(copyKeyBtn) copyKeyBtn.onclick = async ()=>{
  const v = (($("#relayKey") || {}).value || relayKey || "").trim();
  if(!v){ toast("No key to copy", "bad"); return; }
  try{ await navigator.clipboard.writeText(v); toast("Relay key copied", "good"); }
  catch{ try{ $("#relayKey").select(); document.execCommand("copy"); toast("Relay key copied", "good"); }catch{ toast("Copy failed — long-press to copy", "bad"); } }
};
$("#pairBtn").onclick = async ()=>{
  let host = (($("#pairHost") || {}).value || "").trim();
  // Backward-compat: old UI had a separate port box (now removed). Ignore it
  // if it still exists in some cached page.
  const portEl = $("#pairPort");
  const legacyPort = ((portEl || {}).value || "").trim();
  let code = (($("#pairCode") || {}).value || "").trim().replace(/\s+/g, "");
  // Screenshot bug recovery: the TV IP was pasted into the PIN box
  // (host="TV", PIN="192.168.1.84"). If the PIN box holds an IP/hostname and
  // the host box doesn't, swap them and ask for the real PIN.
  if(code && !isLanIpv4(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)){
    const asHost = parseTarget(code);
    if(asHost.host && /[.:]/.test(asHost.host)){
      host = asHost.host;
      try{ $("#pairHost").value = host; $("#pairCode").value = ""; }catch{}
      code = "";
      toast(`Moved ${host} to the address box — now tap Pair, read the PIN on the TV, type it, tap Pair again`, "warn");
    }
  }
  // Allow "192.168.1.84:6466" typed into one box.
  if(host) host = parseTarget(legacyPort && /^\d+$/.test(legacyPort) ? `${host}:${legacyPort}` : host).host || host;
  if(!host || host.toLowerCase() === "tv" || /\s/.test(host) || !/[.:a-zA-Z0-9]/.test(host)){ toast("Type the TV address first — e.g. 192.168.1.84", "bad"); return; }
  if(code && !/^\d{4,8}$/.test(code)){ toast("That PIN looks wrong — type the 4–8 digits shown on the TV", "bad"); return; }
  // Track 1 — home LAN: real TV-protocol pairing. First tap asks the TV to
  // show its PIN; second tap (with PIN typed) completes pairing. No dev mode.
  if(isLanIpv4(host) && state.bridge){
    if(!code){
      try{
        const r = await fetchBridge("/remote-pair", {method:"POST", headers:{"Content-Type":"application/json"},
          body:JSON.stringify({ip:host}), signal:AbortSignal.timeout(8000)});
        const j = JSON.parse(await r.text());
        if(j && j.ok && j.alreadyPaired){
          toast("Already paired — connecting…", "good");
          addTv({name:"Manual TV", ip:host});
          const tv = state.tvs.find(x=> x.ip === host);
          if(tv) pairConnect(tv);
        }
        else if(j && j.ok){
          toast("PIN requested — look at the TV", "good");
          setScanStatus("PIN showing on TV — type it into the code box, tap Pair again");
          const pc = $("#pairCode"); if(pc) pc.focus();
        }
        else errToastOnce((j && j.error) || "Pair start failed");
      }catch{ errToastOnce("Helper unreachable"); }
      return;
    }
    try{
      const r = await fetchBridge("/remote-code", {method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ip:host, code}), signal:AbortSignal.timeout(20000)});
      const j = JSON.parse(await r.text());
      if(j && j.ok){
        setScanStatus("");
        toast("Paired ✓ — connecting…", "good");
        addTv({name:"Manual TV", ip:host});
        const tv = state.tvs.find(x=> x.ip === host);
        if(tv) pairConnect(tv);
      }
      else errToastOnce((j && j.error) || "Pair failed");
    }catch{ errToastOnce("Helper unreachable"); }
    return;
  }
  // No cloud/ADB pairing — same-Wi-Fi TV remote only.
  if(isLanIpv4(host) && !state.bridge){
    try{
      const hb = $("#helperBox"); if(hb) hb.classList.remove("hidden");
      const hs = $("#helperStatus");
      if(hs) hs.textContent = "Start the helper first — then Pair.";
    }catch{}
    updateUI();
    toast("Start the tiny helper below first (Termux / home PC) — then Pair", "warn");
    checkBridge();
    return;
  }
  toast("Same-Wi-Fi pairing only — put the TV address in the first box (e.g. 192.168.1.84)", "bad");
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

// ---------- SCAN (helper: LAN sweep for TV remote port, no Cast/ADB) ----------
async function doScan(){
  if(state.scanning) return;
  if(!state.bridge){ toast("Helper not found — start it first", "bad"); checkBridge(); return; }
  state.scanning = true;
  toast("Scanning your Wi-Fi for TVs… (up to ~15s)");
  setScanStatus("Sweeping your Wi-Fi for the TV remote signal… keep the TV on.");
  try{
    const r = await fetchBridge("/scan", {signal:AbortSignal.timeout(30000)});
    const j = JSON.parse(await r.text());
    if(j && j.tvs) for(const t of j.tvs){
      if(!t.ip || state.tvs.some(x=> x.ip === t.ip)) continue;
      addTv({name:t.name, ip:t.ip, model:t.model || "TV"}, true);
    }
  }catch{ toast("Scan timed out — helper still sweeping, tap Scan again", "bad"); }
  setScanStatus("");
  updateUI();
  if(!state.connected && state.tvs.length){
    // Saved TV first, else the first found — pairConnect sends a test
    // pair request (TV shows Allow/PIN) and applies the method on approval.
    let pick = null;
    try{ const s = localStorage.getItem("savedTvIp"); pick = s && state.tvs.find(t=> t.ip === s); }catch{}
    pairConnect(pick || state.tvs[0]);
  } else if(!state.tvs.length){
    toast("No TVs answered — TV on? Same Wi-Fi as helper? Remote Control enabled on TV?", "bad");
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
  autoResume(); // silent auto-connect of the saved TV (cloud relay or helper)
  if(state.bridge) doScan();
  setTimeout(()=>{ if(state.bridge && !state.tvs.length) doScan(); }, 2500);
  window.addEventListener("beforeunload", ()=>{ if(running) stopCamera(); });
  window.TVRemote = {sendCommand, recognizeLetter};
})();
