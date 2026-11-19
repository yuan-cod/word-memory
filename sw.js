// 考研单词记忆 - Service Worker
// 网络优先：改了样式/逻辑推上去就能立刻看到；断网时回落到缓存，PWA 仍可离线用。
const CACHE = 'wordmemory-v9';
const FILES = ['./index.html', './styles.css', './app.js', './data.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(FILES.map(f => cache.add(f).catch(err => {
        console.warn('SW: cache add failed for', f, err);
      })))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const request = e.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      try {
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })
  );
});
