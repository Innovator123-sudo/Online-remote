# ⚡ Lightweight Android TV Remote (CRYSTAL Protocol)

A fast, lightweight TV remote controller that uses the official Android TV Remote Control Protocol (CRYSTAL/BTP) instead of ADB.

## Features

✅ **No ADB Required** - Uses official Google TV Remote Protocol  
✅ **Low CPU Usage** - No subprocess spawning overhead  
✅ **Fast Response** - Direct UDP communication  
✅ **Battery Efficient** - Optimized for continuous use  
✅ **Simple Setup** - Just enable remote control on your TV  

## Files

- `facilities/u_REMOTE.js` - The TV remote server (port 5001)
- `facilities/remote-test.html` - Web-based remote control UI

## Setup

### 1. Enable Remote Control on Your TV

On your Android TV / Google TV:
1. Go to **Settings** → **Remotes & Accessories**
2. Select **Android TV Remote Control**
3. Enable the service (it's usually enabled by default)

### 2. Start the Remote Server

```bash
npm run remote
```

The server will start on `http://localhost:5001`

### 3. Connect to Your TV

Option A - Using the Web UI:
1. Open `facilities/remote-test.html` in a browser
2. Enter your TV's IP address (e.g., `192.168.1.100`)
3. Click "Connect"
4. Accept the pairing request on your TV

Option B - Using the API:
```bash
# Discover TVs on the network
curl http://localhost:5001/discover

# Connect to a specific TV
curl "http://localhost:5001/connect?ip=192.168.1.100"

# Send a key press (key code 23 = OK/Enter)
curl "http://localhost:5001/key?ip=192.168.1.100&key=23"

# Send text
curl "http://localhost:5001/text?ip=192.168.1.100&text=Hello"

# Check status
curl http://localhost:5001/status
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /discover` | Find all Android TVs on the network |
| `GET /connect?ip=IP` | Connect to TV at IP address |
| `GET /disconnect?ip=IP` | Disconnect from TV |
| `GET /status` | List all connected TVs |
| `GET /key?ip=IP&key=CODE` | Send a key code |
| `GET /text?ip=IP&text=TEXT` | Send text input |
| `GET /up`, `/down`, `/left`, `/right` | Directional buttons |
| `GET /ok` | Select button |
| `GET /back` | Back button |
| `GET /home` | Home button |
| `GET /mute` | Mute button |
| `GET /power` | Power button |
| `GET /playpause` | Play/Pause button |

## Key Codes

| Key | Code | Key | Code |
|-----|------|-----|------|
| UP | 19 | VOLUME UP | 24 |
| DOWN | 20 | VOLUME DOWN | 25 |
| LEFT | 21 | MUTE | 164 |
| RIGHT | 22 | POWER | 26 |
| OK | 23 | PLAY/PAUSE | 85 |
| BACK | 4 | STOP | 86 |
| HOME | 3 | NEXT | 87 |
| MENU | 82 | PREVIOUS | 88 |

## How It Works

The CRYSTAL Protocol (also known as BTP - Bluetooth Transfer Protocol over IP) is Google's official protocol for the Android TV Remote Control app. This implementation:

1. **Discovers TVs** via UDP broadcast on port 57300
2. **Establishes connection** using the standard Android TV handshake
3. **Sends key events** as UDP packets with the proper binary protocol format
4. **Receives responses** for status updates and pairing confirmations

## Troubleshooting

**Connection times out:**
- Make sure TV and computer are on the same network
- Check that "Android TV Remote Control" is enabled on the TV
- Try disabling firewall temporarily
- Make sure the TV is not in standby/power save mode

**Keys not working:**
- Verify you're connected (check status endpoint)
- Try reconnecting to the TV
- Make sure TV accepts remote control input

**Server doesn't start:**
- Make sure you're using Node.js 22.x
- Check if port 5001 is already in use
- Try changing the port: `REMOTE_PORT=5002 npm run remote`

## License

MIT