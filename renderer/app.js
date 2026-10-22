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
        pinned: item.pinned
      });
    });
  }

  // ---- DOM construction ----------------------------------------------------
  var zCounter = 100;

  function buildCardEl(card) {
    var el = document.createElement('div');
    el.className = 'card' + (card.parent ? '' : ' card-root') + (card.pinned ? ' pinned' : '');
    el.dataset.id = card.id;
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

    // Hover action bar: edit / add child / delete. Appears on hover (CSS)
    // and is the main way to act on a card without dragging it. The buttons
    // are handled by a delegated click listener on the viewport; this is
    // just the markup. `tabindex=-1` keeps them out of the tab order so the
    // card body stays the keyboard target while editing.
    var toolbar = document.createElement('div');
    toolbar.className = 'card-toolbar';
    toolbar.innerHTML =
      '<button data-act="edit" title="编辑 (或双击卡片)" tabindex="-1" aria-label="编辑">✎</button>' +
      '<button data-act="add" title="新建子节点" tabindex="-1" aria-label="新建子节点">＋</button>' +
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
          pinned: !!c.pinned
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
    }
    applyView();
  }

  function onUserInteract() {
    userInteracted = true;
    tween = null; // never fight the user for the camera
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

  function openBoardInto(board) {
    clearWorld();
    if (board && Array.isArray(board.cards)) seedCards(board.cards);
    // Restore the tidy flag: a board saved while tidy reopens as a clean tree;
    // one saved while free reopens exactly where the user left it. A fresh
    // board (no saved flag) opens as a tidy tree — the standard layout.
    world.tidy = !board || board.tidy === undefined ? true : !!board.tidy;
    buildDOM();
    world.cards.forEach(measure);
    applyFit(90);
    syncDOM();
    currentBoard = { id: board.id, name: board.name || '未命名' };
    boardNameEl.textContent = currentBoard.name;
    document.title = currentBoard.name + ' — cardwall';
    showHome(false);
    if (!loopStarted) {
      loopStarted = true;
      requestAnimationFrame(frame);
    }
  }

  function boot() {
    var bridge = window.cardwall;
    if (!bridge || typeof bridge.listBoards !== 'function') {
      // Plain-browser fallback (open index.html directly): no library.
      openBoardInto({ id: null, name: '示例', cards: window.SAMPLE_TREE });
      window.__cardwallReady = true;
      return;
    }
    bridge.listBoards().then(function (list) {
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
      window.__cardwallReady = true;
    }).catch(function (err) {
      console.error('[cardwall] boot failed:', err);
      openBoardInto({ id: null, name: '示例', cards: window.SAMPLE_TREE });
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
    card.className = 'home-card' + (board.id === currentBoard.id ? ' current' : '');
    card.setAttribute('role', 'listitem');
    card.dataset.id = board.id;

    var title = document.createElement('div');
    title.className = 'home-card-name';
    title.textContent = board.name;

    var meta = document.createElement('div');
    meta.className = 'home-card-meta';
    meta.textContent = board.cards + ' 张卡' + (board.savedAt ? ' · ' + relativeTime(board.savedAt) : '');

    var actions = document.createElement('div');
    actions.className = 'home-card-actions';
    var rename = document.createElement('button');
    rename.type = 'button';
    rename.dataset.act = 'rename';
    rename.textContent = '重命名';
    var del = document.createElement('button');
    del.type = 'button';
    del.dataset.act = 'delete';
    del.textContent = '删除';
    actions.appendChild(rename);
    actions.appendChild(del);

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(actions);

    // Clicking the body opens; the buttons are handled separately below.
    card.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (btn) {
        if (btn.dataset.act === 'rename') {
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

  function openBoardById(id) {
    if (!window.cardwall || typeof window.cardwall.openBoard !== 'function') return Promise.resolve(null);
    flushSave(true); // never lose the board we are leaving
    return window.cardwall.openBoard(id).then(function (board) {
      if (!board) return null;
      openBoardInto(board);
      return board;
    });
  }

  function createBoardWithName(name) {
    if (!window.cardwall || typeof window.cardwall.createBoard !== 'function') return Promise.resolve(null);
    return window.cardwall.createBoard(name).then(function (created) {
      if (!created) return null;
      return window.cardwall.openBoard(created.id).then(function (board) {
        openBoardInto(board || { id: created.id, name: created.name, cards: [] });
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
    return confirmDialog({
      title: '删除这幅图？',
      body: '文件会进废纸篓，可以从 Finder 里恢复。'
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
      note: '',
      pinned: false // joins the float / free placement
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

  // ---- pin semantics ----------------------------------------------------------------
  //
  // `pinned` means: this card was PLACED by the user and stays exactly where
  // it was put. A pinned card opts out of every force — including the rope —
  // so it neither drifts nor gets towed when its parent is dragged.
  //
  // That makes pinned a *protection* for cards the user has not touched, and
  // the rule is:
  //
  //   new card           -> pinned (it stays where you clicked)
  //   you drag a card    -> it and its whole subtree are UNPINNED for good
  //                         (you have taken it into the physics; it belongs
  //                          to the float now, and dragging its parent can
  //                          tow it along)
  //   P on a card        -> toggle it back, by hand, either way
  //
  // The subtree part matters: pinning is per card, but the rope is what
  // carries a drag to the rest of the tree. Leaving the children pinned would
  // mean "I can move this card but it drags nothing", which is exactly the
  // "一个节点带不动别的节点" complaint.
  function unpinSubtree(id) {
    var card = CardPhysics.findCard(world, id);
    if (!card) return;
    // descendantsOf returns card objects, not ids.
    var ids = [id].concat(descendantsOf(id).map(function (c) { return c.id; }));
    ids.forEach(function (cid) {
      var c = CardPhysics.findCard(world, cid);
      if (!c || !c.pinned) return;
      c.pinned = false;
      c.hover = false;          // the pointer is on it right now
      c.awake = true;           // don't wait for a force to wake it
      c.still = 0;
      var el = cardEls.get(cid);
      if (el) el.classList.remove('pinned');
    });
  }

  // Called when the user grabs a card: it rejoins the float, permanently, and
  // the physics re-lays the tree out around it (root drag -> whole tree
  // follows; child drag -> its subtree re-flows at the cursor).
  function onGrab(card) {
    if (!card) return;
    world.dragId = card.id;
    unpinSubtree(card.id);
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
  // the ONLY thing that imposes the tree on a free board (v0.6 model).
  function tidyAll() {
    CardPhysics.tidy(world);
    // wake every card so the spring actually moves it (dormant cards freeze).
    world.cards.forEach(function (c) { c.awake = true; c.still = 0; });
    markDirty();
    syncDOM();
  }

  // Pinned = free placement: no snap-back, no drift, no integration. Flipped
  // by `P` so a card can rejoin (or leave) the float by hand.
  function togglePin(id) {
    var card = CardPhysics.findCard(world, id);
    if (!card) return null;
    if (card.pinned) {
      // Rejoining the float: wake, don't wait for a force to exceed the
      // threshold. Clearing `hover` is essential — the pointer is resting on
      // the card exactly when you press P (that is how it got selected), and
      // the integrator freezes hovered cards so the toolbar stays clickable.
      // Without this the card stays welded in place until the mouse leaves,
      // which reads as "P does nothing".
      //
      // The subtree comes along: a card that rejoins the float but whose
      // children stay pinned is still a card that cannot be dragged around
      // by its parent.
      unpinSubtree(id);
      card.hover = false;
      wakeBranch(card.id);
    } else {
      card.pinned = true;
      card.vx = 0; card.vy = 0;
    }
    var el = cardEls.get(id);
    if (el) el.classList.toggle('pinned', card.pinned);
    markDirty();
    syncDOM();
    return card.pinned;
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

  // Selection on pointerdown; committing an open editor when clicking away.
  viewport.addEventListener('pointerdown', function (e) {
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
  // Dark is the default. Cmd/Ctrl+Shift+L flips to the paper theme and the
  // choice is remembered across launches (index.html applies it before the
  // first paint so a light board does not flash black on boot).
  var THEME_KEY = 'cardwall.theme';

  function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  function applyTheme(name) {
    if (name === 'light') {
      document.documentElement.dataset.theme = 'light';
    } else {
      delete document.documentElement.dataset.theme;
    }
    try {
      localStorage.setItem(THEME_KEY, name);
    } catch (err) { /* storage unavailable — the theme just won't persist */ }
  }

  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
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
    } else if ((e.key === 'p' || e.key === 'P') && selectedId) {
      e.preventDefault();
      togglePin(selectedId);
    } else if (e.key === 'Escape' && selectedId) {
      select(null);
    }
  });

  // Force a save and return its promise (smoke uses this for the disk check).
  window.__cardwallSaveNow = function () {
    markDirty();
    return flushSave(true);
  };

  // Theme round trip through the real key handler, so smoke exercises the
  // shortcut rather than a private function, and leaves the board on dark.
  window.__cardwallThemeCheck = function () {
    function probe() {
      var card = document.querySelector('.card');
      return {
        theme: currentTheme(),
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
    // Start from a known state: a previous session may have left the light
    // theme stored, which would otherwise make this check environment-dependent.
    applyTheme('dark');
    var start = probe();
    press();
    var flipped = probe();
    press();
    var back = probe();
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (err) { stored = null; }
    var BLACK = 'rgb(0, 0, 0)';
    return {
      ok: start.theme === 'dark' && start.bg === BLACK &&
        flipped.theme === 'light' && flipped.bg !== BLACK && flipped.cardBg === 'rgb(255, 255, 255)' &&
        back.theme === 'dark' && back.bg === BLACK &&
        stored === 'dark',
      start: start,
      flipped: flipped,
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

    // 3. card drag + one-click tidy (v0.6 model).
    //    Drag gives FULL FREEDOM: grab a card and its subtree follows the
    //    cursor, but on release nothing snaps back — the board stays where you
    //    let go. The tidy tree is rebuilt only by the "一键整洁" button.
    var cardEl = document.querySelector('.card');
    var card = CardPhysics.findCard(world, cardEl.dataset.id);
    var sub = descendantsOf(card.id);
    // Pin the whole tree first, the way a real board looks: the sample tree
    // starts unpinned, and an unpinned tree would pass this check even with
    // the unpins-subtree fix reverted. A pinned tree is the case that
    // actually broke ("one node does not carry the others").
    world.cards.forEach(function (c) {
      c.pinned = true;
      c.awake = true;
      c.still = 0;
    });
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
    // New pin semantics: grabbing a card hands it AND its whole subtree back
    // to the force field, permanently. This is the fix for "one node does not
    // carry the others": a pinned card opts out of every force, including the
    // tree pull, so a pinned subtree could never be towed.
    var subtreeUnpinned = sub.every(function (s) { return s.pinned === false; }) &&
      card.pinned === false;
    // The branch was actually TOWED: at least half of it travelled a real
    // distance while the card was held.
    var towed = towedDuringDrag.filter(function (t) { return t > 20; }).length;
    var towedEnough = towed >= Math.max(1, Math.ceil(sub.length / 2));

    // Release => FREE: onCardPlaced set world.tidy = false, so the board no
    // longer auto-tidies and the dropped card holds exactly where it landed.
    for (var s1 = 0; s1 < 300; s1++) CardPhysics.step(world);
    var heldStill = Math.hypot(card.vx, card.vy) < 1;

    // "一键整洁": re-tree the WHOLE board — the only thing that imposes the
    // tree on a free board. With everything unpinned and tidy engaged, the
    // spring pulls every card into the canonical tidy diagram.
    world.cards.forEach(function (c) { c.pinned = false; c.awake = true; c.still = 0; });
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

    // P works while the tree is held (tidy on): pin freezes, unpin re-floats.
    select(card.id);
    card.hover = true; // pointer resting on the card (what mouseenter would set)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true }));
    var pinNow = card.pinned;               // P pinned it
    var posAtPin = { x: card.x, y: card.y };
    for (var s3 = 0; s3 < 60; s3++) CardPhysics.step(world);
    var pinnedHolds = Math.hypot(card.x - posAtPin.x, card.y - posAtPin.y) < 1;
    // P again: back into the float, and it must start moving. Nudge it off
    // its equilibrium first — a card already at its tree target is in
    // balance, so releasing it there legitimately moves nothing.
    card.hover = true;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true }));
    var unpinnedNow = card.pinned === false;
    card.x += 60; card.y += 30; // off-balance, so the tidy pull has work to do
    var posAtRelease = { x: card.x, y: card.y };
    for (var s4 = 0; s4 < 60; s4++) CardPhysics.step(world);
    var floatsAgain = Math.hypot(card.x - posAtRelease.x, card.y - posAtRelease.y) > 1;

    // Restore the whole board to its pre-check snapshot so later checks and
    // the persisted board see a deterministic layout.
    beforeAll.forEach(function (e) { e.c.x = e.x; e.c.y = e.y; });
    world.cards.forEach(function (c) { c.pinned = true; c.awake = true; c.still = 0; });
    world.tidy = false;
    card.vx = 0;
    card.vy = 0;
    var unpinnedByDrag = subtreeUnpinned;
    var drag = {
      ok: !card.dragging && movedBy > 60 &&
        Math.abs(card.vx) < 0.5 && Math.abs(card.vy) < 0.5 &&
        heldStill && towedEnough && followed &&
        pinNow === true && pinnedHolds && unpinnedNow && floatsAgain &&
        unpinnedByDrag,
      moved: movedBy, vx: card.vx, vy: card.vy, dragging: card.dragging, branch: sub.length,
      pinned: card.pinned, heldStill: heldStill,
      towed: towedDuringDrag, towedEnough: towedEnough,
      followed: followed, level1ok: level1ok, level2ok: level2ok,
      spread: Math.round(spread), noOverlap: noOverlap,
      floatsAgain: floatsAgain, unpinnedByDrag: unpinnedByDrag, pinnedHolds: pinnedHolds
    };

    // 4. clamp: wheel all the way out then all the way in stays in range
    for (var i = 0; i < 30; i++) fire('wheel', vp, 640, 400, { deltaY: -120 });
    var maxScale = view.scale;
    for (var j = 0; j < 60; j++) fire('wheel', vp, 640, 400, { deltaY: 120 });
    var minScale = view.scale;
    var clamp = { ok: maxScale <= 2.5 + 1e-9 && minScale >= 0.2 - 1e-9, maxScale: maxScale, minScale: minScale };

    return { pan: pan, zoom: zoom, drag: drag, clamp: clamp, ok: pan.ok && zoom.ok && drag.ok && clamp.ok };
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
    var btns = bar ? bar.querySelectorAll('button') : [];
    var hasBar = !!bar && btns.length === 3;

    // edit button -> enters edit mode on the same card
    if (editingId) cancelEdit();
    click(bar.querySelector('[data-act="edit"]'));
    var editOk = editingId === rootId;
    cancelEdit();

    // add button -> creates a child of this card, opened in edit mode
    var idsBefore = world.cards.map(function (c) { return c.id; });
    click(bar.querySelector('[data-act="add"]'));
    var newId = world.cards.map(function (c) { return c.id; })
      .filter(function (id) { return idsBefore.indexOf(id) < 0; })[0];
    var addOk = !!newId && CardPhysics.findCard(world, newId).parent === rootId;
    cancelEdit(); // createCard opened the new card for typing

    // delete button on the new child -> removes it, count returns
    var childEl = cardEls.get(newId);
    click(childEl.querySelector('.card-toolbar [data-act="del"]'));
    var delOk = !!childEl && world.cards.length === idsBefore.length &&
      !cardEls.has(newId) && !edgeEls.has(newId);

    return {
      ok: hasBar && editOk && addOk && delOk,
      hasBar: hasBar,
      editOk: editOk,
      addOk: addOk,
      delOk: delOk
    };
  };

  // ---- home check hook -----------------------------------------------------
  // Drives the real library: open it with the back button, create a board
  // through the same path the "新建" button uses, rename it, delete it. The
  // original board is left untouched, and the deleted board is not the current
  // one, so the reload check afterwards still finds the edited board.
  window.__cardwallHomeCheck = function () {
    var out = {};
    homeBtn.click();
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
        out.ok = out.visible && out.cards >= 1 && out.created && out.opened &&
          out.listAfterCreate === before + 1 && out.hasNew && out.renamed &&
          out.renameVisible && out.deleted && out.listAfterDelete === before;
        return out;
      });
  };

  boot();
})();
