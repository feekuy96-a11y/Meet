// Bump this version whenever a static asset changes. Activation waits for old
// tabs to close, avoiding an update halfway through a recording.
const CACHE = 'meetnote-th-v3.2.1';
const FILES = [
  './',
  'index.html',
  'css/style.css',
  'css/accessibility.css',
  'js/app.js',
  'js/model.js',
  'js/cloud.js',
  'js/db.js',
  'js/audio.js',
  'js/api.js',
  'js/ui.js',
  'js/config.js',
  'js/supabase.js',
  'js/blocks.js',
  'js/blockworker.js',
  'js/format.js',
  'js/settings.js',
  'js/diagnostics.js',
  'js/autologin.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];
const URLS = FILES.map((path) => new URL(path, self.registration.scope).href);
self.addEventListener('install', (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(URLS)))
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => (key.startsWith('meetnote-th-') || key === 'mn-v5') && key !== CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  )
);
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !URLS.includes(url.href)) return;
  event.respondWith(
    caches
      .open(CACHE)
      .then(async (cache) => (await cache.match(event.request)) || fetch(event.request))
  );
});
