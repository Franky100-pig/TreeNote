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

  // ---- world setup -------------------------------------------------------
  var world = CardPhysics.createWorld({ seed: 7 });
  var cardEls = new Map(); // id -> HTMLElement
  var edgeEls = new Map(); // childId -> SVGPathElement

  function seedCards(list) {
    list.forEach(function (item) {
      CardPhysics.addCard(world, {
        id: item.id,
        x: item.x,
        y: item.y,
        parent: item.parent || null,
        title: item.title,
        note: item.note || ''
      });
    });
  }

  seedCards(window.SAMPLE_TREE); // first-run / no-bridge fallback

  // ---- DOM construction ----------------------------------------------------
  var zCounter = 100;

  function buildCardEl(card) {
    var el = document.createElement('div');
    el.className = 'card' + (card.parent ? '' : ' card-root');
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
      cards: world.cards.map(function (c) {
        return {
          id: c.id,
          title: c.title,
          note: c.note,
          x: c.x,
          y: c.y,
          parent: c.parent || null
        };
      })
    };
  }

  function flushSave(force) {
    if (!hasBridge() || saveState.inFlight || !saveState.dirty) return Promise.resolve(null);
    if (!force && performance.now() - saveState.lastChange < SAVE_DEBOUNCE_MS) {
      return Promise.resolve(null);
    }
    saveState.dirty = false;
    saveState.inFlight = true;
    saveState.pending = window.cardwall.saveBoard(serialize()).then(function (r) {
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

  // ---- boot --------------------------------------------------------------------
  // Boot is async: the board is loaded over IPC. The sample tree is already in
  // the world as a fallback and is replaced when a saved board arrives.
  function boot(board) {
    if (board && Array.isArray(board.cards) && board.cards.length) {
      world.cards.length = 0;
      seedCards(board.cards);
    }
    buildDOM();
    world.cards.forEach(measure);
    applyFit(90);
    syncDOM();
    requestAnimationFrame(frame);
    window.__cardwallReady = true;
  }

  (function bootAsync() {
    var bridge = window.cardwall;
    if (!bridge || typeof bridge.loadBoard !== 'function') {
      boot(null); // plain-browser fallback
      return;
    }
    bridge.loadBoard().then(boot, function () { boot(null); });
  })();

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
    var card = CardPhysics.addCard(world, {
      id: id,
      x: worldPoint.x,
      y: worldPoint.y,
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
  // (child of the selection, if any).
  viewport.addEventListener('dblclick', function (e) {
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
    if (editingId) return; // the editor owns the keyboard
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.preventDefault();
      deleteCard(selectedId);
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
    onCardPlaced: markDirty,
    onCardDropped: reparent,
    cardAt: cardAt,
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

    // 3. card drag: grab the first card, move +80px, release with velocity
    // Synthetic events land in the same task, so spin a few real milliseconds
    // between them — the release velocity needs a measurable dt (>5ms).
    function spin(ms) {
      var t0 = performance.now();
      while (performance.now() - t0 < ms) { /* busy wait: real clock time */ }
    }
    var cardEl = document.querySelector('.card');
    var card = CardPhysics.findCard(world, cardEl.dataset.id);
    var rect = cardEl.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var start = { x: card.x, y: card.y };
    fire('pointerdown', cardEl, cx, cy);
    spin(12);
    fire('pointermove', cardEl, cx + 40, cy);
    spin(12);
    fire('pointermove', cardEl, cx + 80, cy);
    spin(12);
    fire('pointerup', cardEl, cx + 80, cy);
    var drag = {
      ok: !card.dragging && card.x > start.x + 60 && card.vx > 0,
      moved: card.x - start.x, vx: card.vx, dragging: card.dragging
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
})();
