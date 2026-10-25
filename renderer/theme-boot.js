/* Applies the saved theme before first paint.

   The renderer boots asynchronously (it waits for the board over IPC), so
   setting the theme there would flash the dark default on a light board.
   This runs as a parser-blocking script in <head> instead — the CSP forbids
   inline scripts, hence a file of its own.

   Three states (v0.9): 'dark', 'light', and 'auto' — auto follows the OS
   (prefers-color-scheme) and is the value a fresh install starts from when
   the user picks it. Only 'dark'/'light'/'auto' ever reach storage; the
   matchMedia listener that keeps 'auto' live lives in app.js.

   The web edition keeps NOTHING across reloads — boards, camera, and the
   theme too. web-bridge.js (loaded just before this file) installs
   window.cardwall with platform 'web' in the browser; under Electron the
   preload did it with the OS platform. Only the desktop reads the stored
   theme, so a browser visitor always starts on the dark default. */
(function () {
  function resolve(name) {
    if (name === 'auto') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    }
    return name === 'light' ? 'light' : 'dark';
  }
  function apply(name) {
    if (resolve(name) === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
  }
  try {
    if (window.cardwall && window.cardwall.platform === 'web') {
      apply('dark'); // the browser starts on the dark default, always
      return;
    }
    var stored = localStorage.getItem('cardwall.theme');
    if (stored !== 'dark' && stored !== 'light' && stored !== 'auto') stored = 'dark';
    apply(stored);
  } catch (err) {
    /* storage unavailable: fall back to the dark default */
  }
})();
