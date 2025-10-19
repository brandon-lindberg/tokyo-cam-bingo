const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const STATIC_CACHE = `tokyo-cam-bingo-static-${VERSION}`;
const RUNTIME_CACHE = `tokyo-cam-bingo-runtime-${VERSION}`;
const CACHE_NAMESPACE = 'tokyo-cam-bingo-';

const STATIC_ASSETS = [
  `/css/styles.css?v=${VERSION}`,
  `/js/pwa-install.js?v=${VERSION}`,
  `/js/game.js?v=${VERSION}`,
  '/images/tcb_stamp.png',
  '/images/hanko.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/apple-touch-icon.png',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/offline.html'
];

const CACHEABLE_DESTINATIONS = ['style', 'script', 'image', 'font'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames.map((cacheName) => {
        if (!cacheName.startsWith(CACHE_NAMESPACE)) {
          return null;
        }
        if (cacheName !== STATIC_CACHE && cacheName !== RUNTIME_CACHE) {
          return caches.delete(cacheName);
        }
        return null;
      })
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.url.includes('socket.io') || request.url.includes('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
          return caches.match('/offline.html');
        })
    );
    return;
  }

  if (CACHEABLE_DESTINATIONS.includes(request.destination)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) {
            return cached;
          }

          return fetch(request).then((response) => {
            if (response && response.status === 200) {
              cache.put(request, response.clone());
            }
            return response;
          });
        })
      )
    );
    return;
  }

  event.respondWith(
    caches.open(RUNTIME_CACHE).then((cache) =>
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cache.match(request))
    )
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
