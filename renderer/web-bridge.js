/**
 * cardwall web bridge: the browser twin of preload.js.
 *
 * The renderer talks to storage through ONE interface — window.cardwall —
 * so the same app.js runs on the desktop (Electron preload) and on the web
 * (this shim). Under Electron the preload already installed the bridge, and
 * this file installs nothing: desktop behaviour is byte-for-byte unchanged.
 *
 * Storage layout (localStorage, one key per board so a corrupt board can
 * never take the library down):
 *   cardwall.web.boards      -> JSON [{ id, name, savedAt }]
 *   cardwall.web.board.<id>  -> JSON { version, name, savedAt, cards }
 *
 * The API mirrors main.js exactly, including its sanitisation and the
 * "save keeps the name already on disk" rule, so a board saved in the
 * browser and the same board saved on the desktop deserialise identically.
 *
 * UMD-ish: the browser auto-installs on load; node tests require() the
 * factory and call install() against a stub window + storage.
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
  var INDEX_KEY = 'cardwall.web.boards';
  var BOARD_PREFIX = 'cardwall.web.board.';

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
    return { version: 1, cards: cards };
  }

  // Install the bridge on `win` (defaults to the global window). `storage`
  // defaults to win.localStorage; pass a stub in tests.
  function install(win, storage) {
    if (!win) return false;
    var store = storage || win.localStorage;
    if (!store) return false; // private mode / storage disabled: stay bridge-less

    function readJSON(key) {
      try { return JSON.parse(store.getItem(key)); } catch (err) { return null; }
    }
    function writeJSON(key, value) {
      store.setItem(key, JSON.stringify(value));
    }
    function readIndex() {
      var idx = readJSON(INDEX_KEY);
      return Array.isArray(idx) ? idx : [];
    }
    function writeIndex(idx) {
      writeJSON(INDEX_KEY, idx);
    }
    function readBoardFile(id) {
      var data = readJSON(BOARD_PREFIX + safeId(id));
      if (!data || !Array.isArray(data.cards)) return null;
      return data;
    }

    win.cardwall = {
      platform: 'web',

      listBoards: function () {
        return Promise.resolve(readIndex().map(function (b) {
          var board = readBoardFile(b.id);
          return {
            id: b.id,
            name: cleanName(b.name),
            cards: board && Array.isArray(board.cards) ? board.cards.length : 0,
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
        writeJSON(BOARD_PREFIX + id, { version: 1, name: clean, savedAt: savedAt, cards: [] });
        var idx = readIndex();
        idx.push({ id: id, name: clean, savedAt: savedAt });
        writeIndex(idx);
        return Promise.resolve({ id: id, name: clean, cards: 0 });
      },

      openBoard: function (id) {
        var board = readBoardFile(id);
        if (!board) return Promise.resolve(null);
        return Promise.resolve({
          id: safeId(id),
          name: cleanName(board.name),
          cards: sanitizeBoard(board).cards
        });
      },

      saveBoard: function (id, data) {
        var safe = safeId(id);
        if (!safe) return Promise.resolve({ ok: false, error: 'invalid id' });
        var clean = sanitizeBoard(data);
        // Keep the name already on disk: renaming has its own call, and a
        // stale renderer must not be able to wipe it (same rule as main.js).
        var previous = readBoardFile(safe);
        var name = cleanName(previous ? previous.name : (data && data.name));
        var savedAt = new Date().toISOString();
        writeJSON(BOARD_PREFIX + safe, {
          version: 1, name: name, savedAt: savedAt, cards: clean.cards
        });
        var idx = readIndex();
        var found = false;
        for (var i = 0; i < idx.length; i++) {
          if (idx[i].id === safe) {
            idx[i].name = name; idx[i].savedAt = savedAt; found = true; break;
          }
        }
        if (!found) idx.push({ id: safe, name: name, savedAt: savedAt });
        writeIndex(idx);
        return Promise.resolve({ ok: true, cards: clean.cards.length, name: name });
      },

      renameBoard: function (id, name) {
        var safe = safeId(id);
        if (!safe) return Promise.resolve({ ok: false, error: 'invalid id' });
        var board = readBoardFile(safe);
        if (!board) return Promise.resolve({ ok: false, error: 'not found' });
        var next = cleanName(name);
        var savedAt = new Date().toISOString();
        board.name = next;
        board.savedAt = savedAt;
        writeJSON(BOARD_PREFIX + safe, board);
        var idx = readIndex();
        for (var i = 0; i < idx.length; i++) {
          if (idx[i].id === safe) { idx[i].name = next; idx[i].savedAt = savedAt; break; }
        }
        writeIndex(idx);
        return Promise.resolve({ ok: true, name: next });
      },

      // The desktop build moves the file to the OS trash; the web build has
      // no trash, so this is a hard delete (app.js words the confirm dialog
      // accordingly via platform === 'web').
      deleteBoard: function (id) {
        var safe = safeId(id);
        if (!safe) return Promise.resolve({ ok: false, error: 'invalid id' });
        var existed = !!readBoardFile(safe);
        try { store.removeItem(BOARD_PREFIX + safe); } catch (err) { /* ignore */ }
        var idx = readIndex().filter(function (b) { return b.id !== safe; });
        writeIndex(idx);
        if (!existed) return Promise.resolve({ ok: false, error: 'not found' });
        return Promise.resolve({ ok: true });
      }
    };
    return true;
  }

  return {
    install: install,
    sanitizeBoard: sanitizeBoard,
    cleanName: cleanName,
    safeId: safeId,
    newBoardId: newBoardId,
    INDEX_KEY: INDEX_KEY,
    BOARD_PREFIX: BOARD_PREFIX
  };
});
