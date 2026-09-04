# Online Remote — Gesture TV Remote

Phone → TV remote signals, exactly like a physical remote. No Cast, no apps opening on screen, Home never disconnects. Same Wi-Fi.

## Gestures (camera grid)

| Do this | Sends |
|---|---|
| Palm in ▲ ▼ ◀ ▶ zone (hold ~1.2s) | Arrow key |
| 👍 Thumbs-up or ✊ fist (hold) | OK |
| 👎 Thumbs-down (hold) | Back |
| ✌️ Two fingers, draw a letter | Types it — only while 🔍 Search is on |
| CENTER zone | Idle rest space |

Keyboard too: arrows, Enter=OK, Backspace=Back, H=Home, M=Mute, Space=pause.

## Run it (pick one — phone needs no laptop)

**A. Entirely on your phone (recommended):** install Termux, paste:
```sh
pkg install -y nodejs git android-tools && git clone https://github.com/Innovator123-sudo/Online-remote.git && cd Online-remote && node helper.js
```
Then open **http://localhost:5000** in Chrome. Done.

**B. From any home PC:** `node helper.js`, open the printed 📱 LAN URL on your phone (same Wi-Fi).

**C. Cloud page:** open the hosted URL with `?bridge=PHONE-OR-PC-IP` once (it remembers).

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
