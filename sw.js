// Service worker — Loane Pro
// Stratégie "réseau d'abord" : l'app se met à jour dès qu'il y a du réseau,
// et reste utilisable hors ligne grâce au cache.
const CACHE = 'loane-pro-3.10.2';
const ASSETS = [
  './', './index.html', './css/app.css',
  './js/config.js', './js/db.js', './js/app.js',
  './manifest.webmanifest',
  './icons/bird.png', './icons/glitter-dark.png',
  './icons/icon-180-v5.png', './icons/icon-192-v5.png', './icons/icon-512-v5.png', './icons/logo-v5.jpg'
];

self.addEventListener('install', e => {
  // addAll échoue en bloc si un seul fichier manque : on précharge fichier par fichier
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(ASSETS.map(a => c.add(a).catch(err => console.warn('précache', a, err))))
  ));
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
        // On ne met en cache QUE les réponses valides : une erreur 404/500 servie
        // pendant un déploiement restait sinon en cache et cassait l'app hors ligne.
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => { });
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => {
        if (hit) return hit;
        // Repli sur la page d'accueil uniquement pour une navigation : renvoyer du HTML
        // à la place d'un .css ou d'une image ne faisait qu'ajouter des erreurs.
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }))
  );
});
