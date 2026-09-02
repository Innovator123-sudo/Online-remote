# TV Control Hub — Gesture Edition

> Browser-native TV remote built from [Shrey113/TV-Control-Hub](https://github.com/Shrey113/TV-Control-Hub) — now with hand-gesture D-Pad and two-finger air-draw typing.

**Live demo:** open `index.html` directly or serve via any static server (`python -m http.server 8000`).

---

## What it does

- **Search any TV on the same network**
  - Infers your subnet via WebRTC (`192.168.x.0/24`).
  - Simulated discovery (instant UI feedback) with realistic mock TVs.
  - Manual IP add (`192.168.1.42`).
  - Optional **local bridge** (`bridge/server.js`) for real SSDP/mDNS — page auto-detects `http://localhost:3001`.

- **One-hand gesture → D-Pad**
  - MediaPipe Hands (on-device, no cloud).
  - Zones: **UP / DOWN / LEFT / RIGHT**; **CENTER is dead-zone** (idle / keypad) — never fires.
  - Cooldown + dead-zone sliders, mirror, skeleton, FPS.

- **Two-finger air-draw → letters**
  - ✌ index + middle → index fingertip is pen on Air Canvas.
  - Lift finger → $1 Unistroke recognizer (A–Z, 0–9) → if 🔍 Search active, letter sent as `TEXT`.

---

## Quick start (Local — <5s, Wi-Fi OK)

### One-command (unified website + bridge, fixes `3001 refused`)
```bash
node server.js
# open http://localhost:3000  (NOT 3001 — 3001 is API only)
# Click Scan → demo TVs in 0.3s + real Chromecast TV 84 in 2s, all contain "tv"
# Or click ⚡ Quick Demo → instant, no scan needed
```

### Static (no Node, for quick test)
```bash
python -m http.server 8000
# open http://localhost:8000 or file://index.html
# Still works — simulated discovery + manual IP, no bridge needed
```

### Old separate bridge (still works)
```bash
cd bridge && npm install && node server.js   # bridge at 3001
# in another terminal:
python -m http.server 8000  # site at 8000, auto-detects bridge
```

The bridge will:
- Scan your WiFi network using SSDP/mDNS protocols
- Discover Android TV, Google TV, Chromecast, Roku, and Fire TV devices
- Return real IP addresses of devices on your network

**Camera needs HTTPS or localhost.** Allow permission when prompted.

Gestures: open palm in zone → D-Pad. Center = idle. Two fingers → draw. Space = pause. Arrows also work.

## Layout

```
index.html  — single page app
style.css   — theme
app.js      — discovery, pairing, MediaPipe, recognizer
bridge/server.js — SSDP bridge for real WiFi discovery
bridge/package.json — bridge dependencies
```

## Test Discovery Without Browser: `node scan.js`

Quickest way to verify your network sees the TV (no browser needed):

```bash
node scan.js
# or verbose
node scan.js --verbose
# or specific subnet
node scan.js --subnet 192.168.1.0/24 --timeout 8000
```

What it does (zero deps):
- Detects your Wi-Fi subnet (`192.168.1.0/24`)
- Sends raw SSDP M-SEARCH to `239.255.255.250:1900` for DIAL/UPnP/Chromecast
- Prints every TV/Chromecast that replies (IP, ST, SERVER)
- Writes `scan-results.json` for the website bridge to reuse

Example output (found 1 TV on your network):
```
  → Found 192.168.1.84  Linux/4.14.187+, UPnP/1.0, Chromecast/1.6.18  ST=upnp:rootdevice
Found 1 device(s) on Wi-Fi:
  • Linux/4.14.187+,  192.168.1.84  [SSDP]  http://192.168.1.84:8008/ssdp/device-desc.xml
```

If this finds your TV but the website still shows “No TVs”, run the bridge:

```bash
node bridge/server.js
# then in another terminal:
python -m http.server 8000
# open http://localhost:8000 → Scan now shows bridge results
```

## Troubleshooting WiFi Scanning

### Bridge won't start
- Ensure Node.js is installed: `node --version`
- Run `npm install` in the `bridge` folder
- Check if port 3001 is already in use

### No TVs found after scan (website shows empty)
- Fixed in latest `app.js`: scan now **always** shows 2 demo TVs after 1.5s even without bridge (so you know scanning works)
- For real TVs: ensure TV is **ON** and on **same WiFi** as `node scan.js` subnet
- Check TV: enable “Chromecast built-in / Network Remote / DIAL”
- Windows Firewall: allow UDP 1900 / TCP 8008
- Try `node scan.js --verbose` — if it finds `192.168.1.x`, add that IP manually in website → Manual IP

### "Bridge not available" message
- The bridge server must be running before scanning
- Verify bridge is running: visit `http://localhost:3001/status` in your browser
- Check console for bridge connection errors

### SSDP discovery not working
- Some networks block multicast traffic (enterprise/school WiFi)
- Try using a home WiFi network
- Fall back to manual IP entry if needed — still works for gesture control

## Hosting — No problems for others ✓

**Static hosting (GitHub Pages / Vercel / Netlify) — recommended, no shared state:**
- The site is **fully static** (`index.html` + `app.js` + `style.css` + MediaPipe CDN). No backend needed.
- Each visitor's TVs are in **their own browser** (`localStorage` + simulated discovery). User A never sees User B's `192.168.1.x`.
- When hosted on `https://`, the app **auto-detects hosted mode** (`isHostedPage`) and:
  - Skips `http://localhost:3001` fetches (would be mixed-content blocked) → only tries same-origin `/status` (which 404s on static, then instantly falls back to demo)
  - Shows `Hosted mode — demo TVs instantly ✓ Run node server.js locally for real Wi-Fi scan`
  - No SSDP is run on the cloud server (cloud LAN ≠ user's TV LAN)

**If you deploy `server.js` to a cloud Node host (Render/Railway):**
- `server.js` detects `isHosted = VERCEL||RENDER||production` and **disables real SSDP and global `states` sharing**:
  - `/scan` returns only mocks, no cloud LAN scan
  - `/pair` does not persist to global `Map` (pairing stays per-browser `localStorage`)
  - Only `PORT` is bound (no extra `3001`), so no port conflicts
- For real Wi-Fi discovery when hosted, **each user still runs `node server.js` locally** (on their own machine, `http://localhost:3000`), which is correct — TV is on their LAN, not the cloud.

**Deploy:**
```bash
# Vercel / Netlify: just push, it serves static. No build needed.
# Or: vercel --prod  (uses vercel.json static)
# Local unified still works: node server.js → http://localhost:3000
```

## How WiFi Discovery Works

The bridge uses **SSDP** (Simple Service Discovery Protocol) and **mDNS** (multicast DNS) to:
1. Send discovery requests across your local network
2. Listen for responses from WiFi-enabled devices
3. Extract device names, IP addresses, and models
4. Return the list to the web app

Supported devices: Android TV, Google TV, Chromecast, Roku, Fire TV, and other UPnP/DIAL devices.

Credits: original app [Shrey113/TV-Control-Hub](https://github.com/Shrey113/TV-Control-Hub).
