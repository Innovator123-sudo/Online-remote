/* Online Remote — in-website ADB (no terminal, no external install).
 *
 * The "main adb" lives INSIDE the website now:
 *  - Tango ADB (yume-chan) is lazy-loaded from CDN as ES modules and then
 *    cached by the browser + service worker, so after first visit it works
 *    from cache ("installed as cache in the website").
 *  - Transport is WebUSB: plug the TV / Android box into this device with a
 *    USB cable, tap a button ON THIS PAGE, approve "Allow USB debugging" on
 *    the TV once — every later Scan/Connect/Key happens from the site.
 *  - Device scanning is also in-site: navigator.usb enumeration +
 *    permission picker, no `node helper.js`, no terminal, no adb.exe.
 *
 * Exposes window.SiteAdb:
 *   supported() -> {ok, reason}
 *   ensureLib(statusCb) -> loads ESM libs (cached)
 *   scanUsb() -> already-permitted USB ADB devices (no picker, instant)
 *   pickUsb() -> opens browser USB picker (needs user click), returns device
 *   connectUsb(device) -> authenticate + open Adb, returns info
 *   disconnect()
 *   isConnected(), current()
 *   shell(cmd) -> run `adb shell <cmd>`, returns trimmed stdout
 *   sendKeyevent(code), sendText(str)
 *   onChange(cb) — subscribe to connection changes
 */

(function () {
  'use strict';

  const ESM_VERSION = '2.6.2';
  const LIB_URLS = {
    adb: `https://esm.sh/@yume-chan/adb@${ESM_VERSION}?bundle`,
    webusb: `https://esm.sh/@yume-chan/adb-daemon-webusb@${ESM_VERSION}?bundle&external=@yume-chan/adb`,
    cred: `https://esm.sh/@yume-chan/adb-credential-web@${ESM_VERSION}?bundle&external=@yume-chan/adb`,
  };

  const KEYEVENT_DEFAULT = { UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, OK: 23, BACK: 4, HOME: 3, MUTE: 164, POWER: 26 };

  const S = {
    lib: null,          // { Adb, AdbDaemonTransport, Manager, CredentialStore }
    libPromise: null,
    manager: null,
    credentialStore: null,
    rawDevice: null,    // AdbDaemonWebUsbDevice
    transport: null,
    adb: null,
    info: null,         // {serial, productName, manufacturer}
    listeners: new Set(),
  };

  function emit() {
    const snap = snapshot();
    S.listeners.forEach((cb) => { try { cb(snap); } catch {} });
  }

  function snapshot() {
    return {
      supported: supported().ok,
      libLoaded: !!S.lib,
      connected: !!S.adb,
      serial: (S.info && S.info.serial) || '',
      product: (S.info && (S.info.productName || S.info.name)) || '',
    };
  }

  function supported() {
    try {
      if (!window.isSecureContext) return { ok: false, reason: 'Open the https:// site (or localhost) — WebUSB needs a secure context.' };
      if (!('usb' in navigator) || !navigator.usb) {
        const ua = (navigator.userAgent || '').toLowerCase();
        const isIOS = /iphone|ipad|ipod/.test(ua);
        if (isIOS) return { ok: false, reason: 'iPhone/iPad Safari has no USB — use Chrome on Android/PC for built-in ADB.' };
        return { ok: false, reason: 'This browser has no WebUSB — use Chrome / Edge (Android or desktop).' };
      }
      return { ok: true, reason: '' };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  async function ensureLib(statusCb) {
    if (S.lib) return S.lib;
    if (S.libPromise) return S.libPromise;
    const sup = supported();
    if (!sup.ok) throw new Error(sup.reason);
    const say = (m) => { try { if (statusCb) statusCb(m); } catch {} };
    S.libPromise = (async () => {
      say('Loading built-in ADB (first time downloads, then cached)…');
      // Dynamic ESM import — browser HTTP cache + sw.js keeps it as
      // website cache, so this IS the "adb installed in the website".
      const [adbMod, webusbMod, credMod] = await Promise.all([
        import(/* webpackIgnore: true */ LIB_URLS.adb),
        import(/* webpackIgnore: true */ LIB_URLS.webusb),
        import(/* webpackIgnore: true */ LIB_URLS.cred),
      ]);
      const Adb = adbMod.Adb || adbMod.default?.Adb || adbMod.default;
      const AdbDaemonTransport =
        adbMod.AdbDaemonTransport || webusbMod.AdbDaemonTransport || adbMod.default?.AdbDaemonTransport;
      const AdbDaemonWebUsbDeviceManager =
        webusbMod.AdbDaemonWebUsbDeviceManager || webusbMod.default?.AdbDaemonWebUsbDeviceManager || webusbMod.default;
      const AdbWebCredentialStore =
        credMod.default || credMod.AdbWebCredentialStore || credMod.AdbCredentialStore;
      if (!Adb || !AdbDaemonTransport || !AdbDaemonWebUsbDeviceManager || !AdbWebCredentialStore) {
        throw new Error('ADB library shape changed — update adb-site.js pins');
      }
      const Manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      if (!Manager) throw new Error('WebUSB unavailable in this browser');
      let credentialStore;
      try {
        credentialStore = new AdbWebCredentialStore('OnlineRemote@site');
      } catch {
        credentialStore = new AdbWebCredentialStore();
      }
      S.lib = { Adb, AdbDaemonTransport, AdbDaemonWebUsbDeviceManager, AdbWebCredentialStore, Manager, credentialStore };
      S.manager = Manager;
      S.credentialStore = credentialStore;
      say('Built-in ADB ready (cached in this site).');
      emit();
      return S.lib;
    })().catch((e) => { S.libPromise = null; throw e; });
    return S.libPromise;
  }

  function fmtDevice(d, idx) {
    // d is AdbDaemonWebUsbDevice { serial, name?, raw (USBDevice) }
    const raw = (d && d.raw) || {};
    const serial = (d && (d.serial || d.serialNumber)) || raw.serialNumber || '';
    const product = (d && (d.name || d.productName)) || raw.productName || 'Android device';
    const manuf = raw.manufacturerName || '';
    return {
      kind: 'usb-adb',
      id: `usb:${serial || raw.productName || idx}`,
      serial: serial || `usb-${idx}`,
      name: serial ? `USB TV (${serial.slice(0, 12)})` : (product || 'USB TV'),
      productName: product,
      manufacturer: manuf,
      _raw: d,
    };
  }

  // In-site scanning: already-granted USB devices, no picker, no terminal.
  async function scanUsb(statusCb) {
    const lib = await ensureLib(statusCb);
    let list = [];
    try {
      list = await lib.Manager.getDevices();
    } catch (e) {
      throw new Error('USB scan failed: ' + (e.message || e));
    }
    return (list || []).map((d, i) => fmtDevice(d, i));
  }

  // In-site scanning with picker: browser shows its OWN device list.
  async function pickUsb(statusCb) {
    const lib = await ensureLib(statusCb);
    let dev = null;
    try {
      dev = await lib.Manager.requestDevice();
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || /no device/i.test(String(e.message)))) return null;
      throw e;
    }
    if (!dev) return null; // user cancelled picker
    return fmtDevice(dev, 0);
  }

  async function connectUsb(picked, statusCb) {
    const lib = await ensureLib(statusCb);
    const say = (m) => { try { if (statusCb) statusCb(m); } catch {} };
    if (S.adb) { try { await disconnect(); } catch {} }
    const raw = (picked && picked._raw) ? picked._raw : picked;
    if (!raw || typeof raw.connect !== 'function') throw new Error('Pick the USB device first (tap “Add USB device”).');
    say(`Connecting to ${picked.serial || 'USB device'}… approve “Allow USB debugging” on the TV if asked.`);
    let connection;
    try {
      connection = await raw.connect();
    } catch (e) {
      throw new Error('USB open failed — cable loose? TV USB debugging ON? (' + (e.message || e) + ')');
    }
    const serial = raw.serial || raw.raw?.serialNumber || picked.serial || 'usb-device';
    let transport;
    try {
      transport = await lib.AdbDaemonTransport.authenticate({
        serial,
        connection,
        credentialStore: lib.credentialStore,
      });
    } catch (e) {
      throw new Error('TV rejected pairing — tap “Allow” on the TV screen, then Connect again. (' + (e.message || e) + ')');
    }
    const adb = new lib.Adb(transport);
    S.rawDevice = raw;
    S.transport = transport;
    S.adb = adb;
    S.info = {
      serial,
      productName: picked.productName || raw.raw?.productName || 'Android TV',
      manufacturer: picked.manufacturer || raw.raw?.manufacturerName || '',
    };
    // Best-effort friendly model name (never blocks connect).
    try {
      const out = await shell('getprop ro.product.model');
      if (out) S.info.productName = out.slice(0, 40);
    } catch {}
    say(`USB ADB connected: ${S.info.productName} (${serial.slice(0, 16)})`);
    emit();
    return { serial, productName: S.info.productName };
  }

  async function disconnect() {
    try { if (S.adb) await S.adb.close(); } catch {}
    try { if (S.transport) await S.transport.close(); } catch {}
    S.adb = null; S.transport = null; S.rawDevice = null; S.info = null;
    emit();
  }

  function isConnected() { return !!S.adb; }
  function current() { return S.info ? { ...S.info } : null; }

  function readAll(stream) {
    // Read a WHATWG ReadableStream to string (for shell output).
    return (async () => {
      if (!stream) return '';
      if (typeof stream === 'string') return stream;
      if (stream.text) { try { return await stream.text(); } catch {} }
      const reader = stream.getReader ? stream.getReader() : null;
      if (!reader) return '';
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
      } finally { try { reader.releaseLock(); } catch {} }
      try {
        const total = chunks.reduce((n, c) => n + (c.byteLength || c.length || 0), 0);
        const buf = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          const u8 = c instanceof Uint8Array ? c : new TextEncoder().encode(String(c));
          buf.set(u8, off); off += u8.length;
        }
        return new TextDecoder().decode(buf).trim();
      } catch { return ''; }
    })();
  }

  async function shell(cmd) {
    if (!S.adb) throw new Error('Built-in ADB not connected');
    const adb = S.adb;
    // API differs slightly across Tango versions — try in order.
    try {
      if (adb.subprocess && typeof adb.subprocess.shell === 'function') {
        const p = await adb.subprocess.shell(String(cmd));
        // process.stdout is a stream; process.exit resolves on completion.
        const [out] = await Promise.all([
          readAll(p.stdout || p.output).catch(() => ''),
          (async () => { try { await p.exit; } catch {} })(),
        ]);
        return String(out || '').trim();
      }
    } catch (e) {
      // fall through to legacy attempts
      if (/not connected|closed/i.test(String((e && e.message) || e))) throw e;
    }
    try {
      if (typeof adb.shell === 'function') {
        const r = await adb.shell(String(cmd));
        if (typeof r === 'string') return r.trim();
        return (await readAll(r).catch(() => '')).trim();
      }
    } catch (e) {
      if (/not connected|closed/i.test(String((e && e.message) || e))) throw e;
    }
    // Raw socket fallback: shell:<cmd>
    const sock = await adb.createSocket(`shell:${cmd}`);
    const out = await readAll(sock).catch(() => '');
    try { await sock.close(); } catch {}
    return String(out || '').trim();
  }

  function adbText(s) {
    return String(s || '').split('').map((ch) => {
      if (ch === ' ') return '%s';
      if (/[a-zA-Z0-9]/.test(ch)) return ch;
      return '\\' + ch;
    }).join('');
  }

  async function sendKeyevent(code) {
    return shell(`input keyevent ${parseInt(code, 10) || code}`);
  }

  async function sendText(str) {
    const out = [];
    for (const ch of String(str || '')) {
      // one shell per char keeps TV keyboards in sync (same as cloud relay).
      // eslint-disable-next-line no-await-in-loop
      await shell(`input text ${adbText(ch)}`);
      out.push(ch);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 40));
    }
    return out.join('');
  }

  function onChange(cb) {
    if (typeof cb === 'function') S.listeners.add(cb);
    return () => S.listeners.delete(cb);
  }

  window.SiteAdb = {
    KEYEVENT: KEYEVENT_DEFAULT,
    supported,
    ensureLib,
    scanUsb,
    pickUsb,
    connectUsb,
    disconnect,
    isConnected,
    current,
    shell,
    sendKeyevent,
    sendText,
    onChange,
    snapshot,
  };
})();
