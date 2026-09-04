# Vercel Deployment Guide

## Overview
Deploy the **web interface** to Vercel's global CDN for fast, worldwide access. The **proxy server** must run locally on each user's network.

```
┌─────────────────┐       ┌────────────────────┐       ┌─────────────────┐
│  Vercel CDN     │  →    │  User Browser      │  →    │  Local Proxy    │
│  (Global UI)    │       │  (Connects here)   │       │  (Port 5001)    │
└─────────────────┘       └────────────────────┘       └─────────┬───────┘
                                                                 ↓
                                                         ┌─────────────────┐
                                                         │  Android TV     │
                                                         │  (Local LAN)    │
                                                         └─────────────────┘
```

## Quick Deploy

### 1. Deploy Web UI to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Navigate to facilities folder
cd facilities

# Deploy
vercel --prod
```

### 2. Users Connect to Vercel UI

When users visit your deployed URL (e.g., `https://your-app.vercel.app`):
- They see the beautiful remote interface
- The UI automatically tries to connect to `http://localhost:5001`
- Users must have the proxy running locally

## For Local Development

Users cloning your repo will run both:

```bash
# Terminal 1 - Start proxy
cd facilities
node remote-proxy.js

# Terminal 2 - Open web UI (or use Vercel URL)
open remote-web-ui.html
# or visit https://your-app.vercel.app
```

## Environment Variables

Set these in Vercel Dashboard (if needed):

| Variable | Default | Purpose |
|----------|---------|---------|
| `Vercel_URL` | - | Your deployed URL for API proxy fallback |
| `PROXY_PORT` | 5001 | Local proxy port reference |

## User Setup Instructions

Include this in your app description:

> **"To control your TV, you need to:"**
> 1. Install Node.js 18+
> 2. Download the proxy from [your-github-repo]
> 3. Run: `node facilities/remote-proxy.js`
> 4. Open [your-vercel-url] in browser
> 5. Click "Discover TVs"!

## Alternative: Embedded WebSocket

For advanced users, the web UI can connect directly to WebSocket:

```javascript
// In the HTML, users can configure:
const PROXY_URL = "wss://your-user-server.com"; // For cloud proxy
const PROXY_URL = "ws://localhost:5001"; // For local (default)
```

## Advanced: Cloud Proxy Fallback

For users who can't run a local proxy, you could:
1. Offer a self-hosted option (Raspberry Pi, VPS)
2. Users point the UI to their cloud instance
3. Configure firewall to allow UDP 57300

## Benefits of Vercel Deployment

✅ **Global CDN** - Fast load times worldwide
✅ **Automatic HTTPS** - Secure by default
✅ **Zero config** - Works out of the box
✅ **Easy updates** - Git push to deploy
✅ **Free tier** - Perfect for personal use

## Custom Domain (Optional)

```bash
# Add custom domain
vercel domains add tv-remote.example.com

# Update the HTML with your domain if needed
```

## Package for Vercel

The project includes:
- `vercel.json` - Deployment routing
- `remote-web-ui.html` - Single-file web interface  
- `remote-proxy.js` - Independent proxy server
- `api/` - (Future) Cloud proxy functions

## Summary

**Your Vercel app = The remote control interface**
**User's local machine = The TV connectivity bridge**

This separation ensures:
- Fast global access to the UI
- Secure local network TV control
- No cloud exposure of your TV network

---

**Ready to deploy?** Run `vercel` in the facilities folder! 🚀