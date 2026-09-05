# Online Remote — Gesture TV Remote

Browser → TV remote. One flow only: **type TV IP → Send code to TV → type the TV code → Connect.** Nothing else.

## Use it (2 minutes, first time)

1. On this PC: `npm run helper` (keep it running).
2. On your phone (same Wi-Fi): open **http://192.168.1.67:5000**.
3. Type the TV IP (e.g. `192.168.1.84`) → **Send code to TV**.
4. Read the code on the TV screen → type it → **Connect**.
5. Done — D-pad, typing, and gestures work. Next time just open the page and tap **Connect** (approval is remembered).

Codes can be digits (`482913`) or hex (`E2D12F`) — type exactly what the TV shows.

## Why this address and not the public link

A public internet page cannot reach a home TV (`192.168.x.x`) — browsers block it and the address doesn't exist outside your house. So the working page is the one served by your own PC on your own Wi-Fi. The Vercel link hosts the same files as a backup.

## Files

```
index.html       — UI (pair box, remote, gesture grid, fullscreen zones)
remote.js        — IP/code pairing + keys + gesture engine + camera (no deps)
helper.js        — home PC server: serves the page + TV pairing/keys
remote2.js       — Android TV Remote v2 protocol (pair PIN, cert saved in remote-certs/)
style.css        — mobile-first theme
sw.js            — offline cache
```

Home PC needs one install ever: `npm install` (for `androidtv-remote`).
