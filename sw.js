/* Online Remote — service worker: cache the site shell automatically so
   repeat visits (and rescans) are instant. API calls always hit network. */
const CACHE = "online-remote-v1";
const SHELL = ["./", "./index.html", "./style.css", "./remote.js", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method !== "GET") return;
  const url = new URL(req.url);
  // Never cache the TV relay API — commands must always go live.
  if(url.pathname.startsWith("/api/")) return;
  e.respondWith(
    caches.match(req, {ignoreSearch: false}).then(hit => {
      const go = fetch(req).then(res => {
        if(res && res.ok){
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      // App shell: serve cache instantly, refresh in background.
      // CDN libs (hand tracking, fonts): network first, cache fallback.
      const cdn = /cdn\.jsdelivr\.net|fonts\.g(oogleapis|static)\.com/.test(url.hostname);
      return (hit && !cdn) ? hit : go.then(r => r || hit);
    })
  );
});
