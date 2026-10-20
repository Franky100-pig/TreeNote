/**
 * cardwall interaction layer (C4): pan, zoom, card drag with inertia.
 *
 * - Pan: drag the empty viewport.
 * - Zoom: wheel, anchored at the cursor. With screen = scale*world + pan,
 *   keeping the world point under the cursor fixed requires
 *     pan' = pan*r + anchor*(1 - r),  r = newScale/oldScale
 *   (derived from a = s*w + pan; verified by the fixed-point check —
 *   the cursor's world coordinate is invariant across the zoom).
 * - Card drag: pointer capture; position written in world coordinates.
 *   Release velocity comes from a short sample window, after which the
 *   physics integrator carries the inertia and the snap spring pulls the
 *   card back to its ring anchor.
 *
 * Not in C4: pinch-zoom, shift axis lock, alt-duplicate, auto-pan near
 * edges (Obsidian behaviors noted in the RE report for later phases).
 */
(function () {
  'use strict';

  var SCALE_MIN = 0.2;
  var SCALE_MAX = 2.5;
  var VELOCITY_WINDOW_MS = 120; // release-velocity sampling window

  function init(opts) {
    var viewport = opts.viewport;
    var view = opts.view;
    var applyView = opts.applyView;
    var syncDOM = opts.syncDOM;
    var findCard = opts.findCard;
    var onUserInteract = opts.onUserInteract || function () {};
    var raise = opts.raise || function () {};

    var cardDrag = null; // { card, el, samples: [{x, y, t}] }
    var panDrag = null;  // { startX, startY, viewX, viewY }

    function screenToWorld(clientX, clientY) {
      var rect = viewport.getBoundingClientRect();
      return {
        x: (clientX - rect.left - view.x) / view.scale,
        y: (clientY - rect.top - view.y) / view.scale
      };
    }

    viewport.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return; // primary button only (C4)
      // Cards in edit mode own their pointer: text selection, not dragging.
      if (e.target.closest && e.target.closest('.card.editing')) return;
      onUserInteract(); // user takes over the camera
      try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      var cardEl = e.target.closest ? e.target.closest('.card') : null;
      if (cardEl) {
        var card = findCard(cardEl.dataset.id);
        if (!card) return;
        raise(cardEl); // raise to top of paint order
        cardEl.classList.add('dragging');
        card.dragging = true;
        var w = screenToWorld(e.clientX, e.clientY);
        cardDrag = { card: card, el: cardEl, samples: [{ x: w.x, y: w.y, t: performance.now() }] };
      } else {
        viewport.classList.add('panning');
        panDrag = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y };
      }
    });

    viewport.addEventListener('pointermove', function (e) {
      if (cardDrag) {
        var w = screenToWorld(e.clientX, e.clientY);
        var now = performance.now();
        cardDrag.card.x = w.x;
        cardDrag.card.y = w.y;
        cardDrag.samples.push({ x: w.x, y: w.y, t: now });
        while (cardDrag.samples.length > 2 && now - cardDrag.samples[0].t > VELOCITY_WINDOW_MS) {
          cardDrag.samples.shift();
        }
        syncDOM();
      } else if (panDrag) {
        view.x = panDrag.viewX + (e.clientX - panDrag.startX);
        view.y = panDrag.viewY + (e.clientY - panDrag.startY);
        applyView();
      }
    });

    function endPointer() {
      if (cardDrag) {
        var card = cardDrag.card;
        var s = cardDrag.samples;
        if (s.length >= 2) {
          var a = s[0], b = s[s.length - 1];
          var dt = (b.t - a.t) / 1000;
          if (dt > 0.005) {
            card.vx = (b.x - a.x) / dt;
            card.vy = (b.y - a.y) / dt;
          }
        }
        card.dragging = false;
        cardDrag.el.classList.remove('dragging');
        cardDrag = null;
      }
      if (panDrag) {
        viewport.classList.remove('panning');
        panDrag = null;
      }
    }
    viewport.addEventListener('pointerup', endPointer);
    viewport.addEventListener('pointercancel', endPointer);

    viewport.addEventListener('wheel', function (e) {
      e.preventDefault();
      onUserInteract(); // user takes over the camera
      var rect = viewport.getBoundingClientRect();
      var ax = e.clientX - rect.left;
      var ay = e.clientY - rect.top;
      var oldScale = view.scale;
      var factor = Math.pow(2, -e.deltaY / 500); // ~1.19x per notch
      var newScale = Math.min(Math.max(oldScale * factor, SCALE_MIN), SCALE_MAX);
      if (newScale === oldScale) return;
      var r = newScale / oldScale;
      view.scale = newScale;
      view.x = view.x * r + ax * (1 - r);
      view.y = view.y * r + ay * (1 - r);
      applyView();
    }, { passive: false });
  }

  window.CardInteraction = { init: init };
})();
