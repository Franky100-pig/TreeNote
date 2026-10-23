/**
 * cardwall physics core — tidy-tree layout + critically damped pull.
 *
 * Pure logic, zero dependencies: UMD-wrapped so the same module runs in
 * Node (unit tests) and the browser (renderer).
 *
 * Model (v0.6 — free placement + one-click tidy):
 *
 *   The board is a HIERARCHY. Every card has a deterministic TREE TARGET from
 *   a tidy-tree layout (Reingold–Tilford style: same depth shares a level, a
 *   parent centres over its children, subtrees never overlap). BUT the pull
 *   toward that target is OPTIONAL, gated by `world.tidy`:
 *
 *     • world.tidy === false (the DEFAULT): cards are FREE. Each node holds
 *       wherever it is — you can drag any node anywhere and it stays there.
 *       This is the "给足自由度" interaction the user asked for.
 *     • world.tidy === true: every card is pulled to its tree
 *       target by a CRITICALLY DAMPED spring (k=40, no overshoot), so the
 *       board eases into a clean diagram. This is engaged ONLY by the
 *       "一键整洁" button (physics.tidy) — or on board load.
 *
 *   So dragging is always free: the dragged card (and its subtree, which
 *   follows the cursor) stays where you let go; nothing snaps back. Pressing
 *   tidy re-flows the WHOLE board into the standard tree. Drop = freedom,
 *   tidy = reset. That is the whole interaction model.
 *
 *   Drag-time behaviour (while a card IS being dragged, tidy or not):
 *     • drag the ROOT  -> the whole tree re-anchors on the root, so every
 *       child follows the one card in your hand.
 *     • drag a CHILD   -> that subtree re-flows under your cursor, and the
 *       rest of the tree leans only slightly toward your hand (the root
 *       drifts `childLean` of the way, not all the way).
 *
 *   There is no "pin" anymore: every card belongs to the float and obeys the
 *   same rules. The tidy pull is the only thing that arranges them, and it is
 *   opt-in (world.tidy), so a free card simply holds where the user dropped it
 *   until tidy is engaged.
 *
 * Integration: fixed-step semi-implicit Euler; a card being dragged is
 * positioned externally and its velocity is recorded by the caller. Dormancy
 * ("the board holds still") is kept: a quiet card falls asleep and freezes
 * until a neighbour's force wakes it.
 *
 * Reference (Obsidian Canvas RE): Obsidian Canvas has no auto-layout at all —
 * this tidy-tree model is cardwall's answer to "I want to SEE the hierarchy".
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardPhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONFIG = {
    dt: 1 / 60,            // fixed step (seconds)

    // ---- tree target pull ---------------------------------------------------
    // Critically damped spring toward the tree target. omega = sqrt(k) ~6.3,
    // critical damping coefficient = 2*sqrt(k) -> eases to target in ~0.6s,
    // no overshoot. This is the core "arrange into a tree" behaviour.
    k: 40,                 // spring stiffness to the tree target (px/s^2 per px)
    // Global viscous decay (air drag) applied to EVERY free-moving card each
    // step, independent of the spring. The spring's own damping term is gated
    // inside the tidy/drag pull loop, so on a FREE board (no pull) a card that
    // was released with residual velocity would otherwise coast forever — the
    // "node stops but everything else keeps drifting" bug. Air drag always
    // acts, so residual velocity always decays and the card can fall asleep.
    globalDamp: 3.0,       // 1/s: velocity halves every ~0.23s; settled within ~1s
    maxSpeed: 3000,        // velocity cap (px/s)

    // Tidy-tree geometry (Reingold–Tilford style, leaf-packing variant).
    nodeGap: 300,          // horizontal spacing between sibling LEAVES (>= card
                           // width 250 + breathing room, so leaves never overlap)
    levelGap: 220,         // vertical spacing between depth levels (parent above)
    rootGap: 360,          // gap between separate root trees (forest case)

    // When a CHILD is dragged, the rest of the tree leans toward the hand by
    // this fraction. 0.12 -> the root drifts ~12% of the way, never all the
    // way, so "moving a child barely moves the root".
    childLean: 0.12,

    // ---- soft anti-overlap guard -------------------------------------------
    // The tidy layout already prevents overlap at rest, but a dragged card can
    // be dropped onto a neighbour. This gentle repulsion keeps neighbours apart
    // without turning the board back into a floating cloud.
    repulsion: 22000,      // a = repulsion / d (px/s^2)
    repulsionCutoff: 520,  // repulsion cutoff (px)

    // Drag wake: the card in your hand pushes its neighbours a little, distance
    // attenuated, in its own travel direction — so unrelated cards still drift
    // aside as you drag, but the real "follow" comes from the tree re-flow.
    wakeRadius: 520,
    wakeStrength: 0.4,

    driftImpulse: 3,       // Brownian impulse magnitude (px/s) — a faint life
    driftChance: 0.0002,   // per-step probability of a drift impulse

    sleepSpeed: 0.6,       // px/s: below this a card counts as momentarily still
    sleepForce: 30,        // px/s^2: net force small enough to be "at rest"
    sleepSteps: 60,        // consecutive quiet steps (~1s) before a card sleeps

    cardWidth: 250,        // default card width (matches Obsidian text cards)
    cardHeight: 60         // default card height
  };

  function lerp(a, b, t) { return a + (b - a) * t; }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createWorld(options) {
    options = options || {};
    return {
      cards: [],
      time: 0,
      rng: mulberry32(options.seed == null ? 1 : options.seed),
      drift: options.drift == null ? true : options.drift,
      dragId: null,                       // id of the card currently dragged (or null)
      rootHome: { x: 0, y: 0 },           // resting anchor of the primary root (used only while tidy)
      _rootHomeInit: false,               // set after rootHome is first parked
      tidy: false,                        // false = FREE placement (default); true = pull to tree
      _roots: [],                         // tree roots (parent === null), filled by layout
      config: Object.assign({}, CONFIG, options.config || {})
    };
  }

  function findCard(world, id) {
    for (var i = 0; i < world.cards.length; i++) {
      if (world.cards[i].id === id) return world.cards[i];
    }
    return null;
  }

  function addCard(world, card) {
    card.vx = card.vx || 0;
    card.vy = card.vy || 0;
    card.w = card.w || world.config.cardWidth;
    card.h = card.h || world.config.cardHeight;
    card.dragging = false;
    card.awake = card.awake === undefined ? true : !!card.awake;
    card.still = 0;              // consecutive quiet steps (see dormancy)
    card.fx = 0;
    card.fy = 0;
    card._ox = card._ox || 0;    // tidy-layout offset (relative to the primary root)
    card._oy = card._oy || 0;
    card.tx = card.tx || 0;      // last computed tree target (for the debug overlay)
    card.ty = card.ty || 0;
    world.cards.push(card);
    return card;
  }

  function removeCard(world, id) {
    var i = world.cards.findIndex(function (c) { return c.id === id; });
    if (i >= 0) world.cards.splice(i, 1);
  }

  /**
   * Tidy-tree layout. Fills card._ox / card._oy (layout coordinates; the
   * primary root ends up at (0, 0)) and world._roots.
   *
   * Algorithm: post-order leaf-packing (a simple, robust tidy-tree variant).
   *   • Leaves are placed left-to-right `nodeGap` apart by a shared cursor.
   *   • An internal node sits at the midpoint of its outermost children, so a
   *     parent is centred over its children.
   *   • Depth sets the vertical level (y = depth * levelGap).
   *   • Each child list is sorted by current x then id, so the drawing is
   *     deterministic and stable across runs.
   *   • Multiple roots are laid out in a row with `rootGap` between them, then
   *     the whole layout is shifted so the primary root lands at x = 0.
   *
   * The offsets are ADDITIVE (relative to the primary root), which is exactly
   * what the pull step needs: a card's target is `base + (card._ox, card._oy)`
   * where `base` is the primary root's current position (root drag) or the
   * lean point (child drag).
   */
  function computeTreeLayout(world) {
    var cfg = world.config;
    var byParent = new Map();
    var roots = [];
    world.cards.forEach(function (c) {
      if (c.parent && findCard(world, c.parent)) {
        if (!byParent.has(c.parent)) byParent.set(c.parent, []);
        byParent.get(c.parent).push(c);
      } else {
        roots.push(c);
      }
    });
    // Deterministic child order. IMPORTANT: order only by id, NEVER by the
    // card's current x. If the order depended on live positions, dragging a
    // node far would flip the packing order, change every node's offset (_ox),
    // and feed back into the next layout. Ordering by id makes the layout a
    // pure function of tree structure, which is what physics.tidy() relies on
    // to re-flow the board into a clean diagram on demand.
    byParent.forEach(function (kids) {
      kids.sort(function (a, b) {
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });
    });

    var cursorX = 0;
    function layout(node, depth) {
      node._oy = depth * cfg.levelGap;
      var kids = byParent.get(node.id) || [];
      if (!kids.length) {
        node._ox = cursorX;
        cursorX += cfg.nodeGap;
      } else {
        for (var i = 0; i < kids.length; i++) layout(kids[i], depth + 1);
        node._ox = (kids[0]._ox + kids[kids.length - 1]._ox) / 2;
      }
    }
    for (var r = 0; r < roots.length; r++) {
      layout(roots[r], 0);
      cursorX += cfg.rootGap; // gap before the next root tree
    }
    // Shift everything so the primary root sits at x = 0 (the lean / base math
    // assumes the primary root's offset is zero).
    if (roots.length) {
      var shift = -roots[0]._ox;
      world.cards.forEach(function (c) { c._ox += shift; });
    }
    world._roots = roots;
    return roots;
  }

  /**
   * Is `cardId` a STRICT descendant of `ancestorId`? (used so a dragged
   * card's subtree re-anchors on the cursor instead of the tree root).
   */
  function isDescendant(world, cardId, ancestorId) {
    if (cardId === ancestorId) return false;
    var cur = findCard(world, cardId);
    var guard = 0;
    while (cur && guard++ < 4000) {
      if (cur.parent === ancestorId) return true;
      if (!cur.parent) return false;
      cur = findCard(world, cur.parent);
    }
    return false;
  }

  /**
   * Walk up to the tree root. A card's target is laid out relative to this
   * anchor (or relative to the dragged card, handled in targetOf).
   */
  function nearestAnchorRoot(world, card) {
    // (Pin was removed: there is no per-card anchor, so a card's target is laid
    // out relative to the tree root, or the dragged card, handled in targetOf.)
    var cur = card;
    var guard = 0;
    while (cur && guard++ < 4000) {
      if (!cur.parent) return cur; // tree root
      var p = findCard(world, cur.parent);
      if (!p) return cur;
      cur = p;
    }
    return card;
  }

  /** Compute the tree target for a card given the current drag/anchor state. */
  function targetOf(world, c, dragged, anchor) {
    // A card that is a strict descendant of the dragged card re-anchors on the
    // dragged card, so grabbing a child makes its whole subtree follow the
    // cursor as a tidy unit (its own tidy offsets, just shifted to the hand).
    if (dragged && isDescendant(world, c.id, dragged.id)) {
      return {
        x: dragged.x + (c._ox - dragged._ox),
        y: dragged.y + (c._oy - dragged._oy)
      };
    }
    var subroot = nearestAnchorRoot(world, c);
    var baseX, baseY;
    if (subroot === dragged) { baseX = dragged.x; baseY = dragged.y; }
    else { baseX = anchor.x + (subroot._ox || 0); baseY = anchor.y + (subroot._oy || 0); }
    return {
      x: baseX + (c._ox - (subroot._ox || 0)),
      y: baseY + (c._oy - (subroot._oy || 0))
    };
  }

  function step(world, dt) {
    dt = dt || world.config.dt;
    var cfg = world.config;
    var cards = world.cards;
    var n = cards.length;
    world.time += dt;

    computeTreeLayout(world);

    var dragged = world.dragId ? findCard(world, world.dragId) : null;

    // Park the primary root's resting anchor ONCE, on the first tidy step.
    // This is only relevant while world.tidy is engaged. When the board is
    // free (tidy === false) there is no pull, so rootHome is irrelevant and we
    // leave it alone. The anchor is a FIXED point thereafter: physics.tidy()
    // is the only thing that may move it (it re-anchors on the root's current
    // position so the tree reconstructs in place, not at the origin).
    var primaryRoot = world._roots && world._roots[0];
    if (world.tidy && !dragged && primaryRoot && !world._rootHomeInit) {
      world.rootHome = { x: primaryRoot.x, y: primaryRoot.y };
      world._rootHomeInit = true;
    }

    // Base point for non-dragged roots.
    var anchor;
    if (dragged && !dragged.parent) {
      anchor = { x: dragged.x, y: dragged.y };                       // drag root -> whole tree follows
    } else if (dragged) {
      anchor = {                                                      // drag child -> lean slightly
        x: lerp(world.rootHome.x, dragged.x, cfg.childLean),
        y: lerp(world.rootHome.y, dragged.y, cfg.childLean)
      };
    } else {
      anchor = world.rootHome;
    }

    // 1. zero forces (and clear the per-card "is this card being pulled by the
    //    spring this step" flag, set again in section 3 if so).
    for (var i = 0; i < n; i++) { cards[i].fx = 0; cards[i].fy = 0; cards[i]._inPull = false; }

    // 2. soft repulsion — an anti-overlap GUARD that only matters while a card
    //    is being dragged (a dragged card can be shoved into a neighbour). At
    //    rest the tidy layout already guarantees no overlap, so applying this
    //    at rest would (a) keep every card awake forever and (b) perturb the
    //    clean diagram. Hence: skip any pair that isn't currently being dragged.
    var cutoff2 = cfg.repulsionCutoff * cfg.repulsionCutoff;
    for (var a = 0; a < n; a++) {
      for (var b = a + 1; b < n; b++) {
        if (!cards[a].dragging && !cards[b].dragging) continue;
        var dx = cards[b].x - cards[a].x;
        var dy = cards[b].y - cards[a].y;
        var d2 = dx * dx + dy * dy;
        if (d2 > cutoff2 || d2 < 1e-6) continue;
        var d = Math.sqrt(d2);
        var f = cfg.repulsion / d;
        var ux = dx / d, uy = dy / d;
        cards[a].fx -= ux * f; cards[a].fy -= uy * f;
        cards[b].fx += ux * f; cards[b].fy += uy * f;
      }
    }

    // 3. tree-target pull — the "arrange into a tree" force. Critically damped.
    // Engaged in two situations:
    //   • tidy mode (no drag): every card eases into the full tree.
    //   • a card is being dragged on a FREE board (tidy === false): only the
    //     grabbed card's subtree is pulled to follow the cursor — the rest of
    //     the board holds exactly where the user left it (full freedom for
    //     everything else). This is the v0.6 "give the user freedom while
    //     dragging" contract: grab a branch and the branch moves; release and
    //     the whole board becomes free and stays where it was dropped.
    // On drag RELEASE tidy is flipped off (see app.onCardPlaced), so nothing
    // snaps back to the tree — the board simply holds where it was dropped.
    if (world.tidy || dragged) {
      var cDamp = 2 * Math.sqrt(cfg.k);
      for (var p = 0; p < n; p++) {
        var card = cards[p];
        if (card.dragging) continue; // positioned externally while grabbed
        // Free board + dragging: move only the grabbed branch; leave the rest.
        if (!world.tidy && dragged && !isDescendant(world, card.id, dragged.id)) continue;
        var t = targetOf(world, card, dragged, anchor);
        card.tx = t.x; card.ty = t.y;
        // Damped harmonic oscillator, mass = 1: a = k*(target - x) - cDamp*v
        card.fx += cfg.k * (t.x - card.x) - cDamp * card.vx;
        card.fy += cfg.k * (t.y - card.y) - cDamp * card.vy;
        card._inPull = true; // this card is damped by the spring term above
      }
    }

    // 4. drag wake — a moving card carries its neighbours a little. Pure push,
    //    distance-attenuated, in the grabbed card's travel direction.
    for (var dg = 0; dg < n; dg++) {
      var dcard = cards[dg];
      if (!dcard.dragging) continue;
      var dvx = (dcard.x - (dcard._px != null ? dcard._px : dcard.x)) / dt;
      var dvy = (dcard.y - (dcard._py != null ? dcard._py : dcard.y)) / dt;
      var dsp2 = dvx * dvx + dvy * dvy;
      if (dsp2 > 1) {
        for (var o = 0; o < n; o++) {
          var other = cards[o];
          if (other.dragging) continue;
          var ox = other.x - dcard.x, oy = other.y - dcard.y;
          var od = Math.sqrt(ox * ox + oy * oy) || 1e-6;
          if (od > cfg.wakeRadius) continue;
          var fall = 1 - od / cfg.wakeRadius;
          other.fx += dvx * cfg.wakeStrength * fall;
          other.fy += dvy * cfg.wakeStrength * fall;
        }
      }
      dcard._px = dcard.x;
      dcard._py = dcard.y;
    }

    // 5. seeded Brownian drift (a faint, reproducible life) — only while the
    //    board is in tidy mode. A FREE board (tidy === false) must hold exactly
    //    where the user placed it, so there is no drift and no scatter.
    if (world.drift && world.tidy) {
      for (var g = 0; g < n; g++) {
        if (cards[g].dragging) continue;
        if (world.rng() < cfg.driftChance) {
          cards[g].vx += (world.rng() * 2 - 1) * cfg.driftImpulse;
          cards[g].vy += (world.rng() * 2 - 1) * cfg.driftImpulse;
          if (!cards[g].awake) { cards[g].awake = true; cards[g].still = 0; }
        }
      }
    }

    // 6. wake test: a sleeping card stays frozen until something pulls on it.
    for (var w = 0; w < n; w++) {
      var wc = cards[w];
      if (wc.dragging || wc.hover) { wc.awake = true; wc.still = 0; continue; }
      if (!wc.awake && (wc.fx * wc.fx + wc.fy * wc.fy) > cfg.sleepForce * cfg.sleepForce) {
        wc.awake = true;
        wc.still = 0;
      }
    }

    // 7. integrate (dragged, hovered and sleeping cards are positioned
    //    externally or intentionally still). A card that the spring is pulling
    //    (section 3) is already damped by the `- cDamp*v` term in that force,
    //    so we leave it be. Every OTHER free-moving card gets a global viscous
    //    decay so any residual velocity (from a just-released drag, a drag wake,
    //    or repulsion) bleeds off instead of coasting forever on a free board.
    var decay = Math.exp(-cfg.globalDamp * dt);
    for (var k = 0; k < n; k++) {
      var q = cards[k];
      if (q.dragging || q.hover || !q.awake) { q.vx = 0; q.vy = 0; continue; }
      q.vx += q.fx * dt;
      q.vy += q.fy * dt;
      if (!q._inPull) { q.vx *= decay; q.vy *= decay; }
      var sp = Math.sqrt(q.vx * q.vx + q.vy * q.vy);
      if (sp > cfg.maxSpeed) {
        q.vx = q.vx / sp * cfg.maxSpeed;
        q.vy = q.vy / sp * cfg.maxSpeed;
      }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }

    // 8. dormancy: quiet for sleepSteps in a row and the card stops integrating.
    for (var s = 0; s < n; s++) {
      var sc = cards[s];
      if (sc.dragging || sc.hover || !sc.awake) continue;
      var v2 = sc.vx * sc.vx + sc.vy * sc.vy;
      var f2 = sc.fx * sc.fx + sc.fy * sc.fy;
      if (v2 < cfg.sleepSpeed * cfg.sleepSpeed && f2 < cfg.sleepForce * cfg.sleepForce) {
        sc.still++;
        if (sc.still >= cfg.sleepSteps) {
          sc.awake = false;
          sc.vx = 0;
          sc.vy = 0;
        }
      } else {
        sc.still = 0;
      }
    }
  }

  /** Wake a card so it rejoins the float (used when it is disturbed on purpose). */
  function wake(card) {
    if (!card) return;
    card.awake = true;
    card.still = 0;
  }

  /**
   * One-click tidy: re-flow the ENTIRE board into the standard tidy tree.
   *
   * Recomputes the layout, anchors the tree at the primary root's CURRENT
   * position (so the tree reconstructs IN PLACE rather than jumping to the
   * origin), and engages the spring pull so every card eases into its
   * canonical slot. This is the "一键整洁" button — it is the ONLY thing that
   * imposes the tree. By default (world.tidy === false) cards are free and
   * hold wherever they are; releasing a drag flips tidy off (see
   * app.onCardPlaced), so the tree is rebuilt only on demand.
   */
  function tidy(world) {
    computeTreeLayout(world);
    var primaryRoot = world._roots && world._roots[0];
    if (primaryRoot) {
      world.rootHome = { x: primaryRoot.x, y: primaryRoot.y };
    }
    world._rootHomeInit = true;
    world.tidy = true;
  }

  /**
   * Total mechanical energy (KE + spring PE toward target + repulsion PE).
   * Used by the "damping dissipates energy" invariant test and the debug
   * overlay. Targets are recomputed first (they depend on position), with no
   * active drag (resting-energy picture).
   */
  function totalEnergy(world) {
    var cfg = world.config;
    computeTreeLayout(world);
    var anchor = world.rootHome;
    var dragged = null;
    var e = 0;
    var cards = world.cards;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      e += 0.5 * (c.vx * c.vx + c.vy * c.vy);
      var t = targetOf(world, c, dragged, anchor);
      var dx = c.x - t.x, dy = c.y - t.y;
      e += 0.5 * cfg.k * (dx * dx + dy * dy);
    }
    for (var a2 = 0; a2 < cards.length; a2++) {
      for (var b2 = a2 + 1; b2 < cards.length; b2++) {
        var ddx = cards[b2].x - cards[a2].x, ddy = cards[b2].y - cards[a2].y;
        var dd = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dd > 1e-6) e -= cfg.repulsion * Math.log(Math.min(dd, cfg.repulsionCutoff));
      }
    }
    return e;
  }

  return {
    CONFIG: CONFIG,
    createWorld: createWorld,
    addCard: addCard,
    removeCard: removeCard,
    findCard: findCard,
    computeTreeLayout: computeTreeLayout,
    nearestAnchorRoot: nearestAnchorRoot,
    targetOf: targetOf,
    step: step,
    wake: wake,
    tidy: tidy,
    totalEnergy: totalEnergy,
    mulberry32: mulberry32
  };
});
