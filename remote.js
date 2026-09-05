/* Online Remote — gesture TV remote, USB-ADB only (static hosting).
   No Cast, no cloud relay, no LAN helper, no terminal.
   Single method: built-in ADB in this site (WebUSB via adb-site.js).
   Plug TV with USB cable → Add USB device → Allow on TV → keys work.
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
  tvs: [], connected: null, scanning: false,
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

// ---------- USB TV LIST + CONNECT (built-in ADB only) ----------
function setScanStatus(t){ const el = $("#scanStatus"); if(el) el.textContent = t || ""; }
function setUsbStatus(t){ const el = $("#usbStatus"); if(el) el.textContent = t || ""; }
function addUsbTv(picked){
  if(!picked) return null;
  const ip = picked.id || `usb:${picked.serial}`;
  let tv = state.tvs.find(x=> x.ip === ip);
  if(!tv){
    tv = {id:uid(), name:picked.productName || picked.name || "USB TV", ip, model:(picked.productName || "USB ADB").slice(0,32), via:"usb-adb"};
    state.tvs.push(tv);
  }
  tv._usb = picked;
  tv.name = picked.productName || picked.name || tv.name;
  tv.model = (picked.productName || "USB ADB").slice(0, 32);
  tv.via = "usb-adb";
  return tv;
}
async function scanSiteUsb(quiet){
  if(!window.SiteAdb) return 0;
  let sup = null;
  try{ sup = window.SiteAdb.supported(); }catch{ sup = {ok:false}; }
  if(!sup || !sup.ok){ if(!quiet) setUsbStatus(sup ? sup.reason : "USB unavailable here"); return 0; }
  try{
    if(!quiet) setUsbStatus("Checking USB devices plugged into this device…");
    const found = await window.SiteAdb.scanUsb(setUsbStatus);
    (found || []).forEach(p=> addUsbTv(p));
    if(!quiet){
      if(found && found.length) setUsbStatus(`Found ${found.length} USB device(s) — tap Connect.`);
      else setUsbStatus("No USB device yet — plug the TV in, enable USB debugging, tap “Add USB device”.");
      setTimeout(()=> setUsbStatus(""), 7000);
    }
    updateUI();
    return (found || []).length;
  }catch(e){
    if(!quiet){ setUsbStatus(String((e && e.message) || e).slice(0, 120)); setTimeout(()=> setUsbStatus(""), 7000); }
    return 0;
  }
}
async function connectUsbTv(tv){
  if(!window.SiteAdb){ toast("Built-in ADB still loading — retry in a second", "bad"); return; }
  const sup = window.SiteAdb.supported();
  if(!sup.ok){ toast(sup.reason, "bad"); return; }
  try{
    let picked = tv._usb;
    if(!picked || typeof picked._raw?.connect !== "function"){
      setUsbStatus("Opening USB picker — choose your TV…");
      toast("Choose your TV in the USB picker");
      picked = await window.SiteAdb.pickUsb(setUsbStatus);
      if(!picked){ setUsbStatus(""); return; }
      tv = addUsbTv(picked) || tv;
      tv._usb = picked;
    }
    setUsbStatus("Linking USB ADB — approve “Allow USB debugging” on the TV…");
    toast(`Linking ${tv.name}… approve on the TV`);
    const info = await window.SiteAdb.connectUsb(picked || tv._usb, setUsbStatus);
    if(info && info.productName) { tv.name = info.productName.slice(0, 40); tv.model = info.productName.slice(0, 32); }
    tv.via = "usb-adb";
    setUsbStatus("");
    connectTv(tv);
  }catch(e){
    setUsbStatus(String((e && e.message) || e).slice(0, 140));
    toast(String((e && e.message) || e).slice(0, 140), "bad");
    setTimeout(()=> setUsbStatus(""), 9000);
  }
  updateUI();
}
function connectTv(tv){
  state.connected = tv;
  updateUI();
  toast(`Connected: ${tv.name}`, "good");
}
function disconnect(){
  state.connected = null;
  try{ if(window.SiteAdb) window.SiteAdb.disconnect(); }catch{}
  updateUI();
  toast("Disconnected");
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
    el.onclick = ()=>{ if(tv.via === "wifi") wifiConnect(tv); else connectUsbTv(tv); };
    list.appendChild(el);
  });
  try{ renderWifiList(); }catch{}
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
    if(tm) tm.textContent = `${state.connected.ip} • ${state.connected.via === "wifi" ? "Wi-Fi pair — home network" : "USB ADB — from this site"}`;
    if(hn) hn.textContent = state.connected.name;
  } else {
    const hn = $("#heroTvName");
    if(hn) hn.textContent = "No TV yet";
  }
  renderTvs();
}

// ---------- SEND (USB ADB only) ----------
async function sendCommand(cmd, payload=""){
  if(!state.connected){ errToastOnce("Not connected — scan and connect first"); return; }
  const tv = state.connected;
  if(cmd === "TEXT" && !state.searchActive){
    state.word += payload;
    paintWord();
    toast(`Search off: “${payload}” buffered — turn 🔍 Search on to type`, "bad");
    return;
  }
  if(!window.SiteAdb || !window.SiteAdb.isConnected()){
    // Wi-Fi TVs don't use USB ADB — route to the home-PC helper instead.
    if(tv.via === "wifi" && LAN_PAGE){
      try{
        if(cmd === "TEXT"){
          for(const ch of String(payload || "")) await wifiPost("/cmd", {ip:tv.ip, cmd:"TEXT", payload:ch}, 12000);
          toast(`Typed “${payload}”`, "good");
        } else {
          const j = await wifiPost("/cmd", {ip:tv.ip, cmd, payload:""}, 12000);
          if(!(j && j.ok)){
            if(j && j.error === "need-pair"){ errToastOnce("TV needs approval — tap Pair, type the TV code"); try{ wifiConnect(tv); }catch{} return; }
            errToastOnce("TV ignored the key — on? Approved?");
            return;
          }
        }
        flashCmd(cmd);
      }catch{ errToastOnce("Home PC unreachable — is node helper.js running?"); }
      return;
    }
    errToastOnce("USB ADB not linked — tap Connect on the USB TV");
    try{ connectUsbTv(tv); }catch{}
    return;
  }
  try{
    if(cmd === "TEXT"){
      for(const ch of String(payload || "")) await window.SiteAdb.sendText(ch);
      toast(`Typed “${payload}”`, "good");
    } else {
      const code = (window.SiteAdb.KEYEVENT || {})[cmd];
      if(!code){ errToastOnce("Unsupported key"); return; }
      await window.SiteAdb.sendKeyevent(code);
    }
    flashCmd(cmd);
  }catch(e){ errToastOnce("USB send failed — cable? TV awake? (" + String((e && e.message) || e).slice(0, 80) + ")"); }
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
const _scanBtn = $("#scanBtn");
if(_scanBtn) _scanBtn.onclick = ()=>{ if(!state.scanning) doScan(); };
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

// ---------- USB UI WIRING ----------
function wireSiteAdbUI(){
  const scanUsbBtn = $("#scanUsbBtn");
  if(scanUsbBtn) scanUsbBtn.onclick = async ()=>{
    if(state.scanning) return;
    await scanSiteUsb(false);
  };
  const addUsbBtn = $("#addUsbBtn");
  if(addUsbBtn) addUsbBtn.onclick = async ()=>{
    if(!window.SiteAdb){ toast("Built-in ADB still loading…", "bad"); return; }
    const sup = window.SiteAdb.supported();
    if(!sup.ok){ toast(sup.reason, "bad"); setUsbStatus(sup.reason); return; }
    try{
      setUsbStatus("Opening USB picker — choose your TV…");
      const picked = await window.SiteAdb.pickUsb(setUsbStatus);
      if(!picked){ setUsbStatus("Picker closed — no device chosen."); setTimeout(()=> setUsbStatus(""), 5000); return; }
      const tv = addUsbTv(picked);
      updateUI();
      if(tv) connectUsbTv(tv);
    }catch(e){ setUsbStatus(String((e && e.message) || e).slice(0, 140)); }
  };
  const discUsbBtn = $("#disconnectUsbBtn");
  if(discUsbBtn) discUsbBtn.onclick = async ()=>{
    try{ if(window.SiteAdb) await window.SiteAdb.disconnect(); }catch{}
    if(state.connected) disconnect(); else updateUI();
    setUsbStatus("USB ADB unlinked.");
    setTimeout(()=> setUsbStatus(""), 4000);
  };
  try{
    if(window.SiteAdb && window.SiteAdb.onChange){
      window.SiteAdb.onChange((snap)=>{
        const dot = $("#usbDot"), txt = $("#usbText");
        if(dot) dot.style.background = snap.connected ? "var(--good)" : "var(--muted)";
        if(txt) txt.textContent = snap.connected ? `USB: ${snap.product || snap.serial}` : "USB: not linked";
        const box = $("#usbStateBox");
        if(box) box.classList.toggle("on", !!snap.connected);
      });
    }
  }catch{}
  try{
    if(window.SiteAdb){
      const sup = window.SiteAdb.supported();
      setUsbStatus(sup.ok ? "" : sup.reason);
    }
  }catch{}
}
try{ wireSiteAdbUI(); }catch{}
if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", ()=>{ try{ wireSiteAdbUI(); }catch{} });

// ---------- WI-FI PAIR FLOW (same-origin home-PC page only) ----------
// Active ONLY when this page is served from the home network
// (http://192.168.x.x:5000, http://10.x:5000, localhost). On the public
// Vercel link this whole block stays dormant and hidden: browsers cannot
// reach a home TV from the internet, so there is nothing to attempt there.
// Flow: Scan → TV IP auto-found → Pair request → TV shows 6-digit code →
// type code → Connect. Strictly that, nothing else.
function isLanPage(){
  try{
    const h = location.hostname || "";
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]"
      || h.startsWith("192.168.") || h.startsWith("10.")
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  }catch{ return false; }
}
const LAN_PAGE = isLanPage();
function setWifiStatus(t){ const el = $("#wifiStatus"); if(el) el.textContent = t || ""; }
async function wifiGet(path, ms=30000){
  const r = await fetch(path, {signal:AbortSignal.timeout(ms)});
  return JSON.parse(await r.text());
}
async function wifiPost(path, body, ms=25000){
  const r = await fetch(path, {method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body || {}), signal:AbortSignal.timeout(ms)});
  return JSON.parse(await r.text());
}
function addWifiTv(ip, name){
  if(!ip) return null;
  let tv = state.tvs.find(x=> x.ip === ip);
  if(!tv){
    tv = {id:uid(), name:name || "Wi-Fi TV", ip, model:"Android TV", via:"wifi"};
    state.tvs.push(tv);
  }
  tv.via = "wifi";
  if(name) tv.name = name;
  return tv;
}
function renderWifiList(){
  const list = $("#wifiList");
  if(!list) return;
  const wifis = state.tvs.filter(t=> t.via === "wifi" && t !== state.connected);
  list.innerHTML = wifis.length ? "" : `<div style="color:var(--muted);font-size:.85em">No Wi-Fi TV yet — tap Scan.</div>`;
  wifis.forEach(tv=>{
    const el = document.createElement("div");
    el.className = "tv-item";
    el.innerHTML = `<div class="tv-avatar">${(tv.name[0] || "W").toUpperCase()}</div>
      <div class="tv-item-main"><div class="tv-item-name">${tv.name}</div>
      <div class="tv-item-meta">${tv.ip} • Wi-Fi pair</div></div>
      <button class="btn small primary">Pair</button>`;
    el.onclick = ()=> wifiConnect(tv);
    list.appendChild(el);
  });
}
async function wifiScan(quiet){
  if(!LAN_PAGE) return 0;
  try{
    if(!quiet){ setWifiStatus("Sweeping home Wi-Fi for the TV… (up to ~15s)"); toast("Scanning home Wi-Fi…"); }
    const j = await wifiGet("/scan", 35000);
    let n = 0;
    if(j && j.tvs) for(const t of j.tvs){
      if(!t.ip) continue;
      addWifiTv(t.ip, t.name || "Android TV");
      n++;
    }
    if(!quiet){
      setWifiStatus(n ? `Found ${n} TV(s) — tap Pair, read the code on the TV.` : "No TV answered — TV ON? Same Wi-Fi as this PC?");
      setTimeout(()=> setWifiStatus(""), 8000);
    }
    updateUI();
    return n;
  }catch(e){
    if(!quiet){ setWifiStatus("Scan failed — is node helper.js running on the home PC?"); setTimeout(()=> setWifiStatus(""), 8000); }
    return 0;
  }
}
async function wifiConnect(tv){
  if(state.connected === tv){ toast("Already connected"); return; }
  try{
    setWifiStatus(`Checking ${tv.ip}…`);
    const v = await wifiGet(`/validate?ip=${encodeURIComponent(tv.ip)}`, 15000);
    if(v && v.valid){
      if(v.name) tv.name = v.name;
      setWifiStatus("");
      connectTv(tv);
      return;
    }
    // TV found but unpaired → send the pair request; TV shows the code.
    const p = await wifiPost("/remote-pair", {ip:tv.ip}, 10000);
    if(p && p.ok && p.alreadyPaired){
      const v2 = await wifiGet(`/validate?ip=${encodeURIComponent(tv.ip)}`, 15000);
      if(v2 && v2.valid){ if(v2.name) tv.name = v2.name; setWifiStatus(""); connectTv(tv); return; }
    }
    if(p && p.ok){
      state.wifiIp = tv.ip;
      setWifiStatus(`Code is on your TV screen — type the 6 digits below, tap Connect with code.`);
      toast("Pair request sent — read the code on the TV", "good");
      const wc = $("#wifiCode"); if(wc) wc.focus();
    } else {
      setWifiStatus((p && p.error) || "Pair request failed — TV ON? Same Wi-Fi?");
    }
  }catch{ setWifiStatus("Home PC unreachable — is node helper.js running?"); }
  updateUI();
}
async function wifiSubmitCode(){
  const code = (($("#wifiCode") || {}).value || "").trim().replace(/\s+/g, "");
  const ip = state.wifiIp || (state.tvs.find(t=> t.via === "wifi") || {}).ip;
  if(!ip){ toast("Tap Scan first so the TV is found", "bad"); return; }
  if(!/^[0-9A-Fa-f]{4,8}$/.test(code)){ toast("That code looks wrong — type the 4–8 characters shown on the TV (digits, A–F ok)", "bad"); return; }
  try{
    setWifiStatus("Sending code…");
    const j = await wifiPost("/remote-code", {ip, code}, 25000);
    if(j && j.ok){
      setWifiStatus("");
      try{ $("#wifiCode").value = ""; }catch{}
      toast("Paired ✓ — connecting…", "good");
      const tv = addWifiTv(ip);
      const v = await wifiGet(`/validate?ip=${encodeURIComponent(ip)}`, 15000).catch(()=>null);
      if(v && v.name && tv) tv.name = v.name;
      if(tv) connectTv(tv);
    } else {
      setWifiStatus((j && j.error) || "Wrong code — tap Pair again for a fresh one.");
    }
  }catch{ setWifiStatus("Home PC unreachable — is node helper.js running?"); }
  updateUI();
}
function wireWifiUI(){
  if(!LAN_PAGE) return; // public link: box stays hidden, nothing wired
  const box = $("#wifiBox");
  if(box) box.classList.remove("hidden");
  const sb = $("#wifiScanBtn");
  if(sb) sb.onclick = ()=>{ if(!state.scanning) wifiScan(false); };
  const pb = $("#wifiPairBtn");
  if(pb) pb.onclick = wifiSubmitCode;
  const wc = $("#wifiCode");
  if(wc) wc.addEventListener("keydown", e=>{ if(e.key === "Enter") wifiSubmitCode(); e.stopPropagation(); });
}
try{ wireWifiUI(); }catch{}
if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", ()=>{ try{ wireWifiUI(); if(LAN_PAGE && !state.connected) wifiScan(true); }catch{} });
else if(LAN_PAGE && !state.connected) setTimeout(()=>{ try{ wifiScan(true); }catch{} }, 1200);

// ---------- SCAN (USB only — everything happens in this page) ----------
async function doScan(){
  if(state.scanning) return;
  state.scanning = true;
  const scanBtn = $("#scanBtn");
  if(scanBtn) scanBtn.disabled = true;
  setScanStatus("Scanning USB devices from this site…");
  toast("Scanning USB devices…");
  try{
    const n = await scanSiteUsb(true).catch(()=> 0);
    if(LAN_PAGE){ try{ await wifiScan(true); }catch{} }
    setScanStatus("");
    updateUI();
    const usbTvs = state.tvs.filter(t=> t.via === "usb-adb");
    const wifiTvs = state.tvs.filter(t=> t.via === "wifi");
    if(!state.connected && usbTvs.length){
      connectUsbTv(usbTvs[0]);
    } else if(!state.connected && wifiTvs.length){
      wifiConnect(wifiTvs[0]);
    } else if(!state.connected && !usbTvs.length){
      const sup = (window.SiteAdb && window.SiteAdb.supported()) || {ok:false, reason:""};
      toast(sup.ok
        ? "Nothing found — plug the TV via USB, enable USB debugging, tap “Add USB device”"
        : sup.reason || "USB not available in this browser — use Chrome/Edge.", "bad");
      if(!sup.ok) setUsbStatus(sup.reason || "");
    }
  }finally{
    state.scanning = false;
    if(scanBtn) scanBtn.disabled = false;
    updateUI();
  }
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

// ---------- BOOT (static site: offline cache + gesture preload, no backend) ----------
function bootProgress(pct, step){
  const f = $("#bootFill"), s = $("#bootStep");
  if(f) f.style.width = Math.max(5, Math.min(100, pct)) + "%";
  if(s && step) s.textContent = step;
}
const BOOT_TIPS = [
  "Tip: plug the TV with a USB cable and enable USB debugging.",
  "Tip: 👍 thumbs-up = OK, 👎 thumbs-down = Back.",
  "Tip: hold your palm steady in a grid zone to click.",
  "Tip: ✌️ two fingers draws letters when search is open.",
  "Tip: approve “Allow USB debugging” on the TV once — it remembers.",
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
        navigator.serviceWorker.register("sw.js").catch(()=>{});
      }
    }catch{}
    bootProgress(46, "Loading gesture engine…");
    try{ if(typeof Hands !== "undefined") await initHands(); }catch{}
    bootProgress(80, "Ready…");
    paintWord();
    try{ resizeOverlays(); drawZones(); }catch{}
    updateUI();
    try{
      if(window.SiteAdb){
        const sup = window.SiteAdb.supported();
        setUsbStatus(sup.ok ? "" : sup.reason);
      }
    }catch{}
    bootProgress(94, "Ready — tap Scan to connect");
  }catch{}
  const wait = Math.max(0, 1400 - (now() - t0));
  setTimeout(hideSplash, wait);
  setTimeout(()=>{ const sp = $("#bootSplash"); if(sp){ sp.classList.add("done"); setTimeout(()=> sp.remove(), 500); } }, 8000);
  window.addEventListener("beforeunload", ()=>{ if(running) stopCamera(); });
  window.TVRemote = {sendCommand, recognizeLetter};
})();
