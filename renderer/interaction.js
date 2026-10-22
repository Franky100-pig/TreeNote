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
 *   Grabbing a card holds it exactly where you let go — no release inertia,
 *   no spring pulling it home. Obsidian behaves this way and it is what
 *   "free placement" means: the auto-layout may suggest a spot, but once you
 *   touch a card the spot is yours (only 一键整洁 re-imposes the tree).
 *   Only the grabbed card follows the pointer. Everything else — the
 *   branch included — is left to the physics: springs and repulsion drag
 *   them along, so the rest of the wall floats behind the one in your hand
 *   instead of snapping rigidly with it. Freezing the whole branch would
 *   make the board feel like a solid slab; letting the forces do the work is
 *   the "拖动的时候其他一起漂浮" behaviour.
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
    var onGrab = opts.onGrab || function () {};
    var raise = opts.raise || function () {};

    var cardDrag = null; // { card, el, grab: {x, y} }
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
      // The hover toolbar's buttons must also decline to drag/pan — they
      // have their own click handler.
      if (e.target.closest && e.target.closest('.card.editing, .card-toolbar')) return;
      onUserInteract(); // user takes over the camera
      try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      var cardEl = e.target.closest ? e.target.closest('.card') : null;
      if (cardEl) {
        var card = findCard(cardEl.dataset.id);
        if (!card) return;
        raise(cardEl); // raise to top of paint order
        cardEl.classList.add('dragging');
        card.dragging = true;
        card.vx = 0;
        card.vy = 0;
        // Wake the branch so it starts floating right away instead of
        // sitting frozen until the force grows past the sleep threshold. From
        // here the grabbed card (and its subtree) is what the physics moves;
        // see `onGrab` in app.js.
        onGrab(card);
        // Grab offset: the card keeps the exact point you grabbed it by, so
        // it does not jump its centre to the cursor (Obsidian behaviour).
        var w0 = screenToWorld(e.clientX, e.clientY);
        cardDrag = {
          card: card,
          el: cardEl,
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
        // The grabbed card tracks the pointer exactly; everything else is
        // moved by the physics on the next tick.
        cardDrag.card.x = w.x + cardDrag.grab.x;
        cardDrag.card.y = w.y + cardDrag.grab.y;
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
