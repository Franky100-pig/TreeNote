/* Applies the saved theme before first paint.

   The renderer boots asynchronously (it waits for the board over IPC), so
   setting the theme there would flash the dark default on a light board.
   This runs as a parser-blocking script in <head> instead — the CSP forbids
   inline scripts, hence a file of its own. */
(function () {
  try {
    if (localStorage.getItem('cardwall.theme') === 'light') {
      document.documentElement.dataset.theme = 'light';
    }
  } catch (err) {
    /* storage unavailable: fall back to the dark default */
  }
})();
