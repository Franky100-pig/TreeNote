/**
 * cardwall renderer bootstrap (C3 skeleton).
 *
 * DOM cards + SVG edges + fixed-step rAF loop driven by physics.js.
 * Architecture mirrors the Obsidian Canvas RE findings: a CSS-transformed
 * world container holding DOM cards and an SVG edge layer underneath.
 * Pan/zoom/drag input handlers arrive in C4; this file owns the world
 * container, the per-frame DOM sync, and edge geometry.
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
  // Pan/zoom plumbing only; wheel/drag handlers land in C4. Zoom anchor math
  // from the RE report: pan_new = pan_old + anchor/oldScale - anchor/newScale.
  var view = { x: 0, y: 0, scale: 1 };

  function applyView() {
    worldEl.style.transform =
      'translate(' + view.x.toFixed(2) + 'px, ' + view.y.toFixed(2) + 'px) scale(' + view.scale.toFixed(4) + ')';
  }

  function fitView() {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    world.cards.forEach(function (c) {
      var w = (c.domW || c.w) / 2, h = (c.domH || c.h) / 2;
      minX = Math.min(minX, c.x - w); maxX = Math.max(maxX, c.x + w);
      minY = Math.min(minY, c.y - h); maxY = Math.max(maxY, c.y + h);
    });
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    var pad = 90;
    var scale = Math.min((vw - pad * 2) / (maxX - minX), (vh - pad * 2) / (maxY - minY), 1.2);
    scale = Math.max(scale, 0.25);
    view.scale = scale;
    view.x = vw / 2 - (minX + maxX) / 2 * scale;
    view.y = vh / 2 - (minY + maxY) / 2 * scale;
    applyView();
  }

  // ---- main loop: fixed-step accumulator --------------------------------------
  // Physics runs at a fixed 1/60 step regardless of display refresh rate;
  // the DOM syncs once per animation frame. Backlog is clamped so a
  // backgrounded tab cannot trigger a catch-up spiral.
  var STEP_MS = 1000 / 60;
  var acc = 0;
  var last = performance.now();

  function frame(now) {
    var elapsed = Math.min(now - last, 250);
    last = now;
    acc += elapsed;
    var steps = 0;
    while (acc >= STEP_MS && steps < 5) {
      CardPhysics.step(world);
      acc -= STEP_MS;
      steps++;
    }
    if (steps >= 5) acc = 0;
    syncDOM();
    requestAnimationFrame(frame);
  }

  // ---- boot --------------------------------------------------------------------
  buildDOM();
  world.cards.forEach(function (c) {
    // Measure real rendered sizes once; edge endpoints use them.
    c.domW = cardEls.get(c.id).offsetWidth;
    c.domH = cardEls.get(c.id).offsetHeight;
  });
  fitView();
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
})();
