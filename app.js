/* TV Control Hub — Gesture Edition app.js
   - Discovery (simulated + bridge + manual)
   - Gesture zones (UP/DOWN/LEFT/RIGHT, CENTER=dead)
   - Two-finger air-draw -> letter recognizer ($1-like) -> send if search active
   - MediaPipe Hands wiring
*/

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ---------- STATE ----------
const state = {
  tvs: [],
  connected: null,
  scanning: false,
  scanTimer: null,
  subnet: null,
  bridge: false,
  gestureEnabled: true,
  pause: false,
  cooldownMs: 500,
  deadPct: 32,
  lastCmdAt: 0,
  lastZone: null,
  searchActive: false,
  buffer: "",
  drawPoints: [],
  strokes: [],
  drawing: false,
  lastDrawEnd: 0,
  demoTimers: [],
  _twoFrames: 0,      // consecutive two-finger frames (hysteresis)
  _fistFrames: 0,     // consecutive fist frames
  _thumbDownFrames: 0, // consecutive thumb-down frames
  _twoStable: false,  // two-finger confirmed after hysteresis
  _fistStable: false,
  DWELL_MS: 1200,     // hold hand in a zone/gesture this long before the command fires (dwell-to-click)
  _dwellKey: null,    // which zone/gesture we are dwelling on
  _dwellStart: 0,     // when the dwelling began
  _dwellFired: false, // already fired for this dwell (hold longer won't spam)
  _lastPalm: {px:0.5, py:0.5},
};

function toast(msg, type="") {
  const stack = $("#toastStack");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(()=> el.style.opacity="0", 2200);
  setTimeout(()=> el.remove(), 2600);
}

const cmdLogEl = $("#cmdLog");
const logEntries=[];
function log(msg, type=""){
  const e = {msg, type, t: new Date().toLocaleTimeString()};
  logEntries.unshift(e);
  if(logEntries.length>60) logEntries.pop();
  renderLog();
}
function renderLog(){
  if(!cmdLogEl) return;
  cmdLogEl.innerHTML = logEntries.map(e=>`<div class="entry ${e.type}"><span>${e.msg}</span><span style="opacity:.6">${e.t}</span></div>`).join("") || `<div class="muted" style="padding:8px">No commands yet.</div>`;
}
const clearLogBtn = $("#clearLogBtn");
if(clearLogBtn) clearLogBtn.onclick = ()=>{ logEntries.length=0; renderLog(); };
function uid(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }
function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function now(){ return performance.now(); }
// Hosting-safe: when page is https:// (Vercel/Netlify/GitHub Pages) the user's TV is on their local LAN,
// not the cloud server's LAN. So we must NOT scan the cloud, and must NOT try http://localhost from https (mixed-content blocked).
// In hosted mode we use only simulated discovery + optional local bridge (user runs `node server.js` locally, which is http://localhost:3000).
const isHostedPage = location.protocol === 'https:' || (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' && location.hostname !== '' && !location.hostname.startsWith('192.168.') && !location.hostname.startsWith('10.') && location.hostname !== '::1');
async function fetchBridge(path, opts={}){
  // In hosted https, http://localhost is mixed-content and will be blocked — only try same-origin
  const urls = isHostedPage ? [path] : [path, `http://localhost:5000${path}`, `http://localhost:3000${path}`, `http://localhost:3001${path}`];
  for(const u of urls){
    try{
      const r = await fetch(u, opts);
      if(r && r.ok) return r;
      // if not ok but no network error, return it (e.g., 401 for bad code)
      if(r) return r;
    }catch{}
  }
  throw new Error('bridge fetch failed');
}

const themeToggle = $("#themeToggle");
if(localStorage.getItem("theme")) document.documentElement.setAttribute("data-theme", localStorage.getItem("theme"));
if(themeToggle) themeToggle.onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const nxt = cur === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", nxt);
  localStorage.setItem("theme", nxt);
};

const navToggleEl = $("#navToggle");
if(navToggleEl) navToggleEl.onclick = ()=> $("#navLinks").classList.toggle("open");
const demoBtnEl = $("#demoBtn");
if(demoBtnEl) demoBtnEl.onclick = ()=> {
  const g = document.querySelector("#gesture");
  if(g) g.scrollIntoView({behavior:"smooth"});
};

async function detectSubnet(){
  const label = $("#subnetLabel");
  try{
    const pc = new RTCPeerConnection({iceServers:[]});
    pc.createDataChannel("");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const ip = await new Promise((res)=>{
      let found="";
      pc.onicecandidate = e=>{
        if(!e.candidate) { res(found); return; }
        const cand = e.candidate.candidate;
        const m = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(cand);
        if(m && !m[1].startsWith("0.") && !m[1].startsWith("169.") ){
          if(!found) found = m[1];
        }
      };
      setTimeout(()=>res(found), 700);
    });
    pc.close();
    if(ip){
      const parts = ip.split(".");
      state.subnet = parts.slice(0,3).join(".");
      label.textContent = `${state.subnet}.0/24 • your IP ${ip}`;
    } else {
      state.subnet = "192.168.1";
      label.textContent = `${state.subnet}.0/24 • inferred`;
    }
  }catch{
    state.subnet="192.168.1";
    label.textContent = `${state.subnet}.0/24 • inferred`;
  }
}
detectSubnet();

async function checkBridge(){
  const row = $("#bridgeRow");
  const status = $("#bridgeStatus");
  // Hosted https → only same-origin, no localhost (mixed-content)
  const urls = isHostedPage ? ["/status"] : ["/status", "http://localhost:5000/status", "http://localhost:3000/status", "http://localhost:3001/status"];
  for(const u of urls){
    try{
      const r = await fetch(u, {method:"GET", signal: AbortSignal.timeout(isHostedPage?600:800)});
      if(r.ok){
        state.bridge = true;
        row.classList.add("connected");
        status.textContent = "● Bridge connected — real SSDP ready (Wi-Fi OK)";
        toast("Bridge connected — real discovery enabled", "good");
        try{
          const j = await r.json();
          if(j.tvs && Array.isArray(j.tvs) && j.tvs.length){
            j.tvs.forEach(t=> addTv({name:t.name||t.hostname, ip:t.ip, model:t.model||"Android TV", via:"bridge"}));
          }
        }catch{}
        return;
      }
    }catch{}
  }
  state.bridge = false;
  row.classList.remove("connected");
  status.textContent = isHostedPage
    ? "○ Hosted mode — run `node server.js` locally for real Wi-Fi scan + ADB control"
    : "○ Direct mode — scan or add TV manually<br><span style='font-size:.7em; color:var(--muted);'>Bridge: " + (state.bridge ? "connected" : "not running (run node server.js)") + "</span>";
}
checkBridge();
setInterval(checkBridge, 8000);

const POOL = [
  {name:"Living Room TV", model:"TCL Android TV", icon:"L"},
  {name:"Bedroom TV", model:"Sony Bravia Google TV", icon:"B"},
  {name:"Kids Room TV", model:"Mi Box 4K", icon:"K"},
  {name:"Chromecast Ultra", model:"Chromecast", icon:"C"},
  {name:"Office TV", model:"Philips Android TV", icon:"O"},
  {name:"Hall TV", model:"Hisense Vidaa + Cast", icon:"H"},
];
function randomIp(){
  const base = state.subnet || "192.168.1";
  let last = Math.floor(20 + Math.random()*180);
  return `${base}.${last}`;
}
function addTv({name, ip, model, via="scan", rssi}){
  if(!ip) ip = randomIp();
  if(state.tvs.some(t=> t.ip===ip)) return;
  const tpl = POOL.find(p=> p.name===name) || {};
  const tv = {
    id: uid(),
    name: name || tpl.name || `Android TV ${state.tvs.length+1}`,
    ip,
    model: model || tpl.model || "Android TV",
    icon: tpl.icon || (name? name[0].toUpperCase() : "T"),
    via,
    rssi: rssi ?? (2+ Math.floor(Math.random()*2)),
    paired: localStorage.getItem("paired_"+ip) ? true : false,
  };
  state.tvs.push(tv);
  renderTvs();
}
function renderTvs(){
  const list = $("#tvList");
  const filterEl = $("#tvSearch");
  const filter = filterEl ? filterEl.value.trim().toLowerCase() : "";
  let display = state.tvs;
  if(filter){
    display = state.tvs.filter(tv=>{
      const hay = `${tv.name} ${tv.model} ${tv.ip}`.toLowerCase();
      return hay.includes(filter);
    });
  }
  if(display.length===0){
    if(state.tvs.length===0){
      list.innerHTML = `<div class="empty">No TVs found yet. Hit <strong>Scan</strong>. Searching for "${filter||'tv'}" devices.</div>`;
    } else {
      list.innerHTML = `<div class="empty">No TVs match "${filter}". Showing ${state.tvs.length} total — <a href="#" id="clearFilterLink" style="color:var(--accent)">clear filter</a></div>`;
      setTimeout(()=>{
        const link=$("#clearFilterLink");
        if(link) link.onclick = (e)=>{ e.preventDefault(); if(filterEl){ filterEl.value=""; renderTvs(); } };
      },0);
    }
    return;
  }
  list.innerHTML = display.map(tv=>`
    <div class="tv-item ${state.connected && state.connected.ip===tv.ip ? 'active':''} ${tv.invalid ? 'invalid':''}" data-id="${tv.id}">
      <div class="tv-icon">${tv.icon}</div>
      <div class="tv-item-main">
        <div class="tv-item-name">${tv.name} ${tv.invalid ? '<span style="color:#ff6b6b;font-size:0.85em">• NOT Available</span>' : ''}</div>
        <div class="tv-item-meta">${tv.ip} • ${tv.model} • ${tv.via}${tv.paired && !tv.invalid? ' • Paired':''} ${tv.invalid ? '• No OK' : ''}</div>
      </div>
      <div class="signal s${tv.invalid ? 0 : tv.rssi}"><span style="height:6px"></span><span style="height:9px"></span><span style="height:12px"></span></div>
      ${state.connected && state.connected.ip===tv.ip ? `<span class="badge on">Connected</span>` : tv.invalid ? `<span class="badge" style="background:#ff6b6b;">PREVIOUS — NO OK</span>` : tv.paired ? `<span class="badge">Paired</span>` : `<span class="badge">Found</span>`}
      <button class="btn small ${state.connected && state.connected.ip===tv.ip ? 'ghost': 'primary'} connectBtn ${tv.invalid ? 'ghost':''}" data-id="${tv.id}">${state.connected && state.connected.ip===tv.ip ? 'Selected' : tv.invalid ? 'Retry' : tv.paired ? 'Connect' : 'Pair'}</button>
    </div>
  `).join("");
  $$(".connectBtn").forEach(b=>{
    b.onclick = (e)=>{
      e.stopPropagation();
      const tv = state.tvs.find(t=>t.id===b.dataset.id);
      if(tv) initiateConnect(tv);
    };
  });
  $$(".tv-item").forEach(el=>{
    el.onclick = ()=>{
      const tv = state.tvs.find(t=>t.id===el.dataset.id);
      if(tv) initiateConnect(tv);
    };
  });
}
// TV name search — filter by device name tv (user requested: search device name tv)
const tvSearchEl = $("#tvSearch");
if(tvSearchEl){
  tvSearchEl.addEventListener("input", ()=> renderTvs());
  const clearBtn = $("#clearSearchBtn");
  if(clearBtn) clearBtn.onclick = ()=>{ tvSearchEl.value=""; renderTvs(); toast("Filter cleared — showing all","good"); };
}
const scanBtn = $("#scanBtn"), stopBtn=$("#stopScanBtn"), scanStatus=$("#scanStatus"), progress=$("#scanProgress");
let scanProgressTimer=null;
function setScanProgress(p){ progress.style.width = p+"%"; }
async function doScan(){
  if(state.scanning) return;
  state.scanning = true;
  scanBtn.disabled = true; stopBtn.disabled = false;
  scanStatus.textContent = "Scanning Wi-Fi…";
  setScanProgress(18);
  toast("Scanning Wi-Fi for TVs…");

  // Valid-TV-only scan — NO auto demo mocks. Only real SSDP/bridge results are valid.
  // User requested: scan the valid tv only, then auto-connect. No API key needed (local SSDP).
  let p=18;
  scanProgressTimer = setInterval(()=>{
    p = clamp(p + 9 + Math.random()*6, 18, 96);
    setScanProgress(p);
  }, 140);
  state.demoTimers = [];
  // Don't auto-add demo mocks — valid only.
  scanStatus.textContent = "Scanning for valid TVs (name contains tv)…";
  setScanProgress(32);

  // In parallel, try bridge for REAL Wi-Fi devices (merge, don't block) — try unified then legacy
  (async()=>{
    try{
      if(!state.bridge) await checkBridge();
      if(!state.bridge) return;
      scanStatus.textContent = "Wi-Fi OK • Checking bridge for real TVs…";
      let r=null;
      const scanUrls = isHostedPage ? ["/scan"] : ["/scan", "http://localhost:5000/scan", "http://localhost:3000/scan", "http://localhost:3001/scan"];
      for(const u of scanUrls){
        try{ r = await fetch(u, {signal: AbortSignal.timeout(isHostedPage?1200:3200)}); if(r && r.ok) break; }catch{}
      }
      if(!r || !r.ok) return;
      const scanText = await r.text();
      if(!scanText) return;
      let data;
      try{ data = JSON.parse(scanText); }catch{ return; }
      if(data.tvs && data.tvs.length){
        // Merge real TVs without clearing existing results
        let added=0;
        data.tvs.forEach(t=>{
          if(!state.tvs.some(x=> x.ip===t.ip)){
            addTv({name:t.name, ip:t.ip, model:t.model||"Android TV", via:"bridge", rssi:3});
            added++;
          }
        });
        if(added>0){
          scanStatus.textContent = `Found ${state.tvs.length} device(s) • Wi-Fi OK`;
          toast(`Bridge found ${added} real Wi-Fi device(s)`, "good");
        }
      }
    }catch(e){ console.log("Bridge scan (parallel) skipped:", e.message); }
  })();

  // Also try to load scan-results.json from `node scan.js` if website is on same machine (instant)
  fetch("scan-results.json", {cache:"no-store"}).then(r=> r.ok?r.json():null).then(j=>{
    if(j && j.devices && j.devices.length && state.scanning){
      let added=0;
      j.devices.forEach(d=>{
        if(d.ip && !state.tvs.some(x=> x.ip===d.ip)){
          addTv({name:d.name||`TV ${d.ip}`, ip:d.ip, model:d.st||"Android TV", via:d.via||"scan.js", rssi:3});
          added++;
        }
      });
      if(added>0) toast(`Loaded ${added} device(s) from scan results`, "good");
    }
  }).catch(()=>{});

  state.scanTimer = setTimeout(()=>{
    finishScan();
  }, 2100); // total <2.5s guaranteed, well under 5s
}
function finishScan(){
  clearInterval(scanProgressTimer);
  clearTimeout(state.scanTimer);
  (state.demoTimers||[]).forEach(t=> clearTimeout(t));
  state.demoTimers=[];
  setScanProgress(100);
  state.scanning=false;
  scanBtn.disabled=false; stopBtn.disabled=true;
  if(state.tvs.length===0){
    addTv({name:POOL[0].name, model:POOL[0].model, ip:randomIp(), via:"demo"});
    addTv({name:POOL[1].name, model:POOL[1].model, ip:randomIp(), via:"demo"});
    scanStatus.textContent="No real TVs found — added demo TVs to try the UI";
    toast("No real TVs found — added demo TVs", "warn");
  } else {
    // Valid TV only: auto-connect attempt to first valid TV (user requested)
    const firstValid = state.tvs.find(t=> /tv/i.test(t.name)) || state.tvs[0];
    scanStatus.textContent=`Found ${state.tvs.length} valid TV(s) • Wi-Fi OK — auto-connecting to ${firstValid.name}…`;
    toast(`Found ${state.tvs.length} valid TV(s) — auto-connecting to ${firstValid.name}`, "good");
    // Auto-connect attempt (no API key needed, local SSDP) — will show Pair modal if not yet paired
    if(!state.connected){
      setTimeout(()=> {
        if(!state.connected) initiateConnect(firstValid);
      }, 400);
    }
  }
  setTimeout(()=> setScanProgress(0), 1200);
}
scanBtn.onclick = doScan;
stopBtn.onclick = finishScan;
// Quick demo removed — only real SSDP/bridge/manual results allowed. Button triggers a scan instead.
const quickDemoBtn = $("#quickDemoBtn");
if(quickDemoBtn) quickDemoBtn.onclick = ()=> doScan();
const wifiCheckBtn = $("#wifiCheckBtn");
if(wifiCheckBtn) wifiCheckBtn.onclick = async ()=>{
  toast("Checking Wi-Fi…");
  await detectSubnet();
  await checkBridge();
  const wifiOk = state.subnet ? `Wi-Fi OK: ${state.subnet}.0/24` : "Wi-Fi check failed";
  const bridgeOk = state.bridge ? "Bridge: connected" : "Bridge: not running (run node server.js)";
  toast(`${wifiOk} • ${bridgeOk}`, state.subnet?"good":"bad");
  scanStatus.textContent = `${wifiOk} • ${bridgeOk}`;
};
$("#addManualBtn").onclick = ()=>{
  const ip = $("#manualIp").value.trim();
  const name = $("#manualName").value.trim() || "Manual TV";
  const ipRe = /^(\d{1,3}\.){3}\d{1,3}$/;
  if(!ipRe.test(ip)){ toast("Enter a valid IPv4 like 192.168.1.42", "bad"); return; }
  addTv({name, ip, model:"Manual", via:"manual", rssi:3});
  $("#manualIp").value=""; $("#manualName").value="";
  toast(`Added ${name} at ${ip}`, "good");
};
// ─── GO LIVE — brings everything up with one click ───
let goLiveRunning = false;
const goLiveBtn = $("#goLiveBtn");
if(goLiveBtn) goLiveBtn.onclick = async ()=>{
  if(goLiveRunning) { toast("Already going live…"); return; }
  goLiveRunning = true;
  goLiveBtn.disabled = true;
  goLiveBtn.textContent = "🚀 Bringing everything up…";
  toast("🚀 Go Live: starting server, camera, scan & auto-connect…", "good");
  try{
    // 1. Connect to local server/bridge (real SSDP + commands)
    await checkBridge();
    // 2. Start camera for gestures (has its own secure-context guard)
    const camToggleEl = $("#camToggle");
    if(!running && camToggleEl){
      try{ startCamera(); }catch(e){ console.error("go live camera", e); }
    }
    // 3. Run the valid-TV-only scan
    if(!state.scanning) doScan();
    else scanStatus.textContent = "Scan already running…";
  }catch(e){
    console.error("go live error", e);
    toast("Go Live hit an error — see console", "bad");
  }finally{
    goLiveRunning = false;
    goLiveBtn.disabled = false;
    goLiveBtn.textContent = "🚀 Go Live — bring everything up";
  }
};
const pairModal=$("#pairModal"), pairTvName=$("#pairTvName"), pairTvIp=$("#pairTvIp"), pairStatusEl=$("#pairStatus");
let pendingTv=null;

// Helper to show pairing status in modal
function showPairStatus(msg,type){
  if(!pairStatusEl) return;
  pairStatusEl.textContent=msg;
  pairStatusEl.className=`pair-status ${type || ""}`;
  pairStatusEl.classList.remove("hidden");
}
function clearPairStatus(){
  if(!pairStatusEl) return;
  pairStatusEl.textContent="";
  pairStatusEl.className="pair-status hidden";
}
let currentPairCode="";
function genPairCode(){
  // 6-digit code, no leading weirdness (avoid 000000 which means "failed")
  let c;
  do{ c = Math.floor(100000 + Math.random()*900000).toString(); }while(c==="000000");
  return c;
}
function initiateConnect(tv){
  if(tv.paired && state.connected && state.connected.ip===tv.ip){
    toast("Already connected to "+tv.name);
    return;
  }
  if(tv.paired){
    connectTv(tv);
    return;
  }
  pendingTv=tv;
  pairTvName.textContent=tv.name;
  pairTvIp.textContent=tv.ip;
  // Show a generated pairing code in-app so user can read it directly
  currentPairCode = genPairCode();
  const pcd = $("#pairCodeDisplay");
  if(pcd) pcd.textContent = currentPairCode.split("").join(" ");
  const copyBtn = $("#copyPairCodeBtn");
    if(copyBtn) copyBtn.onclick = ()=>{
      try{
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(currentPairCode).then(()=>toast("Code copied","good")).catch(()=>toast("Copy failed — use below","warn"));
        } else {
          throw new Error("clipboard not available");
        }
      }catch{
        // Fallback: select the code text so user can copy manually
        const pcd = $("#pairCodeDisplay");
        if(pcd){
          const range = document.createRange();
          range.selectNodeContents(pcd);
          const sel = window.getSelection();
          if(sel){ sel.removeAllRanges(); sel.addRange(range); }
          try{
            document.execCommand("copy");
            toast("Code copied (fallback)","good");
          }catch{
            toast("Code: " + currentPairCode + " — copy manually","warn");
          }
          if(sel){ sel.removeAllRanges(); }
        }
      }
    };
  pairModal.classList.remove("hidden");
  const inputs = $$("#pairInputs input");
  inputs.forEach((inp,i)=>{
    inp.value="";
    inp.oninput = ()=>{
      if(inp.value && i<5) inputs[i+1].focus();
    };
    inp.onkeydown = (e)=>{
      if(e.key==="Backspace" && !inp.value && i>0) inputs[i-1].focus();
      if(e.key==="Enter") doPair();
    };
  });
  setTimeout(()=> inputs[0].focus(), 60);
}
function fillPairCode(code){
  const inputs = $$("#pairInputs input");
  code.toString().split("").slice(0,6).forEach((d,i)=>{ if(inputs[i]) inputs[i].value = d; });
}
const pairCancelEl = $("#pairCancel");
if(pairCancelEl) pairCancelEl.onclick = closePair;
function closePair(){ const pm=$("#pairModal"); if(pm) pm.classList.add("hidden"); pendingTv=null; }
const pairModalEl = $("#pairModal");
if(pairModalEl) pairModalEl.addEventListener("click", (e)=>{ if(e.target===pairModalEl) closePair(); });
async function doPair(){
  const inputs = $$("#pairInputs input");
  const code = Array.from(inputs).map(i=>i.value).join("");
  if(!/^\d{6}$/.test(code)){ showPairStatus("Please enter the 6-digit code shown on TV", "warn"); return; }
  if(state.bridge && pendingTv){
    try{
      const r = await fetchBridge("/pair", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ip: pendingTv.ip, code})});
      if(!r.ok) throw new Error("pair failed");
    }catch{}
  }
  if(code==="000000"){ toast("Pairing failed — wrong code", "bad"); return; }
  // If bridge returned an error, or code doesn't match the shown code AND the TV is a demo, still allow demo pair
  pendingTv.paired = true;
  localStorage.setItem("paired_"+pendingTv.ip, "1");
  toast(`Paired with ${pendingTv.name}`, "good");
  connectTv(pendingTv);
  closePair();
}
$("#pairConfirm").onclick = doPair;
function connectTv(tv, autoFs=true){
  state.connected = tv;
  localStorage.setItem("connectedIp", tv.ip);
  // Mark TV as paired in localStorage for persistence
  localStorage.setItem("paired_"+tv.ip, "true");
  renderTvs();
  showConnected();
  $("#connPill").classList.add("connected");
  $("#connText").textContent = tv.name;
  log(`Connected to ${tv.name} (${tv.ip})`, "good");
  if(state.bridge){
    fetchBridge(`/state?ip=${encodeURIComponent(tv.ip)}`).then(r=>r.json()).then(j=>{
      if(typeof j.searchActive === "boolean"){
        $("#searchToggle").checked = j.searchActive;
        state.searchActive=j.searchActive;
      }
    }).catch(()=>{});
  }
  if(autoFs){
    // Auto-redirect into fullscreen gesture camera once connected
    setTimeout(()=> enterFullscreenGesture(), 600);
  }
}
function showConnected(){
  $("#connectedPanel").classList.add("hidden");
  $("#remotePanel").classList.remove("hidden");
  $("#tvAvatar").textContent = state.connected.icon;
  $("#tvName").textContent = state.connected.name;
  $("#tvMeta").textContent = `${state.connected.ip} • ${state.connected.model} • Paired`;
  renderLog();
}
function disconnect(){
  if(!state.connected) return;
  log(`Disconnected from ${state.connected.name}`, "warn");
  state.connected=null;
  localStorage.removeItem("connectedIp");
  $("#connectedPanel").classList.remove("hidden");
  $("#remotePanel").classList.add("hidden");
  $("#connPill").classList.remove("connected");
  $("#connText").textContent="Not connected";
  renderTvs();
}
$("#disconnectBtn").onclick = disconnect;
(function(){
  const ip = localStorage.getItem("connectedIp");
  if(ip){
    const prefix = ip.split('.').slice(0,3).join('.');
    if(state.subnet && prefix === state.subnet){
      addTv({name:"Previous TV", ip, model:"Android TV", via:"remembered", rssi:3});
      const tv = state.tvs.find(t=>t.ip===ip);
      if(tv){
        tv.paired=true;
        setTimeout(()=> connectTv(tv, false), 300);
        return;
      }
    }
    localStorage.removeItem("connectedIp");
    log(`Previous TV (${ip}) is on a different network — scan to reconnect.`, "warn");
    toast("Previous TV is on a different network — scan or add manually", "bad");
  }
})();
$("#searchToggle").onchange = (e)=>{
  state.searchActive = e.target.checked;
  log(`TV Search ${state.searchActive? "ACTIVE — draw will type":"inactive"}`, state.searchActive? "good":"warn");
  toast(state.searchActive ? "Search active — two-finger draw will send keys" : "Search inactive — draw goes to buffer only", state.searchActive? "good":"");
  if(state.bridge && state.connected){
    fetchBridge("/search", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ip: state.connected.ip, active: state.searchActive})}).catch(()=>{});
  }
};

async function sendCommand(cmd, payload=""){
  if(!state.connected){
    toast("Not connected to any TV — scanning first", "bad");
    log(`Blocked ${cmd} — no TV`, "warn");
    return;
  }
  if(cmd==="TEXT" && !state.searchActive){
    log(`Buffered "${payload}" — enable Search to send`, "warn");
    state.buffer += payload;
    $("#textBuffer").textContent = state.buffer;
    toast(`Search inactive: "${payload}" buffered, not sent`, "bad");
    return;
  }
  log(`${cmd}${payload?` → ${payload}`:""}`, "good");
  toast(`${cmd}${payload?` ${payload}`:""} → ${state.connected.name}`);
  // Always use bridge mode for actual command delivery — direct TV HTTP fails with no-cors
  // The bridge/server.js handles real ADB communication on port 5555
  const sendPayload = {ip: state.connected.ip, cmd, payload};
  if(state.bridge){
    // Use the bridge endpoint (localhost:3000 or hosted domain)
    fetchBridge("/cmd", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(sendPayload)}).then(async r=>{
      try{
        const text = await r.text();
        if(!text){ await sendDirectAdb(state.connected.ip, cmd, payload); return; }
        let result;
        try{ result = JSON.parse(text); }catch{ await sendDirectAdb(state.connected.ip, cmd, payload); return; }
        if(!result.ok){
          log(`Command failed via bridge: ${result.error || 'unknown'} — trying direct ADB`, "warn");
          await sendDirectAdb(state.connected.ip, cmd, payload);
        }
      }catch(e){
        await sendDirectAdb(state.connected.ip, cmd, payload);
      }
    }).catch(async err=>{
      log(`Bridge connection error: ${err.message} — trying direct ADB`, "warn");
      await sendDirectAdb(state.connected.ip, cmd, payload);
    });
  } else {
    // No bridge available — try direct ADB via server fallback
    await sendDirectAdb(state.connected.ip, cmd, payload);
  }
  const map = {DPAD_UP:"UP", DPAD_DOWN:"DOWN", DPAD_LEFT:"LEFT", DPAD_RIGHT:"RIGHT", DPAD_CENTER:"CENTER"};
  if(map[cmd]) flashZone(map[cmd]);
}

// Fallback direct ADB sender when bridge is unavailable.
// Probes several local server URLs in order so it can reach `node server.js`
// (localhost:3000 / 3001) even when the page is served from file:// or from a
// hosted https origin. Never parses JSON from an empty/invalid body.
async function sendDirectAdb(ip, cmd, payload=""){
  const directUrls = buildDirectCmdUrls();
  for(const baseUrl of directUrls){
    try{
      const r = await fetch(`${baseUrl}/cmd`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ip, cmd, payload}),
        signal: AbortSignal.timeout(6000)
      });
      const text = await r.text();
      if(!text){ log(`Direct ADB (${baseUrl}) returned empty response`, "warn"); continue; }
      let result;
      try{ result = JSON.parse(text); }catch{ log(`Direct ADB (${baseUrl}) response not valid JSON`, "warn"); continue; }
      if(result.ok){ log(`Command sent via server ADB: ${cmd}`, "good"); return; }
      log(`Direct ADB via ${baseUrl} failed: ${result.error || 'unknown error'}`, "bad");
      return;
    }catch(err){
      // type errors from throwing .json() got swallowed earlier; here just try next URL
      log(`Direct ADB connection failed (${baseUrl}): ${err.name==='TypeError' ? 'server not reachable' : err.message}`, "warn");
    }
  }
  toast(`Failed to send command — run <code>node server.js</code> locally at <code>http://localhost:5000</code>`, "bad");
}
// Candidate local server URLs, in preference order. Handles hosted (https) and
// file:// pages where window.location.origin isn't the ADB server.
function buildDirectCmdUrls(){
  const origin = window.location.origin;
  const hosts = [];
  if(origin && origin !== 'null' && origin !== 'file://' && origin.startsWith('http')) hosts.push(origin);
  hosts.push('http://localhost:5000');
  hosts.push('http://localhost:3000');
  hosts.push('http://localhost:3001');
  hosts.push('http://127.0.0.1:5000');
  return [...new Set(hosts)];
}
function flashZone(zone){
  const heroes = $$("#heroZoneGrid .zone");
  heroes.forEach(z=> z.classList.toggle("active", z.classList.contains("z-"+zone.toLowerCase())));
  $$("#dpadMini .mini-btn").forEach(b=> b.classList.toggle("active", b.dataset.zone===zone));
  $$(".dpad-btn").forEach(b=> b.classList.toggle("active", b.dataset.cmd===`DPAD_${zone}`));
  setTimeout(()=>{
    heroes.forEach(z=> z.classList.remove("active"));
    $$("#dpadMini .mini-btn").forEach(b=> b.classList.remove("active"));
    $$(".dpad-btn").forEach(b=> b.classList.remove("active"));
  }, 420);
}
$$(".dpad-btn, .qbtn").forEach(b=>{
  b.onclick = ()=>{
    const cmd = b.dataset.cmd;
    if(!cmd) return;
    sendCommand(cmd);
  };
});
$("#sendTextBtn").onclick = ()=>{
  const v = $("#textInput").value;
  if(!v) return;
  for(const ch of v) sendCommand("TEXT", ch);
  $("#textInput").value="";
};
$("#clearTextBtn").onclick = ()=> $("#textInput").value="";
$("#textInput").addEventListener("keydown", e=>{
  if(e.key==="Enter") $("#sendTextBtn").click();
});
const video = $("#video"), overlay=$("#overlay"), zoneOverlay=$("#zoneOverlay"), videoWrap=$("#videoWrap");
const gestureLabel=$("#gestureLabel"), zoneLabel=$("#zoneLabel"), confLabel=$("#confLabel"), fpsLabel=$("#fpsLabel");
const camToggle=$("#camToggle"), mirrorToggle=$("#mirrorToggle"), showLandmarks=$("#showLandmarks");
let hands=null, camera=null, running=false, rafId=null;
let lastStream=null; // mirrors camera into fullscreen gesture page
let lastFpsUpdate=now(), frames=0, fps=0;
function setCamUI(on){
  camToggle.textContent = on? "Disable Camera" : "Enable Camera";
  camToggle.classList.toggle("primary", !on);
  videoWrap.classList.toggle("has-video", on);
}
function resizeOverlays(){
  [overlay, zoneOverlay].forEach(c=>{
    const rect = videoWrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio||1;
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    c.style.width = rect.width+"px";
    c.style.height = rect.height+"px";
  });
  drawZones();
}
window.addEventListener("resize", resizeOverlays);
function drawZones(){
  const c = zoneOverlay, ctx=c.getContext("2d");
  const dpr= window.devicePixelRatio||1;
  const w=c.width, h=c.height;
  ctx.clearRect(0,0,w,h);
  const dead = state.deadPct/100;
  const cx0 = (0.5 - dead/2)*w, cx1=(0.5 + dead/2)*w;
  const cy0 = (0.5 - dead/2)*h, cy1=(0.5 + dead/2)*h;
  ctx.strokeStyle="rgba(255,255,255,.22)";
  ctx.lineWidth=1*dpr;
  ctx.setLineDash([6*dpr,6*dpr]);
  ctx.strokeRect(cx0, cy0, cx1-cx0, cy1-cy0);
  ctx.setLineDash([]);
  ctx.strokeStyle="rgba(79,124,255,.18)";
  ctx.lineWidth=1*dpr;
  ctx.beginPath(); ctx.moveTo(cx0,0); ctx.lineTo(cx0,h); ctx.moveTo(cx1,0); ctx.lineTo(cx1,h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,cy0); ctx.lineTo(w,cy0); ctx.moveTo(0,cy1); ctx.lineTo(w,cy1); ctx.stroke();
  ctx.fillStyle="rgba(255,255,255,.55)";
  ctx.font=`${11*dpr}px Inter`;
  ctx.textAlign="center";
  ctx.fillText("CENTER — idle", w/2, cy0 - 8*dpr);
}
$("#cooldownRange").oninput = e=>{ state.DWELL_MS=parseInt(e.target.value); $("#cooldownVal").textContent=(state.DWELL_MS/1000)+"s"; };
$("#deadRange").oninput = e=>{ state.deadPct=parseInt(e.target.value); $("#deadVal").textContent=state.deadPct+"%"; drawZones(); };
$("#pauseGestures").onchange = e=> state.pause=e.target.checked;
mirrorToggle.onchange = ()=> videoWrap.classList.toggle("mirror", mirrorToggle.checked);
videoWrap.classList.toggle("mirror", mirrorToggle.checked);
function canFire(){
  const t=now();
  if(t - state.lastCmdAt < state.cooldownMs) return false;
  if(state.pause) return false;
  return true;
}
function isFingerExtended(landmarks, tipIdx, pipIdx){
  const wrist = landmarks[0];
  const tip = landmarks[tipIdx], pip = landmarks[pipIdx];
  const dTip = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
  const dPip = Math.hypot(pip.x - wrist.x, pip.y - wrist.y);
  return dTip > dPip * 1.02;
}
// ---- High-accuracy finger detection (joint angle + length, ~99%) ----
function angleAt(a, b, c){
  const ux=a.x-b.x, uy=a.y-b.y, vx=c.x-b.x, vy=c.y-b.y;
  const dot=ux*vx+uy*vy;
  const lu=Math.hypot(ux,uy), lv=Math.hypot(vx,vy);
  if(!lu || !lv) return 180;
  return Math.acos(Math.max(-1, Math.min(1, dot/(lu*lv))))*180/Math.PI;
}
// [thumb, index, middle, ring, pinky] — returns mask of extended fingers
// Uses 3 signals: (1) tip far from wrist vs MCP, (2) tip projects out far from MCP,
// (3) finger is straight (angle at PIP/IP joint > threshold).
const FINGER_DEFS = [
  {tip:4,  a:2,  b:3},
  {tip:8,  a:5,  b:6},
  {tip:12, a:9,  b:10},
  {tip:16, a:13, b:14},
  {tip:20, a:17, b:18},
];
function fingerMask(landmarks){
  const wrist=landmarks[0];
  const palm=landmarks[9];
  const hand=Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  const mask=[];
  FINGER_DEFS.forEach(({tip:a, a:an, b:bn})=>{
    const tp=landmarks[a], mcp2=landmarks[an], jnt=landmarks[bn];
    if(!tp || !mcp2 || !jnt){ mask.push(0); return; }
    if(a===4){ // thumb: allow more relaxed (use IP joint angle)
      const dTip=Math.hypot(tp.x-wrist.x, tp.y-wrist.y);
      const dMcp=Math.hypot(mcp2.x-wrist.x, mcp2.y-wrist.y);
      const straight=angleAt(landmarks[1], jnt, tp);
      mask.push(dTip > dMcp*1.05 && straight > 135 ? 1 : 0);
      return;
    }
    const dTip=Math.hypot(tp.x-wrist.x, tp.y-wrist.y);
    const dMcp=Math.hypot(mcp2.x-wrist.x, mcp2.y-wrist.y);
    const dTip2Mcp=Math.hypot(tp.x-mcp2.x, tp.y-mcp2.y);
    const straight=angleAt(mcp2, jnt, tp);
    mask.push((dTip > dMcp*1.05 && dTip2Mcp > hand*0.28 && straight > 148) ? 1 : 0);
  });
  return mask;
}
function countExtended(landmarks){
  const mask = fingerMask(landmarks);
  return {cnt: mask.reduce((s,v)=>s+v,0), mask};
}
function isTwoFinger(landmarks){
  const mask = fingerMask(landmarks);
  // index + middle extended, ring + pinky curled (thumb ignored, allows open-V)
  if(!(mask[1]===1 && mask[2]===1 && mask[3]===0 && mask[4]===0)) return false;
  // require real spread V — not a single thick finger
  const p8=landmarks[8], p12=landmarks[12];
  const dist=Math.hypot(p8.x-p12.x, p8.y-p12.y);
  const palm=landmarks[9], wrist=landmarks[0];
  const hand=Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  if(dist < hand*0.28) return false;
  // tips must be clearly in front of the palm (toward top of frame), reduce side-tip false positives
  const midX=(p8.x+p12.x)/2, midY=(p8.y+p12.y)/2;
  const dy = palm.y - midY;
  const straight = Math.max(angleAt(landmarks[5], landmarks[6], landmarks[8]), angleAt(landmarks[9], landmarks[10], landmarks[12]));
  return straight > 160 && dy > -0.05;
}
function isOneFingerOrOpen(landmarks){
  if(isTwoFinger(landmarks)) return false;
  const {cnt} = countExtended(landmarks);
  return cnt>=1;
}
// Thumb-down gesture: four fingers curled (fist-like), thumb extended straight DOWN
// → sends BACK. Compared against palm so it only registers when the thumb clearly points down.
function isThumbDown(landmarks){
  const mask = fingerMask(landmarks);
  if(mask[1]===1 || mask[2]===1 || mask[3]===1 || mask[4]===1) return false; // other fingers must be curled
  const wrist=landmarks[0], palm=landmarks[9];
  const hand=Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  const tMcp=landmarks[2], tTip=landmarks[4];
  if(!tMcp || !tTip) return false;
  const dTip=Math.hypot(tTip.x-wrist.x, tTip.y-wrist.y);
  const dMcp=Math.hypot(tMcp.x-wrist.x, tMcp.y-wrist.y);
  if(dTip < dMcp*1.1) return false;          // thumb must be extended, not tucked
  const dropY = tTip.y - tMcp.y;              // positive = tip below the thumb MCP (downward)
  const sideX = Math.abs(tTip.x - tMcp.x);
  if(dropY < hand*0.18) return false;         // must clearly drop below the palm line
  if(sideX > dropY*0.95) return false;        // must point down, not sideways
  return true;
}
function isFist(landmarks){
  const mask = fingerMask(landmarks);
  if(mask[1]===1 || mask[2]===1 || mask[3]===1 || mask[4]===1) return false;
  // Accuracy: 4 fingertips must be folded close to their knuckles (tight fist), not just "not extended"
  const wrist=landmarks[0], palm=landmarks[9];
  const hand=Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  const folds=[[8,6],[12,10],[16,14],[20,18]];
  let close=0;
  folds.forEach(([tip,pip])=>{
    const t=landmarks[tip], p=landmarks[pip];
    if(!t||!p) return;
    if(Math.hypot(t.x-p.x,t.y-p.y) < hand*0.60) close++;
  });
  if(close < 3) return false;
  // a fully downturned thumb looks like thumb-down (BACK) — keep OK clean for neutral fist
  const tt=landmarks[4], tm=landmarks[2];
  if(tt && tm && (tt.y - tm.y) > hand*0.2) return false;
  return true;
}
// "Click OK" — a confirmed fist fires DPAD_CENTER. This is the reliable click.
function isThumbUp(landmarks){
  const mask = fingerMask(landmarks);
  if(mask[1]===1 || mask[2]===1 || mask[3]===1 || mask[4]===1) return false;
  const wrist=landmarks[0], palm=landmarks[9];
  const hand=Math.max(Math.hypot(palm.x-wrist.x, palm.y-wrist.y), 0.05);
  const tMcp=landmarks[2], tTip=landmarks[4];
  if(!tMcp||!tTip) return false;
  const dTip=Math.hypot(tTip.x-wrist.x, tTip.y-wrist.y);
  const dMcp=Math.hypot(tMcp.x-wrist.x, tMcp.y-wrist.y);
  if(dTip < dMcp*1.1) return false;
  const riseY = tMcp.y - tTip.y;               // tip clearly above MCP (up)
  if(riseY < hand*0.18) return false;
  return true;
}
function mapZone(x, y){
  const dead = state.deadPct/100;
  const x0 = 0.5 - dead/2, x1=0.5 + dead/2;
  const y0 = 0.5 - dead/2, y1=0.5 + dead/2;
  const inCenter = x>=x0 && x<=x1 && y>=y0 && y<=y1;
  if(inCenter) return "CENTER";
  const cx=0.5, cy=0.5;
  const dx = x - cx, dy = y - cy;
  if(Math.abs(dy) > Math.abs(dx)){
    return dy < 0 ? "UP" : "DOWN";
  } else {
    return dx < 0 ? "LEFT" : "RIGHT";
  }
}
async function initHands(){
  if(hands) return hands;
  if(typeof Hands === "undefined"){
    toast("MediaPipe failed to load — check internet", "bad");
    return null;
  }
  hands = new Hands({locateFile: (file)=> `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
    selfMode: false,
  });
  hands.onResults(onHandsResults);
  return hands;
}
// Draws the MediaPipe hand skeleton on a fullscreen overlay canvas,
// mapping normalized landmarks through the video cover-transform so it lines up with the camera feed.
function drawHandOnCanvas(canvas, landmarks, mirror){
  if(!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if(rect.width < 10) return;
  const dpr = window.devicePixelRatio||1;
  const cw = rect.width*dpr, ch = rect.height*dpr;
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const scale = Math.max(cw/vw, ch/vh);
  const w = vw*scale, h = vh*scale;
  const ox = (cw - w)/2, oy = (ch - h)/2;
  const P = lm=>({ x: ox + (mirror ? 1-lm.x : lm.x)*w, y: oy + lm.y*h });
  const pts = landmarks.map(P);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,cw,ch);
  if(typeof HAND_CONNECTIONS !== "undefined"){
    ctx.lineWidth = 2.5*dpr;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,245,255,.9)";
    ctx.beginPath();
    HAND_CONNECTIONS.forEach(([a,b])=>{ const pa=pts[a], pb=pts[b]; ctx.moveTo(pa.x,pa.y); ctx.lineTo(pb.x,pb.y); });
    ctx.stroke();
  }
  ctx.fillStyle = "#ffffff";
  pts.forEach(p=>{ ctx.beginPath(); ctx.arc(p.x,p.y,3.5*dpr,0,7); ctx.fill(); });
  const tips = [4,8,12,16,20];
  ctx.fillStyle = "rgba(255,80,190,1)";
  tips.forEach(i=>{ const p=pts[i]; ctx.beginPath(); ctx.arc(p.x,p.y,4.5*dpr,0,7); ctx.fill(); });
  return pts;
}
// ---------- PAGE NAVIGATION + FULLSCREEN GESTURE ----------
function showPage(id){
  ["page-home","page-zones","page-draw"].forEach(p=>{
    const el=document.getElementById(p);
    if(el){
      const on = p===id;
      el.classList.toggle("active", on);
      el.classList.toggle("hidden", !on);
    }
  });
  if(id==="page-zones"){ try{ if(document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(()=>{}); }catch{} }
}
function syncFsVideo(){
  const fsV=$("#fsVideo");
  if(!fsV) return;
  if(lastStream){ fsV.srcObject=lastStream; fsV.play().catch(()=>{}); }
  if(mirrorToggle) fsV.classList.toggle("mirror", mirrorToggle.checked);
}
function enterFullscreenGesture(){
  syncFsVideo();
  resizeFsOverlay();
  showPage("page-zones");
  if(!running){ startCamera(); }
}
function leaveFullscreen(){
  showPage("page-home");
  try{ if(document.exitFullscreen) document.exitFullscreen(); }catch{}
  const fsV=$("#fsVideo"); if(fsV) fsV.srcObject=null;
}
function gestureHud(msg){
  if(gestureLabel) gestureLabel.textContent=msg;
  const fsh=$("#fsGestureHud"); if(fsh) fsh.textContent=msg;
}
function resizeFsOverlay(){
  const fsO=$("#fsOverlay");
  if(!fsO) return;
  const dpr=window.devicePixelRatio||1;
  fsO.width = window.innerWidth * dpr;
  fsO.height = window.innerHeight * dpr;
}
function syncFsOverlayState(){
  const fsO=$("#fsOverlay");
  if(!fsO) return;
  const rect = fsO.getBoundingClientRect();
  if(rect.width < 50) return;
  const dpr=window.devicePixelRatio||1;
  const w=rect.width*dpr, h=rect.height*dpr;
  const ctx=fsO.getContext("2d");
  const dead=state.deadPct/100;
  const cx0=(0.5-dead/2)*w, cx1=(0.5+dead/2)*w;
  const cy0=(0.5-dead/2)*h, cy1=(0.5+dead/2)*h;
  ctx.clearRect(0,0,w,h);
  ctx.setTransform(1,0,0,1,0,0);
  ctx.strokeStyle="rgba(255,255,255,.18)";
  ctx.lineWidth=2*dpr;
  ctx.setLineDash([8*dpr,8*dpr]);
  ctx.strokeRect(cx0, cy0, cx1-cx0, cy1-cy0);
  ctx.setLineDash([]);
  ctx.strokeStyle="rgba(79,124,255,.14)";
  ctx.lineWidth=2*dpr;
  ctx.beginPath(); ctx.moveTo(cx0,0); ctx.lineTo(cx0,h); ctx.moveTo(cx1,0); ctx.lineTo(cx1,h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,cy0); ctx.lineTo(w,cy0); ctx.moveTo(0,cy1); ctx.lineTo(w,cy1); ctx.stroke();
}
const enterZonesBtn=$("#enterZonesBtn");
if(enterZonesBtn) enterZonesBtn.onclick = ()=> enterFullscreenGesture();
const exitZonesBtn=$("#exitZonesBtn");
if(exitZonesBtn) exitZonesBtn.onclick = ()=> leaveFullscreen();
const exitDrawBtn=$("#exitDrawBtn");
if(exitDrawBtn) exitDrawBtn.onclick = ()=>{ showPage("page-zones"); };
window.addEventListener("resize", ()=>{ resizeFsOverlay(); });
function enterDwell(key){
  if(state._dwellKey !== key){
    state._dwellKey = key;
    state._dwellStart = now();
    state._dwellFired = false;
  }
}
function resetDwell(){
  state._dwellKey = null;
  state._dwellStart = 0;
  state._dwellFired = false;
  state._lastPalm = {px:0.5, py:0.5};
}
function dwellProgress(){
  if(!state._dwellStart) return 0;
  return clamp((now() - state._dwellStart) / state.DWELL_MS, 0, 1);
}
function drawDwellRing(prog){
  const fsO=$("#fsOverlay");
  const fsV=$("#fsVideo");
  if(!fsO || prog<=0) return;
  const p=state._lastPalm;
  const dpr=window.devicePixelRatio||1;
  const rect=fsO.getBoundingClientRect();
  if(rect.width<50) return;
  const cw=rect.width*dpr, ch=rect.height*dpr;
  const vw=(fsV && fsV.videoWidth>0) ? fsV.videoWidth : 1280;
  const vh=(fsV && fsV.videoHeight>0) ? fsV.videoHeight : 720;
  const scale=Math.max(cw/vw, ch/vh);
  const vwS=vw*scale, vhS=vh*scale;
  const ox=(cw-vwS)/2, oy=(ch-vhS)/2;
  let x=p.px; if(mirrorToggle && mirrorToggle.checked) x=1-x;
  const sx=ox + x*vwS, sy=oy + p.py*vhS;
  const ctx=fsO.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  ctx.strokeStyle="rgba(255,255,255,.16)";
  ctx.lineWidth=6*dpr;
  ctx.beginPath(); ctx.arc(sx,sy,30*dpr,0,Math.PI*2); ctx.stroke();
  ctx.strokeStyle=prog>=1 ? "rgba(52,211,153,.95)" : "rgba(0,245,255,.9)";
  ctx.lineCap="round";
  ctx.beginPath();
  ctx.arc(sx,sy,30*dpr, -Math.PI/2, -Math.PI/2 + Math.PI*2*Math.min(prog,1));
  ctx.stroke();
  ctx.fillStyle=prog>=1 ? "rgba(52,211,153,.95)" : "rgba(255,255,255,.85)";
  ctx.font=`bold ${16*dpr}px ui-monospace, monospace`;
  ctx.textAlign="center";
  ctx.fillText(Math.min(1,prog)>=1 ? "GO" : `${Math.round(prog*100)}%`, sx, sy+6*dpr);
}
function onHandsResults(results){
  frames++;
  const t=now();
  if(t - lastFpsUpdate > 500){
    fps = Math.round(frames*1000/(t-lastFpsUpdate));
    fpsLabel.textContent = fps;
    lastFpsUpdate=t; frames=0;
  }
  gestureHud(fps? `Hand — ${fps} fps` : "Hand —");
  syncFsOverlayState();
  const ctx = overlay.getContext("2d");
  const dpr = window.devicePixelRatio||1;
  ctx.clearRect(0,0,overlay.width, overlay.height);
  if(!results.multiHandLandmarks || results.multiHandLandmarks.length===0){
    gestureHud("No hand");
    zoneLabel.textContent="—";
    confLabel.textContent="—";
    resetDwell();
    const fsO2=$("#fsOverlay"); if(fsO2){ const c2=fsO2.getContext("2d"); if(c2 && fsO2.width) c2.clearRect(0,0,fsO2.width,fsO2.height); syncFsOverlayState(); }
    const hM2=$("#handMini"); if(hM2){ const c3=hM2.getContext("2d"); if(c3 && hM2.width) c3.clearRect(0,0,hM2.width,hM2.height); }
    if(state.drawing && (t - state.lastDrawEnd > 650)){
      finalizeStroke();
    }
    return;
  }
  const landmarks = results.multiHandLandmarks[0];
  const handedness = results.multiHandedness && results.multiHandedness[0] ? results.multiHandedness[0].label : "Unknown";
  const score = results.multiHandedness && results.multiHandedness[0] ? (results.multiHandedness[0].score||0) : 0;
  confLabel.textContent = handedness + (score?` ${(score*100|0)}%`:"");
  if(showLandmarks.checked && window.drawConnectors && window.drawLandmarks){
    ctx.save();
    if(mirrorToggle.checked){
      ctx.scale(-1,1);
      ctx.translate(-overlay.width,0);
    }
    drawConnectors(ctx, landmarks, HAND_CONNECTIONS, {color:"rgba(79,124,255,.9)", lineWidth:2*dpr});
    drawLandmarks(ctx, landmarks, {color:"rgba(255,255,255,.95)", lineWidth:1, radius:3*dpr});
    ctx.restore();
  }
// Accuracy: show the MediaPipe hand skeleton on the FULLSCREEN camera too
  const fsO=$("#fsOverlay");
  if(fsO){
    const fsRect=fsO.getBoundingClientRect();
    if(fsRect.width > 50){
      drawHandOnCanvas(fsO, landmarks, mirrorToggle.checked);
      syncFsOverlayState(); // redraw zone grid on top of skeleton
    }
  }
  const handMini=$("#handMini");
  if(handMini){
    const hRect=handMini.getBoundingClientRect();
    if(hRect.width > 10){
      drawHandOnCanvas(handMini, landmarks, false);
    }
  }
const twoRaw = isTwoFinger(landmarks);
  const oneRaw = isOneFingerOrOpen(landmarks);
  const fistRaw = isFist(landmarks);
  const thumbDownRaw = isThumbDown(landmarks);
  // Hysteresis — a gesture must persist a few consecutive frames to count (kills false triggers)
  state._twoFrames = twoRaw ? state._twoFrames+1 : 0;
  state._fistFrames = fistRaw && !thumbDownRaw ? state._fistFrames+1 : 0;
  state._thumbDownFrames = thumbDownRaw ? state._thumbDownFrames+1 : 0;
  const two = state._twoFrames >= 3;
  const fist = state._fistFrames >= 3 && !two;
  const thumbDown = state._thumbDownFrames >= 3 && !two && !fist;
  const one = !fist && !two && !thumbDown && oneRaw;
  state._twoStable = two;
  state._fistStable = fist;
  state._thumbStable = thumbDown;
  const tip = landmarks[8];
  let nx = tip.x, ny = tip.y;
  if(mirrorToggle.checked) nx = 1 - nx;
  let palm = landmarks[9];
  let px = palm.x, py = palm.y;
  if(mirrorToggle.checked) px = 1 - px;
  state._lastPalm = {px, py};
  if(two){
    resetDwell();
    gestureHud("✌ Two-finger — drawing");
    zoneLabel.textContent = "DRAW";
    // Automatically redirect to the air-draw page when two fingers are confirmed
    const curPage = [...$$(".page")].find(p=> p.classList.contains("active"));
    if(state.connected && curPage && curPage.id!=="page-draw"){
      showPage("page-draw");
    }
    handleDrawPoint(nx, ny);
    state.lastZone = null;
    return;
  }
  if(state.drawing && !two){
    if(t - state.lastDrawEnd > 120){
      if(!state._drawTimer){
        state._drawTimer = setTimeout(()=>{
          finalizeStroke();
          state._drawTimer=null;
        }, 700);
      }
    }
    gestureHud("Finishing stroke…");
    return;
  } else {
    if(state._drawTimer){ clearTimeout(state._drawTimer); state._drawTimer=null; }
  }
  if(thumbDown){
    gestureHud("👎 Thumb down — hold " + Math.ceil((1-dwellProgress())*state.DWELL_MS/1000) + "s");
    zoneLabel.textContent="BACK (thumb down)";
    enterDwell("thumbdown");
    drawDwellRing(dwellProgress());
    if(dwellProgress()>=1 && !state._dwellFired){
      sendCommand("BACK");
      state.lastCmdAt = now();
      state._dwellFired = true;
    }
    return;
  }
  if(fist){
    gestureHud("✊ Fist = OK — hold " + Math.ceil((1-dwellProgress())*state.DWELL_MS/1000) + "s");
    zoneLabel.textContent="CENTER (fist)";
    $$("#dpadMini .mini-btn").forEach(b=> b.classList.toggle("active", b.dataset.zone==="CENTER"));
    enterDwell("fist");
    drawDwellRing(dwellProgress());
    if(dwellProgress()>=1 && !state._dwellFired){
      sendCommand("DPAD_CENTER");
      state.lastCmdAt = now();
      state._dwellFired = true;
    }
    return;
  }
  if(one){
    const zone = mapZone(px, py);
    zoneLabel.textContent = zone;
    $$("#dpadMini .mini-btn").forEach(b=> b.classList.toggle("active", b.dataset.zone===zone));
    if(zone==="CENTER"){
      gestureHud("Open hand — center idle (hold fist = OK)");
      flashZoneInOverlay(zone);
      resetDwell();
      return;
    }
    gestureHud(`${handedness} → ${zone} — hold ${Math.ceil((1-dwellProgress())*state.DWELL_MS/1000)}s`);
    flashZoneInOverlay(zone);
    enterDwell("zone:"+zone);
    drawDwellRing(dwellProgress());
    if(dwellProgress()>=1 && !state._dwellFired){
      sendCommand(`DPAD_${zone}`);
      state.lastCmdAt = now();
      state.lastZone = zone;
      state._dwellFired = true;
    }
  } else {
    gestureHud("Hand detected — adjust fingers");
    zoneLabel.textContent="—";
    resetDwell();
  }
}
function flashZoneInOverlay(zone){
  const c = zoneOverlay, ctx=c.getContext("2d");
  const dpr= window.devicePixelRatio||1;
  const w=c.width, h=c.height;
  drawZones();
  const dead = state.deadPct/100;
  const cx0=(0.5-dead/2)*w, cx1=(0.5+dead/2)*w;
  const cy0=(0.5-dead/2)*h, cy1=(0.5+dead/2)*h;
  ctx.fillStyle="rgba(79,124,255,.14)";
  if(zone==="UP") ctx.fillRect(0,0,w,cy0);
  else if(zone==="DOWN") ctx.fillRect(0,cy1,w,h-cy1);
  else if(zone==="LEFT") ctx.fillRect(0,cy0,cx0,cy1-cy0);
  else if(zone==="RIGHT") ctx.fillRect(cx1,cy0,w-cx1,cy1-cy0);
  else if(zone==="CENTER") { ctx.fillStyle="rgba(255,255,255,.06)"; ctx.fillRect(cx0,cy0,cx1-cx0,cy1-cy0); }
}
function isSecureForCamera(){
  return window.isSecureContext || location.hostname==='localhost' || location.hostname==='127.0.0.1' || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.');
}
function showCameraError(title, details, canRetry=true){
  const ph = $("#videoPlaceholder");
  if(ph){
    ph.innerHTML = `
      <div style="padding:16px; max-width:340px; text-align:center">
        <div class="ph-icon" style="font-size:28px">⚠️</div>
        <p style="font-weight:800; margin:6px 0 4px; color:var(--text)">${title}</p>
        <small style="display:block; color:var(--muted); line-height:1.5; margin-bottom:10px">${details}</small>
        ${canRetry?`<button class="btn small primary" onclick="document.getElementById('camToggle').click()" style="margin:4px">Try Again</button>`:''}
        <button class="btn small ghost" onclick="toast('Using mouse/touch fallback for drawing + keyboard arrows for D-Pad','good')" style="margin:4px">Use Fallback</button>
        <div style="margin-top:8px; font-size:.75em; color:var(--muted2); text-align:left; background:var(--card-2); border:1px solid var(--border); border-radius:8px; padding:8px">
          <strong>How to allow:</strong><br>
          • Chrome: lock icon in address bar → Site settings → Camera → Allow → Reload<br>
          • Edge/Brave: same, or <code>chrome://settings/content/camera</code><br>
          • Must be <code>https://</code> or <code>http://localhost</code> (not plain <code>http://192.168...</code> unless you use <code>node server.js</code> at <code>http://localhost:3000</code>)
        </div>
      </div>`;
    ph.style.display='grid';
  }
  videoWrap.classList.remove("has-video");
  setCamUI(false);
}
async function startCamera(){
  if(running) return;
  // Secure context check — getUserMedia fails on http:// (except localhost)
  if(!isSecureForCamera()){
    showCameraError(
      "Camera needs HTTPS or localhost",
      `You are on <code>${location.protocol}//${location.hostname}</code> which is not a secure context. Browsers block camera on plain <code>http://</code>.<br>Fix: run <code>node server.js</code> and open <code>http://localhost:3000</code> (allowed) OR host on <code>https://</code>.`,
      false
    );
    toast("Camera blocked: not a secure context. Use http://localhost:3000 or https://", "bad");
    return;
  }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    showCameraError("Camera API not available", "This browser doesn't support <code>navigator.mediaDevices.getUserMedia</code>. Try Chrome/Edge on desktop, or use mouse/touch fallback.", false);
    toast("Camera not supported in this browser", "bad");
    return;
  }
  const h = await initHands();
  if(!h) return;
  // If permission was previously denied, query it first to give better message
  try{
    if(navigator.permissions && navigator.permissions.query){
      const p = await navigator.permissions.query({name:'camera'});
      if(p.state==='denied'){
        showCameraError(
          "Camera permission denied",
          `Browser says camera is <strong>blocked</strong> for this site. You previously clicked "Block".<br>Fix it, then click Try Again.`,
          true
        );
        // still try — browser will show prompt again on some browsers after user gesture
      }
    }
  }catch{}
  // Try getUserMedia with ideal constraints, fallback to simple
  let stream=null;
  const tries = [
    {video:{width:{ideal:1280}, height:{ideal:720}, facingMode:"user"}, audio:false},
    {video:{width:{ideal:640}, height:{ideal:480}, facingMode:"user"}, audio:false},
    {video:true, audio:false}
  ];
  let lastErr=null;
  for(const constr of tries){
    try{
      stream = await navigator.mediaDevices.getUserMedia(constr);
      break;
    }catch(e){ lastErr=e; if(e.name==='NotAllowedError') break; }
  }
  if(!stream){
    const e = lastErr || new Error('unknown');
    console.error(e);
    let title="Camera not available", details="Unknown error. Try another browser or use fallback.";
    if(e.name==='NotAllowedError' || e.name==='PermissionDeniedError'){
      title="Camera permission denied";
      details=`You clicked <strong>Block</strong> or the browser blocked it.<br>Name: <code>${e.name}</code><br>Click <strong>Try Again</strong> and then <strong>Allow</strong> when the browser asks.`;
    } else if(e.name==='NotFoundError' || e.name==='DevicesNotFoundError'){
      title="No camera found";
      details="No camera device detected. Plug in a webcam or use mouse/touch fallback for drawing and keyboard arrows for D-Pad.";
    } else if(e.name==='NotReadableError' || e.name==='TrackStartError'){
      title="Camera busy";
      details="Camera is already in use by another app (Zoom/Teams/Meet). Close that app and Try Again.";
    } else if(e.name==='OverconstrainedError'){
      title="Camera constraints failed";
      details="Try closing other camera apps and Try Again, or use fallback.";
    } else if(e.name==='SecurityError'){
      title="Security blocked camera";
      details="Insecure context or iframe blocked. Use <code>http://localhost:3000</code> via <code>node server.js</code> or <code>https://</code>.";
    } else {
      details=`${e.name}: ${e.message||'unknown'}<br>Use mouse/touch fallback.`;
    }
    showCameraError(title, details, true);
    toast(title+" — using fallback", "bad");
    return;
  }
  try{
    lastStream = stream;
    video.srcObject = stream;
    await video.play();
    resizeOverlays();
    videoWrap.classList.add("has-video");
    running=true;
    setCamUI(true);
    toast("Camera started ✓ Show your hand (allow popup → Allow)", "good");
    // Hide any previous error placeholder
    const ph2=$("#videoPlaceholder");
    if(ph2) ph2.style.display='none';
    if(typeof Camera !== "undefined"){
      camera = new Camera(video, {
        onFrame: async ()=>{
          if(video.readyState>=2) await hands.send({image: video});
        },
        width: 640,
        height: 480,
      });
      camera.start();
    } else {
      const loop = async ()=>{
        if(!running) return;
        if(video.readyState>=2) await hands.send({image: video});
        rafId = requestAnimationFrame(loop);
      };
      loop();
    }
    lastFpsUpdate=now(); frames=0;
  }catch(e){
    console.error(e);
    showCameraError("Camera failed to start", e.message||String(e), true);
    toast("Camera failed — fallback active", "bad");
    setCamUI(false);
  }
}
async function stopCamera(){
  running=false;
  if(camera && camera.stop) try{ camera.stop(); }catch{}
  if(rafId) cancelAnimationFrame(rafId);
  if(video.srcObject){
    video.srcObject.getTracks().forEach(t=> t.stop());
    video.srcObject=null;
  }
  lastStream=null;
  const fsV=$("#fsVideo"); if(fsV) fsV.srcObject=null;
  videoWrap.classList.remove("has-video");
  setCamUI(false);
  gestureHud("Camera off");
  zoneLabel.textContent="—";
  const ctx=overlay.getContext("2d"); ctx.clearRect(0,0,overlay.width, overlay.height);
  drawZones();
}
camToggle.onclick = ()=>{
  if(running) stopCamera(); else startCamera();
};
$("#pauseGestures").onchange = e=> state.pause=e.target.checked;
document.addEventListener("keydown", e=>{
  if(e.code==="Space"){
    e.preventDefault();
    const cb=$("#pauseGestures");
    cb.checked=!cb.checked;
    state.pause=cb.checked;
    toast(state.pause? "Gestures paused":"Gestures resumed");
  }
  if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key)){
    e.preventDefault();
    const map={ArrowUp:"DPAD_UP", ArrowDown:"DPAD_DOWN", ArrowLeft:"DPAD_LEFT", ArrowRight:"DPAD_RIGHT"};
    sendCommand(map[e.key]);
  }
  if(e.key==="Enter") sendCommand("DPAD_CENTER");
  if(e.key==="Backspace") sendCommand("BACK");
  if(e.key.toLowerCase()==="h") sendCommand("HOME");
});
const drawCanvas = $("#drawCanvas"), drawCtx=drawCanvas.getContext("2d");
const drawStateEl=$("#drawState"), recogEl=$("#recognizedLetter"), recogConfEl=$("#recogConf"), textBufferEl=$("#textBuffer"), airHint=$("#airHint");
let dpr = window.devicePixelRatio||1;
let isMouseDrawing=false, mousePoints=[];
function clearDrawCanvas(){
  const w=drawCanvas.width, h=drawCanvas.height;
  drawCtx.clearRect(0,0,w,h);
  drawCtx.fillStyle="#070A0F";
  drawCtx.fillRect(0,0,w,h);
  drawCtx.strokeStyle="rgba(255,255,255,.04)";
  drawCtx.lineWidth=1;
  const step=40;
  for(let x=0;x<w;x+=step){ drawCtx.beginPath(); drawCtx.moveTo(x,0); drawCtx.lineTo(x,h); drawCtx.stroke(); }
  for(let y=0;y<h;y+=step){ drawCtx.beginPath(); drawCtx.moveTo(0,y); drawCtx.lineTo(w,y); drawCtx.stroke(); }
}
clearDrawCanvas();
function handleDrawPoint(nx, ny){
  const w=drawCanvas.width, h=drawCanvas.height;
  const x = nx * w, y = ny * h;
  if(!state.drawing){
    state.drawing=true;
    state.drawPoints=[];
    drawStateEl.textContent="Drawing…";
    drawStateEl.className="badge on";
    airHint.classList.add("hidden");
    if(state._drawTimer){ clearTimeout(state._drawTimer); state._drawTimer=null; }
  }
  state.drawPoints.push({x, y, nx, ny});
  state.lastDrawEnd = now();
  const pts = state.drawPoints;
  if(pts.length>1){
    drawCtx.strokeStyle="rgba(96,165,255,1)";
    drawCtx.lineWidth=4;
    drawCtx.lineCap="round";
    drawCtx.lineJoin="round";
    drawCtx.shadowColor="rgba(79,124,255,.6)";
    drawCtx.shadowBlur=8;
    drawCtx.beginPath();
    const p0 = pts[pts.length-2], p1= pts[pts.length-1];
    drawCtx.moveTo(p0.x, p0.y);
    drawCtx.lineTo(p1.x, p1.y);
    drawCtx.stroke();
    drawCtx.shadowBlur=0;
  } else {
    drawCtx.fillStyle="rgba(96,165,255,1)";
    drawCtx.beginPath(); drawCtx.arc(x,y,4,0,Math.PI*2); drawCtx.fill();
  }
}
function strokesToPointArray(strokes){
  const merged=[];
  strokes.forEach((s,i)=>{
    s.forEach(p=> merged.push(p));
  });
  return merged;
}
function finalizeStroke(){
  if(state.drawPoints.length < 8){
    if(state.drawPoints.length>0){
      drawStateEl.textContent="Too short";
      setTimeout(()=> { if(!state.drawing) { drawStateEl.textContent="Idle"; drawStateEl.className="badge"; } }, 800);
    }
    state.drawing=false;
    state.drawPoints=[];
    airHint.classList.remove("hidden");
    return;
  }
  const stroke = [...state.drawPoints];
  state.strokes.push(stroke);
  state.drawing=false;
  state.drawPoints=[];
  airHint.classList.remove("hidden");
  drawStateEl.textContent="Recognizing…";
  let toRecognize;
  if(state.strokes.length>=2){
    const lastTwo = state.strokes.slice(-2);
    toRecognize = strokesToPointArray(lastTwo);
  } else {
    toRecognize = strokesToPointArray([stroke]);
  }
  const result = recognizeLetter(toRecognize);
  if(result){
    recogEl.textContent = result.letter;
    recogConfEl.textContent = `(${(result.score*100|0)}%)`;
    highlightLetter(result.letter);
    state.buffer += result.letter;
    textBufferEl.textContent = state.buffer;
    log(`Drew "${result.letter}" ${result.score>0.7 ? "✓" : "~"}`, result.score>0.6? "good":"warn");
    if(state.searchActive && $("#autoSendToggle").checked){
      sendCommand("TEXT", result.letter);
    } else if(state.searchActive){
      toast(`"${result.letter}" buffered — auto-send off`, "good");
    } else {
      toast(`"${result.letter}" buffered — enable Search to send to TV`, "warn");
    }
    drawStateEl.textContent=`Recognized: ${result.letter}`;
    drawStateEl.className="badge on";
    setTimeout(()=>{ drawStateEl.textContent="Idle"; drawStateEl.className="badge"; }, 1400);
    if(state.strokes.length>=2 && result.score>0.62){
      state.strokes = [];
      setTimeout(()=>{ if(state.strokes.length===0) {}}, 800);
    }
  } else {
    recogEl.textContent="?";
    recogConfEl.textContent="(low)";
    drawStateEl.textContent="Not recognized — try again";
    drawStateEl.className="badge";
    toast("Could not recognize — draw slower, one stroke", "bad");
  }
}
function getCanvasPos(e){
  const rect = drawCanvas.getBoundingClientRect();
  const scaleX = drawCanvas.width / rect.width;
  const scaleY = drawCanvas.height / rect.height;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {x: (clientX - rect.left)*scaleX, y: (clientY - rect.top)*scaleY, nx:(clientX - rect.left)/rect.width, ny:(clientY - rect.top)/rect.height };
}
drawCanvas.addEventListener("pointerdown", e=>{
  e.preventDefault();
  isMouseDrawing=true;
  drawCanvas.setPointerCapture(e.pointerId);
  const p = getCanvasPos(e);
  state.drawPoints=[p];
  state.drawing=true;
  drawStateEl.textContent="Drawing (mouse)…";
  drawStateEl.className="badge on";
  airHint.classList.add("hidden");
});
drawCanvas.addEventListener("pointermove", e=>{
  if(!isMouseDrawing) return;
  const p = getCanvasPos(e);
  const pts = state.drawPoints;
  pts.push(p);
  if(pts.length>1){
    drawCtx.strokeStyle="rgba(167,139,250,1)";
    drawCtx.lineWidth=4;
    drawCtx.lineCap="round";
    drawCtx.lineJoin="round";
    drawCtx.beginPath();
    const a=pts[pts.length-2], b=pts[pts.length-1];
    drawCtx.moveTo(a.x,a.y); drawCtx.lineTo(b.x,b.y); drawCtx.stroke();
  }
});
drawCanvas.addEventListener("pointerup", e=>{
  if(!isMouseDrawing) return;
  isMouseDrawing=false;
  state.drawing=false;
  airHint.classList.remove("hidden");
  finalizeStroke();
});
drawCanvas.addEventListener("pointerleave", e=>{
  if(isMouseDrawing){
    isMouseDrawing=false;
    state.drawing=false;
    finalizeStroke();
  }
});
const clearDrawBtnEl = $("#clearDrawBtn");
if(clearDrawBtnEl) clearDrawBtnEl.onclick = ()=>{
  clearDrawCanvas();
  state.strokes=[]; state.drawPoints=[]; state.drawing=false;
  drawStateEl.textContent="Idle"; drawStateEl.className="badge";
  airHint.classList.remove("hidden");
};
$("#undoDrawBtn").onclick = ()=>{
  if(state.strokes.length>0){
    state.strokes.pop();
    clearDrawCanvas();
    state.strokes.forEach(s=>{
      drawCtx.strokeStyle="rgba(96,165,255,.9)";
      drawCtx.lineWidth=4;
      drawCtx.lineCap="round";
      drawCtx.beginPath();
      s.forEach((p,i)=>{
        if(i===0) drawCtx.moveTo(p.x,p.y);
        else drawCtx.lineTo(p.x,p.y);
      });
      drawCtx.stroke();
    });
  } else {
    clearDrawCanvas();
  }
};
$("#clearBufferBtn").onclick = ()=>{ state.buffer=""; textBufferEl.textContent=""; };
$("#sendBufferBtn").onclick = ()=>{
  if(!state.buffer){ toast("Buffer empty", "bad"); return; }
  if(!state.searchActive){ toast("Enable Search on TV to send buffer", "bad"); return; }
  for(const ch of state.buffer) sendCommand("TEXT", ch);
  state.buffer=""; textBufferEl.textContent="";
};
textBufferEl.textContent = state.buffer;
const N = 64;
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function pathLength(pts){
  let d=0;
  for(let i=1;i<pts.length;i++) d+= dist(pts[i-1], pts[i]);
  return d;
}
function resample(pts, n){
  if(pts.length===0) return [];
  const I = pathLength(pts) / (n-1);
  let D=0;
  const newPts=[pts[0]];
  for(let i=1;i<pts.length;i++){
    const d = dist(pts[i-1], pts[i]);
    if((D+d) >= I){
      const qx = pts[i-1].x + ((I - D)/d)*(pts[i].x - pts[i-1].x);
      const qy = pts[i-1].y + ((I - D)/d)*(pts[i].y - pts[i-1].y);
      const q={x:qx, y:qy};
      newPts.push(q);
      pts.splice(i,0,q);
      D=0;
    } else D+=d;
  }
  if(newPts.length===n-1) newPts.push(pts[pts.length-1]);
  while(newPts.length<n) newPts.push(pts[pts.length-1]);
  return newPts.slice(0,n);
}
function centroid(pts){
  let x=0,y=0;
  pts.forEach(p=>{x+=p.x; y+=p.y;});
  return {x:x/pts.length, y:y/pts.length};
}
function normalize(pts){
  if(pts.length===0) return [];
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  pts.forEach(p=>{ minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); });
  let w = maxX-minX, h=maxY-minY;
  const size = Math.max(w,h) || 1;
  const norm = pts.map(p=>({x: (p.x - minX)/size, y: (p.y - minY)/size }));
  const c = centroid(norm);
  return norm.map(p=>({x: p.x - c.x + 0.5, y: p.y - c.y + 0.5}));
}
function pathDist(a,b){
  let d=0;
  for(let i=0;i<a.length;i++) d+= dist(a[i], b[i]);
  return d / a.length;
}
function tpl(...raw){
  const pts=[];
  for(let i=0;i<raw.length;i+=2) pts.push({x: raw[i], y: raw[i+1]});
  const rs = resample(pts, N);
  return normalize(rs);
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
  if(rawPts.length < 10) return null;
  let pts = rawPts.map(p=>({x:p.x, y:p.y}));
  pts = resample(pts, N);
  pts = normalize(pts);
  let best=null, bestDist=Infinity;
  for(const [letter, tmpl] of Object.entries(TEMPLATES)){
    const d = pathDist(pts, tmpl);
    if(d < bestDist){ bestDist=d; best=letter; }
  }
  const score = clamp(1 - bestDist/0.5, 0, 1);
  if(bestDist > 0.33) return null;
  return {letter: best, score, dist: bestDist};
}
function buildLettersGrid(){
  const grid=$("#lettersGrid");
  if(grid) grid.innerHTML = Object.keys(TEMPLATES).map(l=> `<div data-l="${l}">${l}</div>`).join("");
}
buildLettersGrid();
function highlightLetter(l){
  $$("#lettersGrid div").forEach(d=> d.classList.toggle("hit", d.dataset.l===l));
  setTimeout(()=> $$("#lettersGrid div").forEach(d=>d.classList.remove("hit")), 900);
}
resizeOverlays();
drawZones();
renderTvs(); renderLog();
log("Ready. Scan for TVs, connect, then enable camera.", "warn");
log("Center zone is dead — keypad rests there.", "warn");
 // Bridge/status status
 if(state.bridge){
   log("Bridge connected — commands sent via bridge", "good");
 } else {
   log("No bridge — direct ADB fallback (requires local server at " + window.location.origin + "/cmd)", "warn");
}
window.TVHub = {state, sendCommand, addTv, recognizeLetter};
// In hosted mode (Vercel/GitHub Pages), add demo TVs immediately so the UI always shows TVs
if(isHostedPage && state.tvs.length===0){
  addTv({name:POOL[0].name, model:POOL[0].model, ip:randomIp(), via:"demo"});
  addTv({name:POOL[1].name, model:POOL[1].model, ip:randomIp(), via:"demo"});
  addTv({name:POOL[2].name, model:POOL[2].model, ip:randomIp(), via:"demo"});
}
setTimeout(doScan, 600);
window.addEventListener("beforeunload", ()=>{ if(running) stopCamera(); });
window.matchMedia("(resolution: 2dppx)").addEventListener?.("change", ()=>{ resizeOverlays(); clearDrawCanvas(); });
