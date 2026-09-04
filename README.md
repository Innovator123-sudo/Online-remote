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
3. Open the site and tap **Scan**, then tap your TV in the list — the TV shows an Allow prompt, tap **Allow** there, done. (No addresses: with the helper on the same Wi-Fi, discovery is automatic. Over the internet, type the address once or use the Pair-with-code box.)

**B. Home helper (same Wi-Fi, no router changes):** `npm install && node helper.js` on a home PC / laptop (same Wi-Fi as the TV), open the printed 📱 LAN URL on your phone — or type that address into the helper box on the hosted page and tap Use.

On the TV (once): enable Developer options → Network/USB debugging, accept the prompt.

## Files

```
index.html       — UI (connect, remote, gesture grid, fullscreen zones)
style.css        — mobile-first theme
app.js           — gestures + draw recognizer + remote client (zero deps)
helper.js        - home helper: static host + discovery + ADB signals (zero deps)
```

Deploys anywhere static: Vercel, Netlify, GitHub Pages.
