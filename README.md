# Online Remote — Gesture TV Remote (USB-ADB, static site)

Browser → TV remote over a **USB cable**. No server, no terminal, no Wi-Fi needed.
ADB runs **inside the website** (WebUSB), gestures run on-device (MediaPipe).

## What you get

- **01 Connect** — Scan / Add USB device, one-tap Connect, Unlink
- **02 Remote** — D-pad, Home/Back/Mute/Power, text send, drawn-word send
- **03 Gestures** — palm steers arrows, 👍 = OK, 👎 = Back, ✌️ draws letters

## Setup — first time (2 minutes)

**On the TV (once):**
1. Settings → About → tap **Build number 7×** → Developer options appear.
2. Settings → Developer options → turn **USB debugging ON**.
3. Plug the TV into your phone/PC with a USB cable.

**On the site:**
4. Open your hosted URL in **Chrome or Edge** (WebUSB is Chromium-only;
   iPhone/iPad Safari won't work — use an Android phone or a PC).
   The page must be `https://…` (Vercel gives you that) or `localhost`.
5. Tap **Scan for my TV** (or **Add USB device**) → pick the TV in the
   browser's USB picker.
6. On the TV, tick **Always allow** → tap **Allow**.
7. Done — D-pad, keyboard (`Arrows/Enter/Backspace/H/M`), and gestures work.

Next visits: plug in → open site → **Scan** → Connect. The key is remembered.

## Deploy on Vercel (static, free)

This repo is pure static — no functions, no env vars, no build step.

- **Option A — Vercel dashboard:** Push this folder to GitHub → vercel.com →
  Add New → Project → Import the repo → Deploy. No settings to change.
- **Option B — CLI:** `npm i -g vercel` → `vercel` (link) → `vercel --prod`.

Files served: `index.html`, `remote.js`, `adb-site.js`, `style.css`,
`sw.js`, `manifest.webmanifest`, `icon.svg`.

## Requirements / limits

- Chromium browser (Chrome/Edge, Android or desktop). No Firefox/Safari USB.
- Secure context: `https://` or `localhost` (else USB + camera are blocked).
- One USB cable between the browsing device and the TV.
- Gestures need camera permission + good light, 40–80 cm from camera.

## Files

```
index.html       — UI (connect, remote, gesture grid, fullscreen zones)
remote.js        — USB connect/send + gesture engine + camera (no deps)
adb-site.js      — in-site ADB over WebUSB (Tango, CDN-cached, no install)
style.css        — mobile-first theme
sw.js            — offline cache for the shell + CDN libs
```
