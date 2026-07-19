// Service worker — Loane Pro
// Stratégie "réseau d'abord" : l'app se met à jour dès qu'il y a du réseau,
// et reste utilisable hors ligne grâce au cache.
const CACHE = 'loane-pro-3.4.0';
const ASSETS = [
  './', './index.html', './css/app.css',
  './js/config.js', './js/db.js', './js/app.js',
  './manifest.webmanifest',
  './icons/bird.png', './icons/glitter-dark.png',
  './icons/icon-180-v5.png', './icons/icon-192-v5.png', './icons/icon-512-v5.png', './icons/logo-v5.jpg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;          // Google / Worker : jamais en cache

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
