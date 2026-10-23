/**
 * cardwall web bridge: the browser twin of preload.js.
 *
 * The renderer talks to storage through ONE interface — window.cardwall —
 * so the same app.js runs on the desktop (Electron preload) and on the web
 * (this shim). Under Electron the preload already installed the bridge, and
 * this file installs nothing: desktop behaviour is byte-for-byte unchanged.
 *
 * THE WEB EDITION REMEMBERS NOTHING. Boards live in a plain in-memory map:
 * a reload (or closing the tab) forgets every board, every card and every
 * camera position. The web build is a sandbox — "does it feel right?" —
 * while the downloaded desktop app is the one that persists. This is a
 * deliberate product split, not a limitation: there is no localStorage,
 * no IndexedDB, no cookie anywhere in this file, so a visitor's data never
 * leaves the tab it was created in.
 *
 * The API mirrors main.js exactly, including its sanitisation and the
 * "save keeps the name already on disk" rule, so a board saved in the
 * browser and the same board saved on the desktop deserialise identically
 * (within a session; nothing survives a reload).
 *
 * Note what is deliberately ABSENT: loadSession/saveSession. The desktop
 * bridge has them (it persists the last-edited board + camera); the web
 * bridge does not, and app.js feature-detects their absence to skip the
 * restore path entirely.
 *
 * UMD-ish: the browser auto-installs on load; node tests require() the
 * factory and call install() against a stub window.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root) { root.CardwallWebBridge = api; }
  // Auto-install only in a real browser WITHOUT the Electron preload.
  if (typeof window !== 'undefined' && !window.cardwall) {
    api.install(window);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_CARDS = 5000;
  var MAX_TITLE = 500;
  var MAX_NOTE = 20000;
  var MAX_NAME = 80;
  var DEFAULT_NAME = '我的第一幅图';

  function cleanName(name) {
    var s = String(name == null ? '' : name)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME);
    return s || DEFAULT_NAME;
  }

  function safeId(id) {
    return String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  }

  function newBoardId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // Mirrors main.js sanitizeBoard: untrusted JSON must never crash the app.
  // `tidy` rides along when present (a board saved while free reopens free).
  function sanitizeBoard(data) {
    var raw = data && Array.isArray(data.cards) ? data.cards.slice(0, MAX_CARDS) : [];
    var ids = {};
    var cards = [];
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (!c || typeof c.id !== 'string' || !c.id || ids[c.id]) continue;
      ids[c.id] = true;
      cards.push({
        id: c.id,
        title: String(c.title == null ? '' : c.title).slice(0, MAX_TITLE),
        note: String(c.note == null ? '' : c.note).slice(0, MAX_NOTE),
        x: Number.isFinite(c.x) ? c.x : 0,
        y: Number.isFinite(c.y) ? c.y : 0,
        parent: null
      });
    }
    // Second pass: parents may be declared after their children.
    var byId = {};
    cards.forEach(function (c) { byId[c.id] = c; });
    raw.forEach(function (c) {
      if (!c || !byId[c.id]) return;
      var parent = typeof c.parent === 'string' ? c.parent : null;
      if (parent && parent !== c.id && byId[parent]) byId[c.id].parent = parent;
    });
    var out = { version: 1, cards: cards };
    if (data && typeof data.tidy === 'boolean') out.tidy = data.tidy;
    return out;
  }

  // Install the bridge on `win` (defaults to the global window). The store is
  // a fresh in-memory map per install: reloading the page (which re-installs)
  // starts from an empty library. No storage backend is touched — ever.
  function install(win) {
    if (!win) return false;

    var boards = {};   // id -> { version, name, savedAt, cards, tidy? }
    var order = [];    // ids in creation order (recency derived from savedAt)

    function readBoard(id) {
      var b = boards[safeId(id)];
      return b && Array.isArray(b.cards) ? b : null;
    }

    win.cardwall = {
      platform: 'web',

      listBoards: function () {
        return Promise.resolve(order.map(function (id) {
          var b = boards[id];
          return {
            id: id,
            name: cleanName(b.name),
            cards: Array.isArray(b.cards) ? b.cards.length : 0,
            savedAt: b.savedAt || null
          };
        }).filter(function (b) { return !!b.id; })
          // Most recently touched first (matches main.js).
          .sort(function (a, b) {
            return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
          }));
      },

      createBoard: function (name) {
        var id = newBoardId();
        var clean = cleanName(name);
        var savedAt = new Date().toISOString();
        boards[id] = { version: 1, name: clean, savedAt: savedAt, cards: [] };
        order.push(id);
        return Promise.resolve({ id: id, name: clean, cards: 0 });
      },

      openBoard: function (id) {
        var board = readBoard(id);
        if (!board) return Promise.resolve(null);
        var clean = sanitizeBoard(board);
        return Promise.resolve({
          id: safeId(id),
          name: cleanName(board.name),
          cards: clean.cards,
          tidy: clean.tidy
        });
      },

      saveBoard: function (id, data) {
        var safe = safeId(id);
        if (!safe) return Promise.resolve({ ok: false, error: 'invalid id' });
        var clean = sanitizeBoard(data);
        // Keep the name already in memory: renaming has its own call, and a
        // stale renderer must not be able to wipe it (same rule as main.js).
        var previous = boards[safe];
        var name = cleanName(previous ? previous.name : (data && data.name));
        var savedAt = new Date().toISOString();
        var next = { version: 1, name: name, savedAt: savedAt, cards: clean.cards };
        if (clean.tidy !== undefined) next.tidy = clean.tidy;
        boards[safe] = next;
        if (order.indexOf(safe) < 0) order.push(safe);
        return Promise.resolve({ ok: true, cards: clean.cards.length, name: name });
      },

      renameBoard: function (id, name) {
        var safe = safeId(id);
        if (!safe) return Promise.resolve({ ok: false, error: 'invalid id' });
        var board = boards[safe];
        if (!board) return Promise.resolve({ ok: false, error: 'not found' });
        var next = cleanName(name);
        board.name = next;
        board.savedAt = new Date().toISOString();
        return Promise.resolve({ ok: true, name: next });
      },

      // The desktop build moves the file to the OS trash; the web build has
      // no trash and no disk, so this drops the in-memory board (app.js
      // words the confirm dialog accordingly via platform === 'web').
      deleteBoard: function (id) {
        var safe = safeId(id);
        if (!safe) return Promise.resolve({ ok: false, error: 'invalid id' });
        var existed = !!boards[safe];
        delete boards[safe];
        order = order.filter(function (b) { return b !== safe; });
        if (!existed) return Promise.resolve({ ok: false, error: 'not found' });
        return Promise.resolve({ ok: true });
      }

      // No loadSession/saveSession here on purpose: the web edition keeps
      // nothing across reloads, so there is no session to restore.
    };
    return true;
  }

  return {
    install: install,
    sanitizeBoard: sanitizeBoard,
    cleanName: cleanName,
    safeId: safeId,
    newBoardId: newBoardId
  };
});
