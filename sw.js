/* 亞特的冒險 — v1.0.11；每次發布請同步更新 VERSION。 */
const VERSION = '1.0.11';
const CACHE_NAME = 'ater-adventure-' + VERSION;
const FILES = [
  "./index.html",
  "./style.css?v=1.0.11",
  "./game.js?v=1.0.11",
  "./title-intro.js?v=1.0.11",
  "./pwa-update.js?v=1.0.11",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon.ico",
  "./favicon-16.png",
  "./favicon-32.png",
  "./favicon-48.png"
];

self.addEventListener('install', event => {
  // 全部必要檔案快取完成，才能讓新版本進入 waiting。
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(FILES)));
  // 不在此呼叫 skipWaiting：讓玩家自行選擇何時更新。
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('ater-adventure-') && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 不干擾 PeerJS、連線及其他外站資源。
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match('./index.html') || await fetch(req);
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    return fetch(req);
  })());
});
