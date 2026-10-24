/*
 * Registers the service worker — web edition only.
 *
 * External file (not inline) because the CSP is script-src 'self'.
 * Under Electron there is no service worker in the renderer at all, and the
 * desktop app must never try to register one; the platform guard makes this a
 * no-op there. The bridge always defines window.cardwall before this runs
 * (web-bridge.js sits earlier in <head> than the body scripts).
 */
(function () {
  var bridge = window.cardwall;
  if (bridge && bridge.platform && bridge.platform !== 'web') return; // Electron
  if (!('serviceWorker' in navigator)) return; // ancient browser: no PWA, no harm

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' })
      .then(function (reg) {
        // Don't wait for the next navigation to notice a new worker.
        if (reg.update) reg.update();
      })
      .catch(function (err) {
        // A failed SW is cosmetic: the app works fine online without it.
        console.warn('[cardwall] service worker registration failed:', err && err.message);
      });
  });
})();
