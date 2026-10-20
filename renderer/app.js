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

  window.SAMPLE_TREE.forEach(function (item) {
    CardPhysics.addCard(world, {
      id: item.id,
      x: item.x,
      y: item.y,
      parent: item.parent || null,
      title: item.title,
      note: item.note || ''
    });
  });

  // ---- DOM construction ----------------------------------------------------
  function buildDOM() {
    var frag = document.createDocumentFragment();
    world.cards.forEach(function (card) {
      var el = document.createElement('div');
      el.className = 'card' + (card.parent ? '' : ' card-root');
      el.dataset.id = card.id;
      var title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = card.title;
      var note = document.createElement('div');
      note.className = 'card-note';
      note.textContent = card.note;
      el.appendChild(title);
      el.appendChild(note);
      frag.appendChild(el);
      cardEls.set(card.id, el);
    });
    // One SVG path per tree edge; the SVG layer precedes the cards in DOM
    // order, so card bodies paint over the line ends.
    world.cards.forEach(function (card) {
      if (!card.parent) return;
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'edge');
      edgesEl.appendChild(path);
      edgeEls.set(card.id, path);
    });
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

  // One frame of work, extracted so headless smoke can drive it synchronously
  // (requestAnimationFrame does not reliably tick in a hidden window).
  function tick(dtMs) {
    var dtS = dtMs / 1000;
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
    stepTween(dtS);
    syncDOM();
  }

  function frame(now) {
    var elapsed = Math.min(now - last, 250);
    last = now;
    tick(elapsed);
    requestAnimationFrame(frame);
  }

  // ---- boot --------------------------------------------------------------------
  buildDOM();
  world.cards.forEach(function (c) {
    // Measure real rendered sizes once; edge endpoints use them.
    c.domW = cardEls.get(c.id).offsetWidth;
    c.domH = cardEls.get(c.id).offsetHeight;
  });
  applyFit(90);
  syncDOM();
  requestAnimationFrame(frame);

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

  // ---- interaction (C4) -------------------------------------------------------------
  window.CardInteraction.init({
    viewport: viewport,
    view: view,
    applyView: applyView,
    syncDOM: syncDOM,
    onUserInteract: onUserInteract,
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
    var cardEl = document.querySelector('.card');
    var card = CardPhysics.findCard(world, cardEl.dataset.id);
    var rect = cardEl.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var start = { x: card.x, y: card.y };
    fire('pointerdown', cardEl, cx, cy);
    fire('pointermove', cardEl, cx + 40, cy);
    fire('pointermove', cardEl, cx + 80, cy);
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
})();
