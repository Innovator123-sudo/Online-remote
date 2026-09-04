# Android TV Remote - Web Interface

A cloud-deployable TV remote system that uses the CRYSTAL Protocol (official Android TV Remote Control) to control Android TVs without requiring ADB.

## 🚀 Quick Start

### 1. Enable Remote Control on Your Android TV
- Go to **Settings** → **Apps** → **Android TV Remote Control** (or similar)
- Enable "Remote Control" or "Device Power"
- Note the TV's IP address

### 2. Install Dependencies
```bash
cd facilities
npm install
```

### 3. Start the Proxy Server
```bash
npm start
```
The server will run on `http://localhost:5001`

### 4. Open the Web Interface
- Simply open `remote-web-ui.html` in your browser, OR
- Run `npx serve .` and navigate to the URL
- Click "Discover TVs" to auto-scan for devices
- Select your TV and start controlling!

## 🎮 Features

- **Auto-Discovery**: Automatically finds all Android TVs on your network
- **No ADB Required**: Uses official CRYSTAL Protocol directly over UDP
- **Full Remote Control**:
  - D-pad navigation (Up, Down, Left, Right, OK)
  - Home, Back, Menu buttons
  - Volume control (Up, Down, Mute)
  - Power button
  - Media controls (Play, Pause)
  - Input source selection
- **Real-time Status**: Connection status and feedback
- **Modern UI**: Clean, responsive design with gradient background

## 🔧 How It Works

```
Browser (remote-web-ui.html)
    ↓ HTTP/WebSocket
Local Proxy Server (remote-proxy.js:5001)
    ↓ CRYSTAL Protocol (UDP 57300)
Android TV
```

The proxy server:
1. Broadcasts discovery packets on UDP port 57300
2. Listens for TV responses with device info
3. Maintains WebSocket connections for real-time control
4. Converts HTTP requests to CRYSTAL Protocol commands

## 📡 CRYSTAL Protocol

This system uses the CRYSTAL Protocol, the official protocol used by Google's Android TV Remote Control app:
- **Transport**: UDP
- **Port**: 57300
- **Discovery**: Broadcasts on local network
- **Communication**: Binary protocol with version negotiation

The proxy handles all protocol details including:
- Binary message encoding/decoding
- Version handshake (versions 2-8 supported)
- Key code transmission
- Connection state management

## 🌐 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/discover` | GET | Auto-discover TVs |
| `/connect?ip=IP` | GET | Connect to TV |
| `/key?ip=IP&key=CODE` | GET | Send key press |
| `/text?ip=IP&text=TEXT` | GET | Send text |

### Key Codes Reference

| Code | Key | Code | Key |
|------|-----|------|-----|
| 3 | Home | 23 | OK |
| 4 | Back | 24 | Volume+ |
| 19 | Up | 25 | Volume- |
| 20 | Down | 26 | Power |
| 21 | Left | 82 | Menu |
| 22 | Right | 85 | Play/Pause |
| 164 | Mute | 178 | Input |

## 🐳 Docker Deployment

```bash
# Build
docker build -t android-tv-remote .

# Run
docker run -p 5001:5001 --network host android-tv-remote
```

> **Note**: For network discovery to work, use `--network host` so the container can access local network UDP broadcasts.

## ☁️ Cloud Deployment

This system is designed for **local network deployment**. The proxy must run on the same network as your TV.

### Options:
1. **Raspberry Pi**: Perfect for always-on home deployment
2. **Local Server**: Any PC on your network
3. **Home Server**: NAS or home server with Node.js

### Render.com Example
```yaml
services:
  - name: android-tv-remote
    type: web
    env: node
    region: oregon
    branch: main
    startCommand: node remote-proxy.js
```

## 🔒 Security

- Proxy runs on `0.0.0.0:5001` (all interfaces)
- To restrict to localhost, change `REMOT
E_HOST=127.0.0.1`
- No authentication by default (local network only)
- Each TV connection is isolated

## 🛠️ Troubleshooting

### TVs Not Discovered
- Ensure "Android TV Remote Control" is enabled on the TV
- Check firewall allows **UDP port 57300**
- Verify TV and computer are on the **same network**
- Try restarting the proxy: `Ctrl+C` then `npm start`

### Connection Fails
- Verify the TV's IP address is correct
- Check network connectivity: `ping <TV_IP>`
- Ensure TV hasn't changed IP (use static IP or DHCP reservation)

### Port Already in Use
```bash
# Find process using port 5001
netstat -ano | findstr :5001

# Change port
set REMOTE_PORT=8080 && npm start
```

### Module Not Found
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

## 📁 File Structure

```
facilities/
├── remote-proxy.js      # Node.js proxy server (477 lines)
├── remote-web-ui.html   # Web interface (single file)
├── package.json         # Dependencies and scripts
├── CLOUD_DEPLOYMENT.md  # Deployment guide
├── README.md            # This file
└── jest.config.js       # Test configuration
```

## 🧪 Testing

```bash
# Run tests
npm test

# Test specific functionality
node test-protocol.js
```

## 📚 Related Projects

- [Android TV Remote Control](https://play.google.com/store/apps/details?id=com.google.android.apps.tv Remot
e) - Official Google app
- [androidtvremote2](https://github.com/vbaranov/androidtvremote2) - Open-source Android TV remote protocol implementation

## 🤝 Contributing

Contributions welcome! Areas of interest:
- Additional TV brand support
- Enhanced discovery mechanisms
- Mobile-optimized UI improvements
- Authentication layer for remote access

## 📝 License

MIT License - Free for personal and commercial use.

## 🙏 Acknowledgments

- CRYSTAL Protocol documentation from community reverse engineering
- Google's Android TV Remote Control app for protocol inspiration
- The open-source community for protocol analysis

---

**Made with ❤️ for seamless home entertainment control**