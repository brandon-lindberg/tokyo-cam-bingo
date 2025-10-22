const CACHE_PREFIX = 'tokyo-cam-bingo-';

async function purgeLegacyCaches() {
  const keys = await caches.keys();
  const deletions = keys
    .filter((key) => key.startsWith(CACHE_PREFIX))
    .map((key) => caches.delete(key));
  await Promise.all(deletions);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    purgeLegacyCaches().finally(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    purgeLegacyCaches().finally(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
