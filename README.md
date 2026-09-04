# Cast Remote — Gesture Edition

Phone → Chromecast directly. No PC, no bridge, no pairing codes, no typing.

## Use it

1. Phone joins **home Wi-Fi** (mobile data off).
2. Open the site in **Chrome on Android**.
3. Tap **📺 Connect my TV** → pick the Chromecast.
4. Use the buttons, keyboard, or hand gestures.

## What each key does (Chromecast has no menu arrows)

| Input | Action |
|---|---|
| ▲ / ▼ zones or buttons | Volume up / down |
| ◀ / ▶ zones or buttons | Skip ∓30s |
| OK / ✊ fist / Enter | Play / pause |
| 👎 thumb-down / Back | Quit app → home |
| Home / Off | Quit app → backdrop |

Gestures: hold your hand steady in a zone (~1.2s hold-to-click). CENTER is idle rest-space. `Space` pauses.

## Run it

- **Hosted:** just open the deployed URL (Vercel / GitHub Pages, static files only).
- **Home LAN without internet:** `node server.js` → open the printed LAN URL on any same-Wi-Fi phone.

## Files

```
index.html  — Cast-first UI
style.css   — theme
app.js      — Cast SDK + remote + MediaPipe gesture engine (zero deps)
server.js   — optional static host for the home LAN
```
