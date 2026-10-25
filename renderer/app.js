/**
 * cardwall renderer bootstrap.
 *
 * DOM cards + SVG edges + fixed-step rAF loop driven by physics.js.
 * Architecture mirrors the Obsidian Canvas RE findings: a CSS-transformed
 * world container holding DOM cards and an SVG edge layer underneath.
 * This file owns the world container, the per-frame DOM sync, edge geometry,
 * and the camera (fit / settle-fit / tween); pointer/wheel input lives in
 * interaction.js.
 */
(function () {
  'use strict';

  var CardPhysics = window.CardPhysics;
  var viewport = document.getElementById('viewport');
  var worldEl = document.getElementById('world');
  var edgesEl = document.getElementById('edges');

  // Home (the board library) and the one shared dialog.
  var homeEl = document.getElementById('home');
  var boardListEl = document.getElementById('board-list');
  var homeEmptyEl = document.getElementById('home-empty');
  var homeBtn = document.getElementById('home-btn');
  var newBoardBtn = document.getElementById('new-board');
  var boardNameEl = document.getElementById('board-name');
  var dialogEl = document.getElementById('dialog');
  var dialogForm = document.getElementById('dialog-form');
  var dialogInput = document.getElementById('dialog-input');
  var dialogLabel = document.getElementById('dialog-label');
  var dialogCancel = document.getElementById('dialog-cancel');

  // ---- world setup -------------------------------------------------------
  // Preset card colours — a whitelist, so a hand-edited board file can never
  // inject an arbitrary value into the DOM (main.js sanitises to the same
  // list). `null` means "no colour": the default panel.
  var CARD_COLORS = ['amber', 'rose', 'sky', 'mint', 'violet', 'lime'];
  var CARD_COLOR_LABELS = {
    amber: '琥珀', rose: '玫红', sky: '天蓝',
    mint: '薄荷', violet: '紫罗兰', lime: '青柠'
  };

  // Theme modes (v0.9): dark -> light -> auto -> dark. 'auto' follows the OS
  // (prefers-color-scheme) live. The helpers that read these live in the
  // theme section further down; this early definition is what makes them
  // callable from the toolbar wiring below (function declarations hoist, but
  // a `var` read before its assignment line is still undefined).
  var THEME_KEY = 'cardwall.theme';
  var THEME_MODES = ['dark', 'light', 'auto'];

  var world = CardPhysics.createWorld({ seed: 7 });
  var cardEls = new Map(); // id -> HTMLElement
  var edgeEls = new Map(); // childId -> SVGPathElement
  var currentBoard = { id: null, name: '' };

  function seedCards(list) {
    list.forEach(function (item) {
      CardPhysics.addCard(world, {
        id: item.id,
        x: item.x,
        y: item.y,
        parent: item.parent || null,
        title: item.title,
        note: item.note || '',
        color: item.color || null
      });
    });
  }

  // ---- DOM construction ----------------------------------------------------
  var zCounter = 100;

  function buildCardEl(card) {
    var el = document.createElement('div');
    el.className = 'card' + (card.parent ? '' : ' card-root');
    el.dataset.id = card.id;
    // Preset colour (null = default panel). The pigments live in CSS so both
    // themes stay in control of contrast; the data attribute is the hook.
    if (card.color) el.dataset.color = card.color;
    var title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = card.title;
    title.dataset.placeholder = '标题';
    var note = document.createElement('div');
    note.className = 'card-note';
    note.textContent = card.note;
    note.dataset.placeholder = '补充说明（可留空）';
    el.appendChild(title);
    el.appendChild(note);

    // Hover action bar: edit / add child / delete, plus the colour swatches
    // (the palette opens as a small popover). Appears on hover (CSS) and is
    // the main way to act on a card without dragging it. The buttons are
    // handled by a delegated click listener on the viewport; this is just the
    // markup. `tabindex=-1` keeps them out of the tab order so the card body
    // stays the keyboard target while editing.
    var toolbar = document.createElement('div');
    toolbar.className = 'card-toolbar';
    toolbar.innerHTML =
      '<button data-act="edit" title="编辑 (或双击卡片)" tabindex="-1" aria-label="编辑">✎</button>' +
      '<button data-act="add" title="新建子节点" tabindex="-1" aria-label="新建子节点">＋</button>' +
      '<span class="card-color-wrap">' +
        '<button data-act="color" class="card-color-btn" title="卡片颜色" tabindex="-1" aria-label="卡片颜色"></button>' +
        '<span class="card-palette" hidden>' +
          CARD_COLORS.map(function (name) {
            return '<button data-act="color" data-color="' + name + '" ' +
              'class="card-swatch" data-swatch="' + name + '" ' +
              'title="' + CARD_COLOR_LABELS[name] + '" tabindex="-1" ' +
              'aria-label="' + CARD_COLOR_LABELS[name] + '"></button>';
          }).join('') +
          '<button data-act="color" data-color="" class="card-swatch card-swatch-none" ' +
            'title="默认色" tabindex="-1" aria-label="默认色"></button>' +
        '</span>' +
      '</span>' +
      '<button data-act="del" title="删除节点" tabindex="-1" aria-label="删除节点">✕</button>';
    el.appendChild(toolbar);

    // Freeze the card while the pointer is over it so the bar never slides
    // out from under the cursor. The flag is read by the physics integrator;
    // it is not persisted and is not a pin.
    el.addEventListener('mouseenter', function () {
      card.hover = true;
      card.vx = 0;
      card.vy = 0;
    });
    el.addEventListener('mouseleave', function () {
      card.hover = false;
    });

    cardEls.set(card.id, el);
    return el;
  }

  function addEdgePath(card) {
    if (!card.parent || edgeEls.has(card.id)) return;
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'edge');
    edgesEl.appendChild(path);
    edgeEls.set(card.id, path);
  }

  function removeEdgePath(id) {
    var path = edgeEls.get(id);
    if (path) { path.remove(); edgeEls.delete(id); }
  }

  function raise(el) {
    if (el) el.style.zIndex = ++zCounter;
  }

  function measure(card) {
    var el = cardEls.get(card.id);
    if (!el) return;
    card.domW = el.offsetWidth;
    card.domH = el.offsetHeight;
  }

  function buildDOM() {
    var frag = document.createDocumentFragment();
    world.cards.forEach(function (card) {
      frag.appendChild(buildCardEl(card));
    });
    // One SVG path per tree edge; the SVG layer precedes the cards in DOM
    // order, so card bodies paint over the line ends.
    world.cards.forEach(addEdgePath);
    worldEl.appendChild(frag);
  }

  // ---- edge geometry -------------------------------------------------------
  // Cubic bezier with control points at clamp(d/2, 70, 150) along the edge
  // direction — the Obsidian Canvas routing curve (see RE report). Endpoints
  // sit just outside the card borders via ray/rect intersection, so edges
  // visually connect borders, not centers.
  function borderPoint(card, tx, ty) {
    var dx = tx - card.x, dy = ty - card.y;
    if (dx === 0 && dy === 0) return { x: card.x, y: card.y };
    var halfW = (card.domW || card.w) / 2 + 6;
    var halfH = (card.domH || card.h) / 2 + 6;
    var sx = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
    var sy = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
    var s = Math.min(sx, sy);
    return { x: card.x + dx * s, y: card.y + dy * s };
  }

  function updateEdges() {
    edgeEls.forEach(function (path, childId) {
      var child = CardPhysics.findCard(world, childId);
      var parent = CardPhysics.findCard(world, child.parent);
      if (!child || !parent) return;
      var p1 = borderPoint(parent, child.x, child.y);
      var p2 = borderPoint(child, parent.x, parent.y);
      var dx = p2.x - p1.x, dy = p2.y - p1.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / d, uy = dy / d;
      var off = Math.min(Math.max(d / 2, 70), 150);
      path.setAttribute('d',
        'M ' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1) +
        ' C ' + (p1.x + ux * off).toFixed(1) + ' ' + (p1.y + uy * off).toFixed(1) +
        ' ' + (p2.x - ux * off).toFixed(1) + ' ' + (p2.y - uy * off).toFixed(1) +
        ' ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1));
    });
  }

  // ---- per-frame DOM sync ---------------------------------------------------
  function syncDOM() {
    world.cards.forEach(function (card) {
      var el = cardEls.get(card.id);
      if (el) {
        el.style.transform =
          'translate(-50%, -50%) translate(' + card.x.toFixed(2) + 'px, ' + card.y.toFixed(2) + 'px)';
      }
    });
    updateEdges();
  }

  // ---- persistence (C6) -------------------------------------------------------
  // Every structural or content change marks the board dirty; the tick loop
  // flushes after a short debounce. The main process owns the file and does
  // the atomic write — the renderer never touches the filesystem.
  var SAVE_DEBOUNCE_MS = 600;
  var saveState = { dirty: false, lastChange: 0, inFlight: false, pending: null };

  function hasBridge() {
    return !!(window.cardwall && typeof window.cardwall.saveBoard === 'function');
  }
  function markDirty() {
    saveState.dirty = true;
    saveState.lastChange = performance.now();
  }

  function serialize() {
    return {
      version: 1,
      tidy: !!world.tidy,
      cards: world.cards.map(function (c) {
        return {
          id: c.id,
          title: c.title,
          note: c.note,
          x: c.x,
          y: c.y,
          parent: c.parent || null,
          color: c.color || null
        };
      })
    };
  }

  function flushSave(force) {
    if (!hasBridge() || !currentBoard.id || saveState.inFlight || !saveState.dirty) {
      return Promise.resolve(null);
    }
    if (!force && performance.now() - saveState.lastChange < SAVE_DEBOUNCE_MS) {
      return Promise.resolve(null);
    }
    saveState.dirty = false;
    saveState.inFlight = true;
    saveState.pending = window.cardwall.saveBoard(currentBoard.id, serialize()).then(function (r) {
      saveState.inFlight = false;
      return r;
    }, function (err) {
      saveState.inFlight = false;
      saveState.dirty = true; // retry on the next flush
      return { ok: false, error: String(err) };
    });
    return saveState.pending;
  }

  // ---- session (desktop only: last edited board + camera) -------------------
  // The downloaded app remembers where you left off — which board was open and
  // the pan/zoom it was viewed at — so relaunching drops you straight back in
  // instead of the library. The web bridge exposes no session API at all (the
  // browser keeps nothing), so every helper here feature-detects and no-ops.
  var sessionState = { dirty: false, lastChange: 0 };

  function hasSession() {
    return !!(window.cardwall && typeof window.cardwall.saveSession === 'function');
  }

  function markSessionDirty() {
    if (!hasSession()) return;
    sessionState.dirty = true;
    sessionState.lastChange = performance.now();
  }

  function flushSession(force) {
    if (!hasSession() || !currentBoard.id || !sessionState.dirty) {
      return Promise.resolve(null);
    }
    if (!force && performance.now() - sessionState.lastChange < SAVE_DEBOUNCE_MS) {
      return Promise.resolve(null);
    }
    sessionState.dirty = false;
    return window.cardwall.saveSession({
      lastBoardId: currentBoard.id,
      view: { x: view.x, y: view.y, scale: view.scale }
    }).then(function (r) {
      return r;
    }, function (err) {
      sessionState.dirty = true; // retry on the next flush
      return { ok: false, error: String(err) };
    });
  }

  // Best-effort final flush: an in-flight IPC may not complete during
  // teardown, but the 600ms debounce has normally persisted long before.
  window.addEventListener('pagehide', function () {
    markSessionDirty();
    flushSession(true);
  });

  // ---- view transform --------------------------------------------------------
  // Pan/zoom plumbing; input handlers live in interaction.js. Zoom anchor math
  // (verified by fixed-point check): pan' = pan*r + anchor*(1 - r),
  // r = newScale/oldScale, anchor in viewport pixels.
  var view = { x: 0, y: 0, scale: 1 };
  var tween = null;       // { x, y, scale } camera target, or null
  var userInteracted = false;
  var settleFitDone = false;

  function applyView() {
    worldEl.style.transform =
      'translate(' + view.x.toFixed(2) + 'px, ' + view.y.toFixed(2) + 'px) scale(' + view.scale.toFixed(4) + ')';
  }

  // Fit target from the current card bbox. `inflate` widens the bbox by a
  // fraction so a still-expanding tree does not outgrow the intended frame.
  function computeFitTarget(pad, inflate) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    world.cards.forEach(function (c) {
      var w = (c.domW || c.w) / 2, h = (c.domH || c.h) / 2;
      minX = Math.min(minX, c.x - w); maxX = Math.max(maxX, c.x + w);
      minY = Math.min(minY, c.y - h); maxY = Math.max(maxY, c.y + h);
    });
    inflate = inflate || 0;
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var bw = Math.max(1, (maxX - minX) * (1 + inflate));
    var bh = Math.max(1, (maxY - minY) * (1 + inflate));
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    var scale = Math.min((vw - pad * 2) / bw, (vh - pad * 2) / bh, 1.2);
    scale = Math.max(scale, 0.25);
    return {
      x: vw / 2 - cx * scale,
      y: vh / 2 - cy * scale,
      scale: scale
    };
  }

  function applyFit(pad) {
    var t = computeFitTarget(pad, 0);
    view.x = t.x; view.y = t.y; view.scale = t.scale;
    applyView();
  }

  function tweenTo(target) { tween = target; }

  // Exponential camera easing, 0.984^dt per frame at 60fps — the same tween
  // Obsidian Canvas uses for animated view changes (RE report).
  function stepTween(dt) {
    if (!tween) return;
    var k = Math.pow(0.984, dt * 60);
    view.x += (tween.x - view.x) * (1 - k);
    view.y += (tween.y - view.y) * (1 - k);
    view.scale += (tween.scale - view.scale) * (1 - k);
    if (Math.abs(tween.x - view.x) < 0.5 && Math.abs(tween.y - view.y) < 0.5 &&
        Math.abs(tween.scale - view.scale) < 0.001) {
      view.x = tween.x; view.y = tween.y; view.scale = tween.scale;
      tween = null;
      markSessionDirty(); // persist the settled camera once, not every frame
    }
    applyView();
  }

  function onUserInteract() {
    userInteracted = true;
    tween = null; // never fight the user for the camera
    markSessionDirty(); // the camera is part of "where you left off"
  }

  // ---- main loop: fixed-step accumulator --------------------------------------
  // Physics runs at a fixed 1/60 step regardless of display refresh rate;
  // the DOM syncs once per animation frame. Backlog is clamped so a
  // backgrounded tab cannot trigger a catch-up spiral.
  var STEP_MS = 1000 / 60;
  var acc = 0;
  var last = performance.now();
  var SETTLE_AT = 4;         // seconds of simulated physics time before re-framing
  var SETTLE_INFLATE = 0.18; // bbox inflation: the tree is still expanding at SETTLE_AT
  var worldPaused = false;   // true while a card is being edited

  // One frame of work, extracted so headless smoke can drive it synchronously
  // (requestAnimationFrame does not reliably tick in a hidden window).
  function tick(dtMs) {
    var dtS = dtMs / 1000;
    if (!worldPaused) {
      acc += dtMs;
      var steps = 0;
      while (acc >= STEP_MS && steps < 5) {
        CardPhysics.step(world);
        acc -= STEP_MS;
        steps++;
      }
      if (steps >= 5) acc = 0;
      // The boot fit used the compact initial layout; once physics has
      // organized the tree, gently re-frame it toward the settled bbox.
      if (!settleFitDone && !userInteracted && world.time > SETTLE_AT) {
        settleFitDone = true;
        tweenTo(computeFitTarget(120, SETTLE_INFLATE));
      }
    } else {
      acc = 0; // no backlog while paused
    }
    stepTween(dtS);
    syncDOM();
    flushSave(false);
    flushSession(false);
  }

  function frame(now) {
    var elapsed = Math.min(now - last, 250);
    last = now;
    tick(elapsed);
    if (debug) debug.update(now, elapsed);
    requestAnimationFrame(frame);
  }

  // ---- boot / board switching --------------------------------------------------
  // Boot is async: the board library is listed over IPC, then the most recently
  // used board is opened. A first launch creates one board seeded with the
  // sample tree, so there is always something to look at.
  var loopStarted = false;
  // Diagnostic for the smoke load-check: which path boot actually took
  // (session restore vs. the "most recent board" fallback).
  var bootInfo = { restored: false, sessionBoardId: null, openedBoardId: null };
  window.__cardwallBootInfo = function () { return bootInfo; };

  function clearWorld() {
    world.cards.length = 0;
    world.dragId = null;
    world.rootHome = { x: 0, y: 0 };
    world._rootHomeInit = false;
    world.tidy = false;
    cardEls.forEach(function (el) { el.remove(); });
    cardEls.clear();
    edgeEls.forEach(function (path) { path.remove(); });
    edgeEls.clear();
    selectedId = null;
    editingId = null;
    worldPaused = false;
    saveState.dirty = false;
    acc = 0;
    tween = null;
    userInteracted = false;
    settleFitDone = false;
    world.time = 0;
  }

  function isRestorableView(v) {
    return !!v && isFinite(v.x) && isFinite(v.y) && isFinite(v.scale) && v.scale > 0;
  }

  function openBoardInto(board, restoreView) {
    clearWorld();
    if (board && Array.isArray(board.cards)) seedCards(board.cards);
    // A brand-new board (or a genuinely empty one) starts with ONE blank,
    // unnamed card in the middle, so the canvas is never a dead void. The
    // camera fit below centres it on screen; it is only persisted once the
    // user edits it (openBoardInto does not mark the board dirty).
    if (world.cards.length === 0) {
      CardPhysics.addCard(world, {
        id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        x: 0,
        y: 0,
        parent: null,
        title: '',
        note: ''
      });
    }
    // Restore the tidy flag: a board saved while tidy reopens as a clean tree;
    // one saved while free reopens exactly where the user left it. A fresh
    // board (no saved flag) opens as a tidy tree — the standard layout.
    world.tidy = !board || board.tidy === undefined ? true : !!board.tidy;
    buildDOM();
    world.cards.forEach(measure);
    // A restored camera (desktop session) is applied verbatim: the user put
    // the board exactly there, so neither the boot fit nor the settle re-frame
    // may move it. Everything else — new board, web edition — gets the fit.
    if (isRestorableView(restoreView)) {
      view.x = restoreView.x;
      view.y = restoreView.y;
      view.scale = Math.min(Math.max(restoreView.scale, 0.1), 4);
      applyView();
      settleFitDone = true;
    } else {
      applyFit(90);
    }
    syncDOM();
    currentBoard = { id: board.id, name: board.name || '未命名' };
    boardNameEl.textContent = currentBoard.name;
    document.title = currentBoard.name + ' — cardwall';
    showHome(false);
    if (!loopStarted) {
      loopStarted = true;
      requestAnimationFrame(frame);
    }
    markSessionDirty(); // this board + this camera is now "where you left off"
  }

  function boot() {
    var bridge = window.cardwall;
    if (!bridge || typeof bridge.listBoards !== 'function') {
      // Plain-browser fallback (open index.html directly): no library.
      openBoardInto({ id: null, name: '示例', cards: window.SAMPLE_TREE });
      window.__cardwallReady = true;
      return;
    }
    // Desktop: relaunching drops straight back into the last-edited board,
    // at the same pan/zoom. A session whose board was deleted since degrades
    // to the normal "most recent board" path below.
    var restore = (typeof bridge.loadSession === 'function')
      ? Promise.resolve(bridge.loadSession()).then(function (session) {
          bootInfo.sessionBoardId = session && session.lastBoardId ? session.lastBoardId : null;
          if (!session || !session.lastBoardId) return null;
          return bridge.openBoard(session.lastBoardId).then(function (board) {
            return board ? { board: board, view: session.view || null } : null;
          });
        }).catch(function () { return null; })
      : Promise.resolve(null);
    restore.then(function (restored) {
      bootInfo.restored = !!restored;
      if (restored) {
        openBoardInto(restored.board, restored.view);
        renderHome();
        bootInfo.openedBoardId = currentBoard.id;
        window.__cardwallReady = true;
        return;
      }
      return bridge.listBoards().then(function (list) {
        if (list && list.length) return bridge.openBoard(list[0].id);
        // First run: one named board, seeded so the canvas is not empty.
        return bridge.createBoard('我的第一幅图').then(function (created) {
          return bridge.saveBoard(created.id, { cards: window.SAMPLE_TREE }).then(function () {
            return { id: created.id, name: created.name, cards: window.SAMPLE_TREE };
          });
        });
      }).then(function (board) {
        if (!board) throw new Error('no board');
        openBoardInto(board);
        renderHome();
        bootInfo.openedBoardId = currentBoard.id;
        window.__cardwallReady = true;
      });
    }).catch(function (err) {
      console.error('[cardwall] boot failed:', err);
      openBoardInto({ id: null, name: '示例', cards: window.SAMPLE_TREE });
      bootInfo.openedBoardId = currentBoard.id;
      window.__cardwallReady = true;
    });
  }

  // ---- home: the board library ------------------------------------------------
  function showHome(on) {
    homeEl.hidden = !on;
    if (on) {
      renderHome();
      document.title = '卡片墙 — cardwall';
    } else if (currentBoard.name) {
      document.title = currentBoard.name + ' — cardwall';
    }
  }

  function homeVisible() {
    return !homeEl.hidden;
  }

  function relativeTime(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' 天前';
    var d = new Date(t);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function renderHome() {
    if (!window.cardwall || typeof window.cardwall.listBoards !== 'function') {
      homeEmptyEl.hidden = false;
      return Promise.resolve([]);
    }
    return window.cardwall.listBoards().then(function (list) {
      boardListEl.innerHTML = '';
      (list || []).forEach(function (b) {
        boardListEl.appendChild(homeCard(b));
      });
      homeEmptyEl.hidden = (list || []).length > 0;
      return list || [];
    });
  }

  function homeCard(board) {
    var card = document.createElement('div');
    card.className = 'home-card' + (board.id === currentBoard.id ? ' current' : '') + (board.pinned ? ' pinned' : '');
    card.setAttribute('role', 'listitem');
    card.dataset.id = board.id;

    var title = document.createElement('div');
    title.className = 'home-card-name';
    title.textContent = (board.pinned ? '📌 ' : '') + board.name;

    var meta = document.createElement('div');
    meta.className = 'home-card-meta';
    meta.textContent = board.cards + ' 张卡' + (board.savedAt ? ' · ' + relativeTime(board.savedAt) : '');

    var actions = document.createElement('div');
    actions.className = 'home-card-actions';
    var pin = document.createElement('button');
    pin.type = 'button';
    pin.dataset.act = 'pin';
    pin.textContent = board.pinned ? '取消置顶' : '置顶';
    pin.title = board.pinned ? '从置顶区移除' : '置顶到图库最前面';
    var rename = document.createElement('button');
    rename.type = 'button';
    rename.dataset.act = 'rename';
    rename.textContent = '重命名';
    var del = document.createElement('button');
    del.type = 'button';
    del.dataset.act = 'delete';
    del.textContent = '删除';
    actions.appendChild(pin);
    actions.appendChild(rename);
    actions.appendChild(del);

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(actions);

    // Clicking the body opens; the buttons are handled separately below.
    card.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (btn) {
        if (btn.dataset.act === 'pin') {
          togglePinById(board.id, !board.pinned);
        } else if (btn.dataset.act === 'rename') {
          renameBoardById(board.id, board.name);
        } else if (btn.dataset.act === 'delete') {
          deleteBoardById(board.id);
        }
        return;
      }
      openBoardById(board.id);
    });
    return card;
  }

  // Favourite / pin toggle. The pin is a library-level flag, so unlike a card
  // save it does not need the board open — the handler reads and writes the
  // file directly. Unsupported bridges (none today) degrade to a no-op.
  function togglePinById(id, pinned) {
    if (!window.cardwall || typeof window.cardwall.pinBoard !== 'function') {
      return Promise.resolve(null);
    }
    return window.cardwall.pinBoard(id, pinned).then(function (r) {
      renderHome(); // re-sort: pinned boards float to the top
      return r;
    });
  }

  function openBoardById(id) {
    if (!window.cardwall || typeof window.cardwall.openBoard !== 'function') return Promise.resolve(null);
    flushSave(true); // never lose the board we are leaving
    return window.cardwall.openBoard(id).then(function (board) {
      if (!board) return null;
      openBoardInto(board);
      flushSession(true); // the session now points at the board just opened
      return board;
    });
  }

  function createBoardWithName(name) {
    if (!window.cardwall || typeof window.cardwall.createBoard !== 'function') return Promise.resolve(null);
    return window.cardwall.createBoard(name).then(function (created) {
      if (!created) return null;
      return window.cardwall.openBoard(created.id).then(function (board) {
        openBoardInto(board || { id: created.id, name: created.name, cards: [] });
        flushSession(true);
        renderHome();
        return created;
      });
    });
  }

  function renameBoardById(id, currentName) {
    return askName({ title: '给这幅图起个名字', value: currentName || '' }).then(function (name) {
      if (name == null) return null;
      return window.cardwall.renameBoard(id, name).then(function (r) {
        if (r && r.ok && id === currentBoard.id) {
          currentBoard.name = r.name;
          boardNameEl.textContent = r.name;
          document.title = r.name + ' — cardwall';
        }
        renderHome();
        return r;
      });
    });
  }

  function deleteBoardById(id) {
    var isWeb = !!(window.cardwall && window.cardwall.platform === 'web');
    return confirmDialog({
      title: '删除这幅图？',
      body: isWeb
        ? '网页版没有废纸篓，删除后无法恢复。'
        : '文件会进废纸篓，可以从 Finder 里恢复。'
    }).then(function (yes) {
      if (!yes) return null;
      return window.cardwall.deleteBoard(id).then(function (r) {
        // Deleting the board you are looking at drops you back to the library.
        if (r && r.ok && id === currentBoard.id) {
          currentBoard = { id: null, name: '' };
          clearWorld();
          showHome(true);
          window.cardwall.listBoards().then(function (list) {
            if (list && list.length) openBoardById(list[0].id);
            else renderHome();
          });
        } else {
          renderHome();
        }
        return r;
      });
    });
  }

  // ---- dialog (new board name / rename / confirm) ------------------------------
  // Electron does not implement window.prompt/confirm, so the app carries its
  // own tiny modal. One dialog, three shapes: text, confirm, and alert-ish.
  var dialogResolve = null;

  function openDialog(opts) {
    return new Promise(function (resolve) {
      dialogResolve = resolve;
      dialogLabel.textContent = opts.label || '名称';
      dialogInput.value = opts.value || '';
      dialogInput.hidden = opts.mode === 'confirm';
      dialogLabel.hidden = opts.mode === 'confirm';
      dialogEl.dataset.mode = opts.mode || 'text';
      var ok = document.getElementById('dialog-ok');
      ok.textContent = opts.okText || '确定';
      dialogEl.hidden = false;
      if (opts.mode !== 'confirm') {
        setTimeout(function () { dialogInput.focus(); dialogInput.select(); }, 0);
      } else {
        setTimeout(function () { ok.focus(); }, 0);
      }
    });
  }

  function closeDialog(result) {
    dialogEl.hidden = true;
    var resolve = dialogResolve;
    dialogResolve = null;
    if (resolve) resolve(result);
  }

  function askName(opts) {
    return openDialog({ label: opts.title || '名称', value: opts.value, mode: 'text' }).then(function (value) {
      if (value == null) return null;
      var trimmed = String(value).replace(/\s+/g, ' ').trim().slice(0, 80);
      return trimmed || null;
    });
  }

  function confirmDialog(opts) {
    return openDialog({ label: opts.title, mode: 'confirm', okText: opts.okText || '删除' });
  }

  dialogForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (dialogEl.dataset.mode === 'confirm') { closeDialog(true); return; }
    closeDialog(dialogInput.value);
  });
  dialogCancel.addEventListener('click', function () { closeDialog(null); });
  dialogEl.addEventListener('click', function (e) {
    if (e.target === dialogEl) closeDialog(null); // click the backdrop to bail
  });

  homeBtn.addEventListener('click', function () {
    if (homeVisible()) showHome(false);
    else showHome(true);
  });
  // The web edition keeps nothing across reloads; say so in the Guidance
  // panel (desktop users never see this line).
  var webNote = document.getElementById('web-note');
  if (webNote && isWebPlatform) webNote.hidden = false;
  // The top bar's quick "返回首页" (next to 一键整洁): always opens the library.
  // The library's own "← 返回当前图" button takes you back to the board.
  var homeTopBtn = document.getElementById('home-top-btn');
  if (homeTopBtn) homeTopBtn.addEventListener('click', function () { showHome(true); });
  // The top bar no longer carries a back arrow, so the library gets its own
  // visible "return to the current board" button.
  var homeBackBtn = document.getElementById('home-back');
  if (homeBackBtn) homeBackBtn.addEventListener('click', function () {
    if (currentBoard.id) showHome(false);
  });
  boardNameEl.addEventListener('click', function () {
    if (currentBoard.id) renameBoardById(currentBoard.id, currentBoard.name);
  });
  var tidyBtn = document.getElementById('tidy-btn');
  if (tidyBtn) tidyBtn.addEventListener('click', function () { tidyAll(); });
  newBoardBtn.addEventListener('click', function () {
    askName({ title: '新的一幅图', value: '' }).then(function (name) {
      if (name == null) return;
      createBoardWithName(name);
    });
  });

  // ---- Guidance panel ------------------------------------------------------------
  // The old top-bar clutter (home / board name / hints / theme) collapses into one
  // floating, blurred, MODAL help surface. Opening it blurs + locks the board
  // behind it; only Escape or the close affordance dismiss it. It owns the
  // keyboard while open (see the keydown handler above).
  var guidanceEl = document.getElementById('guidance');
  var guidanceBtn = document.getElementById('guidance-btn');
  var guidanceClose = document.getElementById('guidance-close');
  var guidanceBackdrop = guidanceEl ? guidanceEl.querySelector('.guidance-backdrop') : null;

  function openGuidance() { if (guidanceEl) guidanceEl.hidden = false; }
  function closeGuidance() { if (guidanceEl) guidanceEl.hidden = true; }

  if (guidanceBtn) guidanceBtn.addEventListener('click', openGuidance);
  if (guidanceClose) guidanceClose.addEventListener('click', closeGuidance);
  if (guidanceBackdrop) guidanceBackdrop.addEventListener('click', closeGuidance);
  // Leaving Guidance (via its own actions, or the home button inside it) must
  // reveal whatever it was covering rather than leave the board blurred.
  homeBtn.addEventListener('click', closeGuidance);
  var guidanceNew = document.getElementById('guidance-new');
  if (guidanceNew) guidanceNew.addEventListener('click', function () { closeGuidance(); newBoardBtn.click(); });
  var guidanceTheme = document.getElementById('guidance-theme');
  if (guidanceTheme) {
    // The label names the NEXT mode (what the press will switch to), so the
    // three-state cycle is visible without a manual.
    var THEME_NEXT_LABEL = { dark: '浅色', light: '跟随系统', auto: '深色' };
    function refreshThemeButton() {
      var next = THEME_MODES[(THEME_MODES.indexOf(themeMode()) + 1) % THEME_MODES.length];
      guidanceTheme.textContent = '切换主题 → ' + THEME_NEXT_LABEL[next];
    }
    guidanceTheme.addEventListener('click', function () {
      toggleTheme();
      refreshThemeButton();
    });
    refreshThemeButton();
    // Keep the label honest when the OS flip re-renders an 'auto' board.
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      if (mq.addEventListener) mq.addEventListener('change', refreshThemeButton);
    }
  }

  // Web (touch) build: the guide list is written for a mouse, so append the
  // gestures that only exist on a touchscreen.
  if (window.cardwall && window.cardwall.platform === 'web') {
    var guideList = document.querySelector('.guide-list');
    if (guideList) {
      var touchLi = document.createElement('li');
      touchLi.innerHTML = '<b>双指捏合</b>：缩放；<b>双指拖动</b>：平移；<b>点一下卡片</b>：选中并浮出操作条';
      guideList.appendChild(touchLi);
    }
  }

  // ---- card editing (C5): selection, inline edit, create, delete ------------
  var selectedId = null;
  var editingId = null;

  function select(id) {
    if (selectedId && cardEls.get(selectedId)) {
      cardEls.get(selectedId).classList.remove('selected');
    }
    selectedId = id || null;
    var el = selectedId && cardEls.get(selectedId);
    if (el) el.classList.add('selected');
  }

  function editorEls(id) {
    var el = cardEls.get(id);
    if (!el) return null;
    return {
      el: el,
      title: el.querySelector('.card-title'),
      note: el.querySelector('.card-note')
    };
  }

  function caretToEnd(elm) {
    var range = document.createRange();
    range.selectNodeContents(elm);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Editing pauses the world: with Brownian drift running, the text would
  // slide under the caret. Pause/resume is the whole focus-mode contract.
  function startEdit(card) {
    if (!card || editingId === card.id) return;
    if (editingId) commitEdit();
    var parts = editorEls(card.id);
    if (!parts) return;
    editingId = card.id;
    worldPaused = true;
    parts.el.classList.add('editing');
    parts.title.contentEditable = 'plaintext-only';
    parts.note.contentEditable = 'plaintext-only';
    parts.title.focus();
    caretToEnd(parts.title);
  }

  function cancelEdit() {
    if (!editingId) return;
    var card = CardPhysics.findCard(world, editingId);
    var parts = editorEls(editingId);
    if (card && parts) {
      parts.title.textContent = card.title;
      parts.note.textContent = card.note;
    }
    commitEdit();
  }

  function commitEdit() {
    if (!editingId) return;
    var id = editingId;
    var card = CardPhysics.findCard(world, id);
    var parts = editorEls(id);
    editingId = null;
    worldPaused = false;
    if (!card || !parts) return;
    card.title = (parts.title.textContent || '').trim() || '未命名';
    card.note = (parts.note.textContent || '').trim();
    parts.title.textContent = card.title;
    parts.note.textContent = card.note;
    parts.title.contentEditable = 'false';
    parts.note.contentEditable = 'false';
    parts.el.classList.remove('editing');
    measure(card); // text reflow can change the card size -> edge endpoints
    markDirty();
    syncDOM();
  }

  // Nearest card within `maxDist` of a world point — the parent picker for
  // cards created on empty canvas ("grow the tree where you click").
  function nearestCardId(p, maxDist) {
    var best = null;
    var bestD = maxDist * maxDist;
    world.cards.forEach(function (c) {
      var dx = c.x - p.x, dy = c.y - p.y;
      var d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = c.id; }
    });
    return best;
  }

  // Card whose body contains a world point (last match = topmost paint order).
  function cardAt(x, y, excludeId) {
    var hit = null;
    world.cards.forEach(function (c) {
      if (c.id === excludeId) return;
      var w = (c.domW || c.w) / 2, h = (c.domH || c.h) / 2;
      if (Math.abs(x - c.x) <= w && Math.abs(y - c.y) <= h) hit = c.id;
    });
    return hit;
  }

  // Is `ancestorId` an ancestor of `id`? (guards re-parent cycles)
  function isAncestor(ancestorId, id) {
    var cur = CardPhysics.findCard(world, id);
    var guard = 0;
    while (cur && cur.parent && guard++ < 1000) {
      if (cur.parent === ancestorId) return true;
      cur = CardPhysics.findCard(world, cur.parent);
    }
    return false;
  }

  // Every card below `id`, in tree order — used to wake a whole branch so it
  // floats along when its root is grabbed.
  function descendantsOf(id) {
    var out = [];
    var frontier = [id];
    while (frontier.length) {
      var curId = frontier.pop();
      world.cards.forEach(function (c) {
        if (c.parent !== curId) return;
        out.push(c);
        frontier.push(c.id);
      });
    }
    return out;
  }

  // Wake a card and its branch: dormancy keeps the board still, but anything
  // the user touches should come alive immediately.
  function wakeBranch(id) {
    var card = CardPhysics.findCard(world, id);
    if (!card) return;
    CardPhysics.wake(card);
    descendantsOf(id).forEach(CardPhysics.wake);
  }

  function reparent(card, targetId) {
    if (!card || !targetId || targetId === card.id) return false;
    if (isAncestor(card.id, targetId)) return false; // would close a cycle
    card.parent = targetId;
    addEdgePath(card);
    var el = cardEls.get(card.id);
    if (el) el.classList.remove('card-root');
    markDirty();
    syncDOM();
    return true;
  }

  function createCard(worldPoint, parentId) {
    var id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var parent = parentId && CardPhysics.findCard(world, parentId) ? parentId : null;
    var pos;
    if (parent) {
      // Grow a CHILD of the current node, placed clearly BELOW it (the
      // canonical child level) and fanned out to the right for each sibling —
      // so repeated "+" adds never stack on top of the parent or each other.
      // This fixes the old bug where the child was dropped at the click point
      // and visually overwrote the node it hung from.
      var pCard = CardPhysics.findCard(world, parent);
      var sibCount = world.cards.filter(function (c) { return c.parent === parent; }).length;
      pos = {
        x: pCard.x + sibCount * world.config.nodeGap,
        y: pCard.y + world.config.levelGap + 40
      };
    } else {
      pos = worldPoint; // a free node dropped on empty canvas
    }
    var card = CardPhysics.addCard(world, {
      id: id,
      x: pos.x,
      y: pos.y,
      parent: parent,
      title: '',
      note: ''
    });
    var el = buildCardEl(card);
    worldEl.appendChild(el);
    addEdgePath(card);
    measure(card);
    raise(el);
    select(id);
    markDirty();
    syncDOM();
    startEdit(card);
    return card;
  }

  // Called when the user grabs a card: it (and its branch) comes alive so the
  // physics re-lays the tree out around it (root drag -> whole tree follows;
  // child drag -> its subtree re-flows at the cursor). There is no "pin" — every
  // card belongs to the float and the tidy pull is opt-in, so a free card simply
  // holds where the user dropped it until tidy is engaged.
  function onGrab(card) {
    if (!card) return;
    world.dragId = card.id;
    wakeBranch(card.id);
  }

  // Called when the user lets go of a card.
  //
  // v0.6 model: RELEASE = FREE. The dragged card (and, because we dropped the
  // always-on tidy in favour of on-demand tidy, the whole board) stays exactly
  // where it was dropped — nothing springs back to the tree. The tidy tree is
  // rebuilt only by the "一键整洁" button (tidyAll), so the user owns every
  // node's position until they ask for the standard layout.
  function onCardPlaced(card) {
    if (!card) return;
    world.tidy = false;
    world.dragId = null;
    markDirty();
  }

  // "一键整洁": re-flow the whole board into the standard tidy tree. This is
  // the ONLY thing that imposes the tree on a free board (v0.6 model). With the
  // pin feature gone, every card obeys the pull, so a scattered board visibly
  // snaps back into the clean diagram — and we add a transient "整理中…" label
  // + a pulse so the press always reads as having done something.
  var tidyBtnTimer = null;
  function tidyAll() {
    CardPhysics.tidy(world);
    // wake every card so the spring actually moves it (dormant cards freeze).
    world.cards.forEach(function (c) { c.awake = true; c.still = 0; });
    markDirty();
    syncDOM();
    if (tidyBtn) {
      tidyBtn.classList.add('tidying');
      tidyBtn.textContent = '整理中…';
      if (tidyBtnTimer) clearTimeout(tidyBtnTimer);
      tidyBtnTimer = setTimeout(function () {
        tidyBtn.classList.remove('tidying');
        tidyBtn.textContent = '一键整洁';
      }, 750);
    }
  }

  function deleteCard(id) {
    var card = CardPhysics.findCard(world, id);
    if (!card) return;
    // Re-parent children to the deleted card's parent so the tree stays
    // connected instead of silently losing a whole subtree.
    world.cards.forEach(function (c) {
      if (c.parent !== id) return;
      c.parent = card.parent || null;
      if (c.parent) addEdgePath(c); else removeEdgePath(c.id);
    });
    var el = cardEls.get(id);
    if (el) el.remove();
    cardEls.delete(id);
    removeEdgePath(id);
    CardPhysics.removeCard(world, id);
    if (selectedId === id) selectedId = null;
    if (editingId === id) { editingId = null; worldPaused = false; }
    markDirty();
    syncDOM();
  }

  // ---- card colours --------------------------------------------------------
  // Apply a preset colour (or null for the default panel) to one card and
  // persist it with the next board save. The value is whitelisted by both
  // sanitizers, so even a corrupt file can only ever land on the palette.
  function setCardColor(id, color) {
    var card = CardPhysics.findCard(world, id);
    if (!card) return;
    var next = CARD_COLORS.indexOf(color) >= 0 ? color : null;
    if (card.color === next) return;
    card.color = next;
    var el = cardEls.get(id);
    if (el) {
      if (next) el.dataset.color = next;
      else delete el.dataset.color;
    }
    markDirty();
    syncDOM();
  }

  // The palette is a hover popover inside the action bar; only one may be
  // open at a time. Clicking the swatch button opens it; clicking anywhere
  // else (viewport pointerdown, a colour pick, Esc) closes it.
  function closeAllPalettes() {
    var open = document.querySelectorAll('.card-palette:not([hidden])');
    for (var i = 0; i < open.length; i++) open[i].hidden = true;
  }

  // Selection on pointerdown; committing an open editor when clicking away.
  viewport.addEventListener('pointerdown', function (e) {
    // Any press outside an open palette dismisses it (the swatch click itself
    // is handled by the click listener below, which runs after pointerdown).
    if (!(e.target.closest && e.target.closest('.card-color-wrap'))) closeAllPalettes();
    var cardEl = e.target.closest ? e.target.closest('.card') : null;
    if (editingId && (!cardEl || cardEl.dataset.id !== editingId)) commitEdit();
    select(cardEl ? cardEl.dataset.id : null);
  });

  // Double-click a card to edit it; double-click empty canvas to add a card
  // (child of the selection, if any). Toolbar buttons have their own click
  // handlers and must not also trigger a double-click edit.
  viewport.addEventListener('dblclick', function (e) {
    if (e.target.closest && e.target.closest('.card-toolbar')) return;
    var cardEl = e.target.closest ? e.target.closest('.card') : null;
    if (cardEl) {
      var card = CardPhysics.findCard(world, cardEl.dataset.id);
      if (!card) return;
      raise(cardEl);
      startEdit(card);
      return;
    }
    var rect = viewport.getBoundingClientRect();
    var p = {
      x: (e.clientX - rect.left - view.x) / view.scale,
      y: (e.clientY - rect.top - view.y) / view.scale
    };
    createCard(p, nearestCardId(p, 320));
  });

  // Hover action bar (edit / add / delete) — delegated so it covers every
  // card, including ones created on the fly. The pointerdown handler in
  // interaction.js already declines to drag/pan when the press lands on the
  // toolbar, so here we only need to act on the click.
  viewport.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.card-toolbar button') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var cardEl = btn.closest('.card');
    if (!cardEl) return;
    var card = CardPhysics.findCard(world, cardEl.dataset.id);
    if (!card) return;
    var act = btn.dataset.act;
    if (act === 'edit') {
      startEdit(card);
    } else if (act === 'add') {
      // Grow a CHILD of this card: createCard hangs it off `card` and places
      // it fanned out below-right (never on top of the parent, so the old
      // "child overwrites the node it hangs from" bug cannot recur), then
      // opens it straight into edit mode.
      createCard(null, card.id);
    } else if (act === 'color') {
      // The swatch button (no data-color) toggles this card's palette; a
      // swatch inside it applies that colour (empty string = default).
      var palette = btn.parentNode ? btn.parentNode.querySelector('.card-palette') : null;
      if (palette && !btn.classList.contains('card-swatch')) {
        var wasHidden = palette.hidden;
        closeAllPalettes();
        palette.hidden = !wasHidden;
        return;
      }
      closeAllPalettes();
      setCardColor(card.id, btn.dataset.color || null);
    } else if (act === 'del') {
      deleteCard(card.id);
    }
  });

  viewport.addEventListener('keydown', function (e) {
    if (!editingId) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('card-title')) {
      e.preventDefault();
      commitEdit();
    }
  });

  viewport.addEventListener('input', function () {
    if (!editingId) return;
    var card = CardPhysics.findCard(world, editingId);
    if (card) { measure(card); syncDOM(); }
  });

  // Commit when focus leaves the edited card entirely (title <-> note moves
  // must not commit, so check the card containment on the next tick).
  viewport.addEventListener('focusout', function () {
    if (!editingId) return;
    setTimeout(function () {
      if (!editingId) return;
      var el = cardEls.get(editingId);
      if (el && document.activeElement && el.contains(document.activeElement)) return;
      commitEdit();
    }, 0);
  });

  // ---- theme ---------------------------------------------------------------
  // Dark is the default. Cmd/Ctrl+Shift+L cycles dark -> light -> auto, where
  // auto follows the OS (prefers-color-scheme) live. The chosen mode is
  // remembered across launches on the DESKTOP build (index.html applies it
  // before the first paint so a light board does not flash black on boot).
  // The web edition remembers nothing — not even the theme.
  var isWebPlatform = !!(window.cardwall && window.cardwall.platform === 'web');

  function storedTheme() {
    try {
      var v = localStorage.getItem(THEME_KEY);
      return THEME_MODES.indexOf(v) >= 0 ? v : 'dark';
    } catch (err) { return 'dark'; }
  }

  function systemPrefersLight() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }

  // The stored MODE ('dark' | 'light' | 'auto'), not the rendered theme.
  function themeMode() {
    return isWebPlatform ? 'dark' : storedTheme();
  }

  // What the canvas actually looks like right now.
  function currentTheme() {
    if (themeMode() === 'auto') return systemPrefersLight() ? 'light' : 'dark';
    return themeMode() === 'light' ? 'light' : 'dark';
  }

  function applyThemeMode(mode) {
    var resolved = mode === 'auto' ? (systemPrefersLight() ? 'light' : 'dark') : mode;
    if (resolved === 'light') {
      document.documentElement.dataset.theme = 'light';
    } else {
      delete document.documentElement.dataset.theme;
    }
    if (isWebPlatform) return; // the browser keeps nothing
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch (err) { /* storage unavailable — the theme just won't persist */ }
  }

  function toggleTheme() {
    // dark -> light -> auto -> dark …
    var next = THEME_MODES[(THEME_MODES.indexOf(themeMode()) + 1) % THEME_MODES.length];
    applyThemeMode(next);
  }

  // While the mode is 'auto', the OS flipping between light and dark must
  // re-render the canvas immediately (no reload, no mode change on disk).
  if (window.matchMedia) {
    var themeMQ = window.matchMedia('(prefers-color-scheme: light)');
    if (themeMQ.addEventListener) {
      themeMQ.addEventListener('change', function () {
        if (themeMode() === 'auto') applyThemeMode('auto');
      });
    }
  }

  window.addEventListener('keydown', function (e) {
    // The editor (viewport handler) already consumed this key; without this
    // guard an Escape that closes the editor would also clear the selection.
    if (e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      toggleTheme(); // works while editing too
      return;
    }
    // The Guidance panel is a modal: while it is open, only Escape closes it and
    // every other shortcut is locked so the blurred board behind cannot be driven.
    var guidanceElRef = document.getElementById('guidance');
    if (guidanceElRef && !guidanceElRef.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeGuidance(); }
      return;
    }
    // The dialog and the home screen own the keyboard while they are up.
    if (!dialogEl.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(null); }
      return;
    }
    if (homeVisible()) {
      if (e.key === 'Escape' || e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        if (currentBoard.id) showHome(false);
      }
      return;
    }
    if ((e.key === 'h' || e.key === 'H') && !e.metaKey && !e.ctrlKey && !e.altKey && !editingId) {
      e.preventDefault();
      showHome(true);
      return;
    }
    if (editingId) return; // the editor owns the keyboard
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.preventDefault();
      deleteCard(selectedId);
    } else if ((e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      tidyAll();
    } else if (e.key === 'Escape' && selectedId) {
      closeAllPalettes();
      select(null);
    }
  });

  // Force a save and return its promise (smoke uses this for the disk check).
  // The session is force-flushed alongside, so a reload right after this
  // (smoke's load-check) deterministically finds the board on disk.
  window.__cardwallSaveNow = function () {
    markDirty();
    markSessionDirty();
    return flushSave(true).then(function (r) {
      return flushSession(true).then(function () { return r; });
    });
  };

  // Theme round trip through the real key handler, so smoke exercises the
  // shortcut rather than a private function, and leaves the board on dark.
  // The cycle is dark -> light -> auto -> dark; 'auto' resolves through the
  // OS preference, which in the headless runner is dark (no light query).
  window.__cardwallThemeCheck = function () {
    function probe() {
      var card = document.querySelector('.card');
      return {
        theme: currentTheme(),
        mode: themeMode(),
        bg: getComputedStyle(document.body).backgroundColor,
        ink: getComputedStyle(document.body).color,
        cardBg: card ? getComputedStyle(card).backgroundColor : null
      };
    }
    function press() {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'L', metaKey: true, shiftKey: true, bubbles: true, cancelable: true
      }));
    }
    // Start from a known state: a previous session may have left another mode
    // stored, which would otherwise make this check environment-dependent.
    applyThemeMode('dark');
    var start = probe();
    press();
    var flipped = probe();
    press();
    var auto = probe();
    press();
    var back = probe();
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (err) { stored = null; }
    var BLACK = 'rgb(0, 0, 0)';
    return {
      ok: start.mode === 'dark' && start.theme === 'dark' && start.bg === BLACK &&
        flipped.mode === 'light' && flipped.theme === 'light' && flipped.bg !== BLACK && flipped.cardBg === 'rgb(255, 255, 255)' &&
        auto.mode === 'auto' && auto.theme === 'dark' && auto.bg === BLACK &&
        back.mode === 'dark' && back.theme === 'dark' && back.bg === BLACK &&
        stored === 'dark',
      start: start,
      flipped: flipped,
      auto: auto,
      back: back,
      stored: stored
    };
  };

  // ---- self-check hook -----------------------------------------------------------
  // Deterministic (no rAF dependency) so `npm run smoke` can verify the
  // render pipeline in a headless window.
  window.__cardwall = { world: world, view: view, syncDOM: syncDOM, cardEls: cardEls };
  window.__cardwallSelfCheck = function (steps) {
    for (var i = 0; i < (steps || 120); i++) CardPhysics.step(world);
    syncDOM();
    var cards = document.querySelectorAll('.card');
    var paths = document.querySelectorAll('#edges path');
    var edgesWithPath = 0;
    paths.forEach(function (p) { if (p.getAttribute('d')) edgesWithPath++; });
    return {
      cards: cards.length,
      edges: paths.length,
      edgesWithPath: edgesWithPath,
      physicsCards: world.cards.length,
      allFinite: world.cards.every(function (c) {
        return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.vx) && Number.isFinite(c.vy);
      }),
      worldTransform: worldEl.style.transform,
      firstCardTransform: cards[0] ? cards[0].style.transform : null
    };
  };

  // ---- camera check hook ----------------------------------------------------------
  // Drives ticks synchronously past the settle threshold, then verifies the
  // settled framing clips nothing and that user input cancels a live tween.
  window.__cardwallTick = tick;
  window.__cardwallCameraCheck = function () {
    for (var i = 0; i < 750; i++) tick(STEP_MS); // ~12.5 simulated seconds
    var settled = settleFitDone;
    var converged = tween === null;
    // No-clip invariant: every card's on-screen rect lies inside the viewport.
    var noClip = world.cards.every(function (c) {
      var w = (c.domW || c.w) / 2, h = (c.domH || c.h) / 2;
      var x0 = (c.x - w) * view.scale + view.x, x1 = (c.x + w) * view.scale + view.x;
      var y0 = (c.y - h) * view.scale + view.y, y1 = (c.y + h) * view.scale + view.y;
      return x0 >= -1 && x1 <= viewport.clientWidth + 1 &&
             y0 >= -1 && y1 <= viewport.clientHeight + 1;
    });
    // Cancellation: start a tween, then a wheel event must kill it.
    tweenTo(computeFitTarget(120, 0));
    var tweenStarted = tween !== null;
    viewport.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX: 640, clientY: 400, deltaY: -120
    }));
    var cancelled = tween === null && userInteracted;
    return {
      ok: settled && converged && noClip && tweenStarted && cancelled,
      settled: settled,
      converged: converged,
      noClip: noClip,
      tweenStarted: tweenStarted,
      cancelled: cancelled,
      scale: view.scale
    };
  };

  // ---- debug overlay (C7, F3) --------------------------------------------------
  var debug = window.CardDebug ? window.CardDebug.init({
    viewport: viewport,
    world: world,
    view: view,
    edgesEl: edgesEl,
    physics: CardPhysics,
    isTweening: function () { return !!tween; },
    isPaused: function () { return worldPaused; }
  }) : null;

  if (debug && window.__cardwall) window.__cardwall.debug = debug;

  window.__cardwallDebugCheck = function () {
    var panel = document.getElementById('debug-panel');
    var layer = document.getElementById('debug-layer');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true }));
    var on = debug.isOn();
    debug.update(performance.now() + 100000, 16); // force a refresh (rAF may be idle)
    var stats = (panel.textContent || '').length > 20 && layer.childNodes.length > 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true }));
    var off = !debug.isOn() && !panel.classList.contains('visible');
    return {
      ok: on && stats && off,
      on: on,
      stats: stats,
      off: off,
      nodes: layer.childNodes.length,
      text: (panel.textContent || '').slice(0, 80)
    };
  };

  // ---- interaction (C4) -------------------------------------------------------------
  window.CardInteraction.init({
    viewport: viewport,
    view: view,
    applyView: applyView,
    syncDOM: syncDOM,
    onUserInteract: onUserInteract,
    onCardPlaced: onCardPlaced,
    onCardDropped: reparent,
    cardAt: cardAt,
    onGrab: onGrab,
    raise: raise,
    findCard: function (id) { return CardPhysics.findCard(world, id); }
  });

  // Headless integration check: synthetic pointer/wheel events against the
  // real listeners. Returns a report; smoke mode asserts every field.
  window.__cardwallInteractionCheck = function () {
    var vp = document.getElementById('viewport');
    var view0 = { x: view.x, y: view.y, scale: view.scale };

    function fire(type, target, x, y, extra) {
      var ev = new (type === 'wheel' ? WheelEvent : PointerEvent)(type, Object.assign({
        bubbles: true, cancelable: true, pointerId: 1, button: 0,
        clientX: x, clientY: y
      }, extra || {}));
      target.dispatchEvent(ev);
      return ev;
    }

    // 1. pan: pointerdown on empty viewport, drag, release
    fire('pointerdown', vp, 640, 400);
    fire('pointermove', vp, 540, 300);
    fire('pointerup', vp, 540, 300);
    var pan = {
      ok: Math.abs(view.x - (view0.x - 100)) < 0.01 && Math.abs(view.y - (view0.y - 100)) < 0.01,
      dx: view.x - view0.x, dy: view.y - view0.y
    };

    // 2. wheel zoom anchored at (640, 400): world point under cursor invariant
    var before = { scale: view.scale };
    var anchorWorld = { x: (640 - view.x) / view.scale, y: (400 - view.y) / view.scale };
    fire('wheel', vp, 640, 400, { deltaY: -100 });
    var after = { scale: view.scale };
    var anchorWorld2 = { x: (640 - view.x) / view.scale, y: (400 - view.y) / view.scale };
    var zoom = {
      ok: after.scale > before.scale && after.scale <= 2.5 &&
        Math.abs(anchorWorld2.x - anchorWorld.x) < 0.01 &&
        Math.abs(anchorWorld2.y - anchorWorld.y) < 0.01,
      scaleBefore: before.scale, scaleAfter: after.scale
    };

    // 3. card drag + one-click tidy (free-placement model).
    //    Drag gives FULL FREEDOM: grab a card and its subtree follows the
    //    cursor, but on release nothing snaps back — the board stays where you
    //    let go. The tidy tree is rebuilt only by the "一键整洁" button, and
    //    with no pin concept every card obeys that pull.
    var cardEl = document.querySelector('.card');
    var card = CardPhysics.findCard(world, cardEl.dataset.id);
    var sub = descendantsOf(card.id);
    var beforeAll = world.cards.map(function (c) { return { c: c, x: c.x, y: c.y }; });
    var before = [card].concat(sub).map(function (c) { return { c: c, x: c.x, y: c.y }; });
    var rect = cardEl.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var start = { x: card.x, y: card.y };
    fire('pointerdown', cardEl, cx, cy);
    fire('pointermove', cardEl, cx + 40, cy);
    // Step the physics while the card is still held: the branch is towed by
    // the tree re-flow, and that only shows up once the integrator has run.
    // (The synthetic pointer events do not advance the rAF loop, so we step
    // it by hand here.)
    for (var d1 = 0; d1 < 30; d1++) CardPhysics.step(world);
    var towedDuringDrag = sub.map(function (s) {
      var b = before.filter(function (e) { return e.c === s; })[0];
      return Math.round(Math.hypot(s.x - b.x, s.y - b.y));
    });
    fire('pointermove', cardEl, cx + 80, cy);
    for (var d2 = 0; d2 < 30; d2++) CardPhysics.step(world);
    fire('pointerup', cardEl, cx + 80, cy);
    var movedBy = card.x - start.x; // ~80 screen px expressed in world units
    // The branch was actually TOWED: at least half of it travelled a real
    // distance while the card was held.
    var towed = towedDuringDrag.filter(function (t) { return t > 20; }).length;
    var towedEnough = towed >= Math.max(1, Math.ceil(sub.length / 2));

    // Release => FREE: onCardPlaced set world.tidy = false, so the board no
    // longer auto-tidies and the dropped card holds exactly where it landed.
    for (var s1 = 0; s1 < 300; s1++) CardPhysics.step(world);
    var heldStill = Math.hypot(card.vx, card.vy) < 1;

    // "一键整洁": re-tree the WHOLE board — the only thing that imposes the
    // tree on a free board. With no pin concept, every card obeys the pull and
    // the spring draws the whole diagram into its canonical tidy layout.
    world.cards.forEach(function (c) { c.awake = true; c.still = 0; });
    CardPhysics.tidy(world);
    for (var s2 = 0; s2 < 400; s2++) CardPhysics.step(world);
    function depthOf(c) {
      var d = 0, cur = c, guard = 0;
      while (cur && cur.parent && guard++ < 1000) { d++; cur = CardPhysics.findCard(world, cur.parent); }
      return d;
    }
    var levelGap = CardPhysics.CONFIG.levelGap;
    var depth1 = world.cards.filter(function (c) { return depthOf(c) === 1; });
    var depth2 = world.cards.filter(function (c) { return depthOf(c) === 2; });
    var level1ok = depth1.length > 0 && depth1.every(function (s) {
      return Math.abs((s.y - card.y) - levelGap) < 90;
    });
    var level2ok = depth2.every(function (s) {
      return Math.abs((s.y - card.y) - 2 * levelGap) < 90;
    });
    var xs = depth1.map(function (s) { return s.x; });
    var spread = xs.length > 1 ? (Math.max.apply(null, xs) - Math.min.apply(null, xs)) : 999;
    var noOverlap = true;
    for (var i1 = 0; i1 < world.cards.length && noOverlap; i1++) {
      for (var j1 = i1 + 1; j1 < world.cards.length; j1++) {
        var a = world.cards[i1], b = world.cards[j1];
        if (Math.hypot(a.x - b.x, a.y - b.y) < 120) { noOverlap = false; break; }
      }
    }
    var followed = level1ok && level2ok && spread > 350 && noOverlap;

    // Restore the whole board to its pre-check snapshot so later checks and
    // the persisted board see a deterministic layout.
    beforeAll.forEach(function (e) { e.c.x = e.x; e.c.y = e.y; });
    world.cards.forEach(function (c) { c.awake = true; c.still = 0; });
    world.tidy = false;
    card.vx = 0;
    card.vy = 0;
    var drag = {
      ok: !card.dragging && movedBy > 60 &&
        Math.abs(card.vx) < 0.5 && Math.abs(card.vy) < 0.5 &&
        heldStill && towedEnough && followed,
      moved: movedBy, vx: card.vx, vy: card.vy, dragging: card.dragging, branch: sub.length,
      heldStill: heldStill,
      towed: towedDuringDrag, towedEnough: towedEnough,
      followed: followed, level1ok: level1ok, level2ok: level2ok,
      spread: Math.round(spread), noOverlap: noOverlap
    };

    // 4. clamp: wheel all the way out then all the way in stays in range
    for (var i = 0; i < 30; i++) fire('wheel', vp, 640, 400, { deltaY: -120 });
    var maxScale = view.scale;
    for (var j = 0; j < 60; j++) fire('wheel', vp, 640, 400, { deltaY: 120 });
    var minScale = view.scale;
    var clamp = { ok: maxScale <= 2.5 + 1e-9 && minScale >= 0.2 - 1e-9, maxScale: maxScale, minScale: minScale };

    // 5. pinch (touch gesture, used by the web build): two fingers spread
    //    apart -> zoom in (clamped); the midpoint drag pans; lifting both
    //    fingers must leave a single-pointer pan fully working (no leftover
    //    pinch state, no stuck drag).
    var pinchStart = view.scale;
    fire('pointerdown', vp, 560, 400, { pointerId: 1 });
    fire('pointerdown', vp, 640, 400, { pointerId: 2 });
    fire('pointermove', vp, 400, 400, { pointerId: 1 });
    fire('pointermove', vp, 800, 400, { pointerId: 2 }); // dist 80 -> 320 = x4
    var pinchScale = view.scale;
    var pinchZoomOk = pinchScale > pinchStart + 0.2 && pinchScale <= 2.5 + 1e-9;
    var yBeforePan = view.y;
    fire('pointermove', vp, 400, 500, { pointerId: 1 });
    fire('pointermove', vp, 800, 500, { pointerId: 2 }); // midpoint +100px y
    var pinchPanDy = view.y - yBeforePan;
    fire('pointerup', vp, 400, 500, { pointerId: 1 });
    fire('pointerup', vp, 800, 500, { pointerId: 2 });
    var yBeforeSingle = view.y;
    fire('pointerdown', vp, 640, 400);
    fire('pointermove', vp, 640, 300);
    fire('pointerup', vp, 640, 300);
    var pinch = {
      ok: pinchZoomOk && Math.abs(pinchPanDy - 100) < 1 &&
        Math.abs(view.y - yBeforeSingle + 100) < 1,
      zoomFrom: pinchStart, zoomTo: pinchScale, panDy: pinchPanDy
    };

    return { pan: pan, zoom: zoom, drag: drag, clamp: clamp, pinch: pinch,
      ok: pan.ok && zoom.ok && drag.ok && clamp.ok && pinch.ok };
  };

  // ---- guidance check hook -----------------------------------------------------
  // The top-bar clutter now lives in one floating, blurred, modal "Guidance"
  // panel. Verify it opens, blurs the board, is a modal (has the backdrop and
  // the close affordance), and closes again.
  window.__cardwallGuidanceCheck = function () {
    var g = document.getElementById('guidance');
    var btn = document.getElementById('guidance-btn');
    var closeBtn = document.getElementById('guidance-close');
    var backdrop = g && g.querySelector('.guidance-backdrop');
    var opened = false, closed = false, blurred = false;
    if (btn) { btn.click(); opened = !!g && !g.hidden; }
    if (backdrop) {
      var cs = getComputedStyle(backdrop);
      var bf = cs.backdropFilter || cs.webkitBackdropFilter || '';
      blurred = /blur\(/.test(bf);
    }
    var hasHome = !!document.getElementById('home-btn');
    if (closeBtn) { closeBtn.click(); closed = !!g && g.hidden; }
    return {
      ok: opened && closed && blurred && !!backdrop && hasHome,
      opened: opened, closed: closed, blurred: blurred,
      hasBackdrop: !!backdrop, hasHome: hasHome
    };
  };

  // ---- editor check hook -------------------------------------------------------
  // Drives selection/edit/create/delete through real events. Mutates the world,
  // so smoke runs it last, after the screenshot.
  window.__cardwallEditorCheck = function () {
    var vp = viewport;

    function pointer(target, type, x, y) {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y
      }));
    }
    function dbl(target, x, y) {
      target.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, clientX: x, clientY: y
      }));
    }
    function key(target, k) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    }
    function cardCenter(el) {
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    // 1. double-click the root card -> edit mode, physics paused
    var rootEl = document.querySelector('.card');
    var rootId = rootEl.dataset.id;
    var rc = cardCenter(rootEl);
    pointer(rootEl, 'pointerdown', rc.x, rc.y);
    pointer(rootEl, 'pointerup', rc.x, rc.y);
    dbl(rootEl, rc.x, rc.y);
    var editStarted = editingId === rootId && worldPaused &&
      document.querySelectorAll('.card.editing').length === 1;

    // 2. typing + Enter commits the title and resumes the world
    var titleEl = rootEl.querySelector('.card-title');
    titleEl.textContent = '已编辑标题';
    key(titleEl, 'Enter');
    var committed = CardPhysics.findCard(world, rootId).title === '已编辑标题' &&
      editingId === null && !worldPaused &&
      document.querySelectorAll('.card.editing').length === 0;

    // 3. double-click just outside a card -> new card attached to the nearest node
    // (normalize the view first: earlier checks leave it zoomed/panned)
    var rootCard = CardPhysics.findCard(world, rootId);
    view.scale = 1;
    view.x = vp.clientWidth / 2 - rootCard.x;
    view.y = vp.clientHeight / 2 - rootCard.y;
    applyView();
    syncDOM();

    function emptyPointNear(el) {
      var r = el.getBoundingClientRect();
      var cands = [
        [r.left + r.width / 2, r.bottom + 55], // below: closest to the root centre
        [r.left + r.width / 2, r.top - 55],
        [r.right + 55, r.top + r.height / 2],
        [r.left - 55, r.top + r.height / 2]
      ];
      for (var i = 0; i < cands.length; i++) {
        var hit = document.elementFromPoint(cands[i][0], cands[i][1]);
        if (!hit || !hit.closest || !hit.closest('.card')) {
          return { x: cands[i][0], y: cands[i][1] };
        }
      }
      return null;
    }

    var before = world.cards.length;
    var cp = emptyPointNear(cardEls.get(rootId));
    var wp = { x: (cp.x - view.x) / view.scale, y: (cp.y - view.y) / view.scale };
    var expectParent = nearestCardId(wp, 320);
    dbl(vp, cp.x, cp.y);
    var newId = editingId;
    var created = world.cards.length === before + 1 && newId !== null &&
      expectParent !== null &&
      CardPhysics.findCard(world, newId).parent === expectParent;
    key(document.querySelector('.card.editing .card-title'), 'Escape'); // commit (empty -> 未命名)

    // 4. Delete removes the selected card, its element and its edge path
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    var deleted = world.cards.length === before && !cardEls.has(newId) && !edgeEls.has(newId);

    // 5. deleting a mid-tree card re-parents its children to the grandparent
    var n4el = cardEls.get('n4');
    var n4c = cardCenter(n4el);
    pointer(n4el, 'pointerdown', n4c.x, n4c.y);
    pointer(n4el, 'pointerup', n4c.x, n4c.y);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    var reparented = CardPhysics.findCard(world, 'n5').parent === 'root' &&
      !cardEls.has('n4') && !edgeEls.has('n4') && edgeEls.has('n5');

    // 6. dragging a card onto another card re-parents it
    var n3el = cardEls.get('n3');
    var n1el = cardEls.get('n1');
    var c3 = cardCenter(n3el);
    var c1 = cardCenter(n1el);
    pointer(n3el, 'pointerdown', c3.x, c3.y);
    pointer(n3el, 'pointermove', c1.x, c1.y);
    pointer(n3el, 'pointerup', c1.x, c1.y);
    var reparentByDrop = CardPhysics.findCard(world, 'n3').parent === 'n1';

    // 7. dropping a card onto its own descendant is refused (no cycles)
    var c3b = cardCenter(cardEls.get('n3'));
    pointer(n1el, 'pointerdown', c1.x, c1.y);
    pointer(n1el, 'pointermove', c3b.x, c3b.y);
    pointer(n1el, 'pointerup', c3b.x, c3b.y);
    var cycleBlocked = CardPhysics.findCard(world, 'n1').parent === 'root';

    return {
      ok: editStarted && committed && created && deleted && reparented &&
        reparentByDrop && cycleBlocked,
      editStarted: editStarted,
      committed: committed,
      created: created,
      deleted: deleted,
      reparented: reparented,
      reparentByDrop: reparentByDrop,
      cycleBlocked: cycleBlocked
    };
  };

  // ---- toolbar check hook --------------------------------------------------
  // Verifies the hover action bar (edit / add / delete) is present and each
  // button does what it claims. Runs on the sample root, which always
  // survives the editor check, and restores the card count it found.
  window.__cardwallToolbarCheck = function () {
    function click(el) {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    var rootEl = document.querySelector('.card[data-id="root"]') || document.querySelector('.card');
    if (!rootEl) return { ok: false, reason: 'no card' };
    var rootId = rootEl.dataset.id;
    var bar = rootEl.querySelector('.card-toolbar');
    // The bar carries the three action buttons plus the colour entry (the
    // palette itself is a hidden popover whose swatches only exist once
    // opened). Assert the ACTIONS, not a raw button count: the palette is
    // data-driven markup and its size is an implementation detail.
    var editBtn = bar ? bar.querySelector('[data-act="edit"]') : null;
    var addBtn = bar ? bar.querySelector('[data-act="add"]') : null;
    var delBtn = bar ? bar.querySelector('[data-act="del"]') : null;
    var colorBtn = bar ? bar.querySelector('.card-color-btn') : null;
    var hasBar = !!bar && !!editBtn && !!addBtn && !!delBtn && !!colorBtn;

    // edit button -> enters edit mode on the same card
    if (editingId) cancelEdit();
    click(editBtn);
    var editOk = editingId === rootId;
    cancelEdit();

    // add button -> creates a child of this card, opened in edit mode
    var idsBefore = world.cards.map(function (c) { return c.id; });
    click(addBtn);
    var newId = world.cards.map(function (c) { return c.id; })
      .filter(function (id) { return idsBefore.indexOf(id) < 0; })[0];
    var addOk = !!newId && CardPhysics.findCard(world, newId).parent === rootId;
    cancelEdit(); // createCard opened the new card for typing

    // delete button on the new child -> removes it, count returns
    var childEl = cardEls.get(newId);
    click(childEl.querySelector('.card-toolbar [data-act="del"]'));
    var delOk = !!childEl && world.cards.length === idsBefore.length &&
      !cardEls.has(newId) && !edgeEls.has(newId);

    // colour swatch -> applies a preset to the card (data attribute + model),
    // and the "no colour" swatch clears it again. The palette is opened
    // through the real delegated click path, exactly like a user would.
    // colour swatch -> applies a preset to the card (data attribute + model),
    // and the "no colour" swatch clears it again. The palette is opened
    // through the real delegated click path, exactly like a user would.
    // NOTE: this runs on rootEl, not the child above — that card was just
    // deleted (el.remove()), and a click on a detached node never bubbles
    // to the viewport's delegated listener.
    var colorOk = false;
    var rootColorBtn = rootEl.querySelector('.card-color-btn');
    if (rootColorBtn) {
      click(rootColorBtn);
      var palette = rootEl.querySelector('.card-palette');
      var paletteOpen = !!palette && !palette.hidden;
      var swatch = palette ? palette.querySelector('[data-color="rose"]') : null;
      if (paletteOpen && swatch) {
        click(swatch);
        var painted = CardPhysics.findCard(world, rootId);
        colorOk = !!painted && painted.color === 'rose' &&
          rootEl.dataset.color === 'rose' && palette.hidden;
      }
      // clear back to the default panel
      var noneBtn = rootEl.querySelector('.card-palette [data-color=""]');
      if (noneBtn) {
        click(rootColorBtn);
        click(noneBtn);
        var cleared = CardPhysics.findCard(world, rootId);
        colorOk = colorOk && !!cleared && cleared.color == null &&
          !('color' in rootEl.dataset);
      } else {
        colorOk = false;
      }
    }

    // 一键整洁: pressing it engages tidy AND gives immediate visual feedback
    // (the tidying pulse class + the transient "整理中…" label).
    var tidyBtnEl = document.getElementById('tidy-btn');
    if (tidyBtnEl) tidyBtnEl.click();
    var tidyFeedback = !!tidyBtnEl &&
      tidyBtnEl.classList.contains('tidying') &&
      tidyBtnEl.textContent === '整理中…' &&
      world.tidy === true;

    return {
      ok: hasBar && editOk && addOk && delOk && tidyFeedback && colorOk,
      hasBar: hasBar,
      editOk: editOk,
      addOk: addOk,
      delOk: delOk,
      colorOk: colorOk,
      tidyFeedback: tidyFeedback
    };
  };

  // ---- home check hook -----------------------------------------------------
  // Drives the real library: open it with the back button, create a board
  // through the same path the "新建" button uses, rename it, delete it. The
  // original board is left untouched, and the deleted board is not the current
  // one, so the reload check afterwards still finds the edited board.
  window.__cardwallHomeCheck = function () {
    var out = {};
    // Exercise the top-bar "返回首页" button (the one next to 一键整洁).
    var topHome = document.getElementById('home-top-btn');
    out.topHome = !!topHome;
    (topHome || homeBtn).click();
    out.visible = !homeEl.hidden;
    var before = 0;
    return renderHome() // the overlay renders asynchronously; wait for it
      .then(function (list) {
        out.cards = boardListEl.children.length;
        before = list.length;
        return createBoardWithName('smoke test');
      })
      .then(function (created) {
        out.created = !!created && created.name === 'smoke test';
        out.opened = currentBoard.name === 'smoke test' && !homeVisible();
        // A brand-new board must open with ONE blank, unnamed root card in the
        // middle (so the canvas is never an empty void).
        out.blankCard = world.cards.length === 1 &&
          world.cards[0].title === '' && world.cards[0].note === '' &&
          !world.cards[0].parent;
        return window.cardwall.listBoards();
      })
      .then(function (list) {
        out.listAfterCreate = list.length;
        var mine = list.filter(function (b) { return b.name === 'smoke test'; })[0];
        out.hasNew = !!mine;
        return mine ? window.cardwall.renameBoard(mine.id, 'smoke renamed') : null;
      })
      .then(function (r) {
        out.renamed = !!(r && r.ok && r.name === 'smoke renamed');
        return window.cardwall.listBoards();
      })
      .then(function (list) {
        var mine = list.filter(function (b) { return b.name === 'smoke renamed'; })[0];
        out.renameVisible = !!mine;
        return mine ? window.cardwall.deleteBoard(mine.id) : null;
      })
      .then(function (r) {
        out.deleted = !!(r && r.ok);
        return window.cardwall.listBoards();
      })
      .then(function (list) {
        out.listAfterDelete = list.length;
        out.ok = out.visible && out.topHome && out.cards >= 1 && out.created &&
          out.opened && out.blankCard && out.listAfterCreate === before + 1 &&
          out.hasNew && out.renamed && out.renameVisible && out.deleted &&
          out.listAfterDelete === before;
        return out;
      });
  };

  boot();
})();
