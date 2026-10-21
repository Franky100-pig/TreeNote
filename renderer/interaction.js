/**
 * cardwall interaction layer: pan, zoom, card drag.
 *
 * - Pan: drag the empty viewport.
 * - Zoom: wheel, anchored at the cursor. With screen = scale*world + pan,
 *   keeping the world point under the cursor fixed requires
 *     pan' = pan*r + anchor*(1 - r),  r = newScale/oldScale
 *   (derived from a = s*w + pan; verified by the fixed-point check —
 *   the cursor's world coordinate is invariant across the zoom).
 * - Card drag: pointer capture; position written in world coordinates.
 *   Grabbing a card pins it, so the drop lands exactly where you let go —
 *   no release inertia, no spring pulling it home. Obsidian behaves this
 *   way and it is what "free placement" means: the auto-layout may suggest
 *   a spot, but once you touch a card the spot is yours. `P` unpins.
 *
 * Not implemented: pinch-zoom, shift axis lock, alt-duplicate, auto-pan near
 * edges (Obsidian behaviors noted in the RE report for later phases).
 */
(function () {
  'use strict';

  var SCALE_MIN = 0.2;
  var SCALE_MAX = 2.5;

  function init(opts) {
    var viewport = opts.viewport;
    var view = opts.view;
    var applyView = opts.applyView;
    var syncDOM = opts.syncDOM;
    var findCard = opts.findCard;
    var onUserInteract = opts.onUserInteract || function () {};
    var onCardPlaced = opts.onCardPlaced || function () {};
    var onCardDropped = opts.onCardDropped || function () {};
    var raise = opts.raise || function () {};

    var cardDrag = null; // { card, el, sub: [descendants], grab: {x, y} }
    var panDrag = null;  // { startX, startY, viewX, viewY }

    function screenToWorld(clientX, clientY) {
      var rect = viewport.getBoundingClientRect();
      return {
        x: (clientX - rect.left - view.x) / view.scale,
        y: (clientY - rect.top - view.y) / view.scale
      };
    }

    viewport.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return; // primary button only
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
        // Pin on grab: the card stops drifting the instant you touch it and
        // keeps whatever position the drop lands on.
        card.pinned = true;
        card.vx = 0;
        card.vy = 0;
        // Grab offset: the card keeps the exact point you grabbed it by, so
        // it does not jump its centre to the cursor (Obsidian behaviour).
        var w0 = screenToWorld(e.clientX, e.clientY);
        cardDrag = {
          card: card,
          el: cardEl,
          sub: opts.descendants ? opts.descendants(card.id) : [],
          grab: { x: card.x - w0.x, y: card.y - w0.y }
        };
      } else {
        viewport.classList.add('panning');
        panDrag = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y };
      }
    });

    viewport.addEventListener('pointermove', function (e) {
      if (cardDrag) {
        var w = screenToWorld(e.clientX, e.clientY);
        var nx = w.x + cardDrag.grab.x;
        var ny = w.y + cardDrag.grab.y;
        var dx = nx - cardDrag.card.x;
        var dy = ny - cardDrag.card.y;
        cardDrag.card.x = nx;
        cardDrag.card.y = ny;
        // Move the subtree rigidly rather than letting the springs drag it
        // along behind: the branch stays exactly as you arranged it, and
        // since every child anchor is parent + fixed offset, translating both
        // by the same delta leaves zero residual force at release.
        for (var i = 0; i < cardDrag.sub.length; i++) {
          cardDrag.sub[i].x += dx;
          cardDrag.sub[i].y += dy;
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
        card.dragging = false;
        card.vx = 0;
        card.vy = 0;
        cardDrag.el.classList.remove('dragging');
        onCardPlaced(card); // the card's new position is worth persisting
        // Dropping a card's centre inside another card re-parents it.
        var target = opts.cardAt ? opts.cardAt(card.x, card.y, card.id) : null;
        if (target) onCardDropped(card, target);
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
