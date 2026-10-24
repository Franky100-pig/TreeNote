/*
 * cardwall service worker (web edition only).
 *
 * Scope: the app shell (HTML/CSS/JS/icons). Board DATA is never cached — the
 * web edition is deliberately memory-less, so there is nothing to persist and
 * no stale-data hazard here.
 *
 * Maintenance contract (do not forget): whenever a file in ASSETS changes,
 * bump CACHE. The activate handler deletes every other cache key, so a bump
 * is what makes an update reach already-installed phones.
 *
 * Strategy (per the stale-service-worker playbook):
 *   - navigations  → network-first, cache fallback (a fresh index.html must
 *                    never pair with a cached old app.js)
 *   - static files → stale-while-revalidate (instant launch, silent upgrade)
 *   - install      → per-file fetch with cache:'reload' (NOT addAll: addAll is
 *                    atomic — one 404 voids the install — and can seed the new
 *                    cache from the HTTP cache, GitHub Pages max-age=600 makes
 *                    that a real risk)
 *   - activate     → drop old cache keys, claim clients immediately
 */
var CACHE = 'cardwall-v1';

var ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './styles.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  './renderer/web-bridge.js',
  './renderer/theme-boot.js',
  './renderer/physics.js',
  './renderer/sample.js',
  './renderer/interaction.js',
  './renderer/debug.js',
  './renderer/app.js',
  './renderer/pwa-register.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(ASSETS.map(function (url) {
        return fetch(new Request(url, { cache: 'reload' }))
          .then(function (res) {
            if (res && res.ok) return cache.put(url, res);
          })
          .catch(function () { /* offline mid-install: skip, SW still activates */ });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE) return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  if (req.mode === 'navigate') {
    // Network-first so the shell is never a Frankenstein of new HTML + old JS.
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (cached) {
          return cached || caches.match('./');
        });
      })
    );
    return;
  }

  // Static assets: serve instantly from cache, refresh in the background.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var fresh = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || fresh;
    })
  );
});
