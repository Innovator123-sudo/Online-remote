/**
 * Cast Remote — tiny static host (optional).
 * The website needs NO server: it talks phone → Chromecast directly.
 * This is only for opening the site over your home Wi-Fi without internet:
 *
 *   node server.js   →   http://localhost:5000  (+ a 📱 LAN URL it prints)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.PORT, 10) || 5000;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let filePath = url.parse(req.url).pathname;
  if (filePath === '/') filePath = '/index.html';
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'index.html');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  let lanIp = '';
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) {
        if (n.family === 'IPv4' && !n.internal && /^(192\.168\.|10\.|172\.)/.test(n.address)) { lanIp = n.address; break; }
      }
      if (lanIp) break;
    }
  } catch {}
  console.log(`\n✅ Cast Remote at http://localhost:${PORT}/`);
  if (lanIp) console.log(`   📱 Same Wi-Fi phones:  http://${lanIp}:${PORT}/`);
  console.log('');
});
