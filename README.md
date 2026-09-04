# Online Remote — Gesture TV Remote

Control your TV from your phone browser. Same Wi-Fi, nothing to install.

## Gestures (camera grid)

| Do this | Sends |
|---|---|
| Palm in ▲ ▼ ◀ ▶ zone (hold ~1.2s) | Arrow key |
| 👍 Thumbs-up (hold) | OK |
| 👎 Thumbs-down (hold) | Back |
| ✌️ Two fingers, draw a letter | Types it — only while 🔍 Search is on |
| CENTER zone | Idle rest space |

Keyboard works too: arrows, Enter=OK, Backspace=Back, H=Home, M=Mute, Space=pause.

## Connect

- **Chromecast:** tap 📺 Connect my TV and pick it. No PC needed. (Media keys: volume, ±30s, play/pause, home.)
- **Android TV, full control (arrows + typing):** run the tiny helper on any home-Wi-Fi machine, then open the printed LAN URL on your phone — or open this hosted page once with `?bridge=PC-IP`:
  ```bash
  node server.js
  # → http://localhost:5000  (+ 📱 LAN URL for phones)
  ```
  On the TV: enable Developer options → Network/USB debugging, accept the prompt once.

## Files

```
index.html  — UI (connect, remote, gesture grid, fullscreen zones)
style.css   — mobile-first theme
app.js      — Cast SDK + bridge client + MediaPipe gestures + letter recognizer (zero deps)
server.js   — optional home helper: static host + SSDP discovery + ADB commands (zero deps)
```

Deploys anywhere static: Vercel, Netlify, GitHub Pages.
