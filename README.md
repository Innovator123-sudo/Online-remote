# Online Remote — Gesture TV Remote

Phone → TV remote signals, exactly like a physical remote. No Cast, no apps opening on screen, Home never disconnects. Same Wi-Fi.

## Gestures (camera grid)
|---|---|
| Palm in ▲ ▼ ◀ ▶ zone (hold ~1.2s) | Arrow key |
| 👍 Thumbs-up or ✊ fist (hold) | OK |
| 👎 Thumbs-down (hold) | Back |
| ✌️ Two fingers, draw a letter | Types it — only while 🔍 Search is on |
| CENTER zone | Idle rest space |

Keyboard too: arrows, Enter=OK, Backspace=Back, H=Home, M=Mute, Space=pause.

## Run it — cloud-first, no localhost needed

**A. Cloud relay (recommended):** the hosted page drives the TV through `/api/tv`.
1. Make the TV reachable from the internet **once**: router port-forward, e.g. external TCP `15555` → `TV-IP:5555` (or use the TV's global IPv6). No port forward = no cloud path, it's that simple.
2. On the TV: Developer options → Network/USB debugging ON.
3. Open the site, paste your relay key once (your invite link carries it), type the TV address (`public-ip:15555` or hostname), Connect. Accept the on-TV prompt if shown.

**B. Home helper (same Wi-Fi, no router changes):** `node helper.js` on any home machine (phone via Termux works), open the printed 📱 LAN URL — or the cloud URL with `?bridge=HELPER-IP` once.

On the TV (once): enable Developer options → Network/USB debugging, accept the prompt.

## Files

```
index.html       — UI (connect, remote, gesture grid, fullscreen zones)
style.css        — mobile-first theme
app.js           — gestures + draw recognizer + remote client (zero deps)
helper.js        - home helper: static host + discovery + ADB signals (zero deps)
termux-setup.sh  — one-shot phone installer
```

Deploys anywhere static: Vercel, Netlify, GitHub Pages.
