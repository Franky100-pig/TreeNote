/* Applies the saved theme before first paint.

   The renderer boots asynchronously (it waits for the board over IPC), so
   setting the theme there would flash the dark default on a light board.
   This runs as a parser-blocking script in <head> instead — the CSP forbids
   inline scripts, hence a file of its own.

   The web edition keeps NOTHING across reloads — boards, camera, and the
   theme too. web-bridge.js (loaded just before this file) installs
   window.cardwall with platform 'web' in the browser; under Electron the
   preload did it with the OS platform. Only the desktop reads the stored
   theme, so a browser visitor always starts on the dark default. */
(function () {
  try {
    if (window.cardwall && window.cardwall.platform === 'web') return;
    if (localStorage.getItem('cardwall.theme') === 'light') {
      document.documentElement.dataset.theme = 'light';
    }
  } catch (err) {
    /* storage unavailable: fall back to the dark default */
  }
})();
