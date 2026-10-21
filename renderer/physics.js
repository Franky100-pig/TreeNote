/**
 * cardwall physics core — force-directed floating integrator
 *
 * Pure logic, zero dependencies: UMD-wrapped so the same module runs in
 * Node (unit tests) and the browser (renderer).
 *
 * Per-step forces (all on non-pinned cards; pinned cards opt out):
 *   1. Pairwise repulsion (O(n^2), with cutoff) — soft spacing, no bounce.
 *   2. Rope coupling: each card hangs from a fixed-length line — roots from
 *      the world origin, children from their parent. The line fixes DISTANCE
 *      only, so a card may swing around its tether instead of being welded to
 *      an angular slot: the tree is a string of floats being towed. Tension is
 *      one-sided (a rope pulls, it never pushes) and elastic, so it visibly
 *      stretches a little under load instead of behaving like a rigid rod.
 *      Reaction goes to the parent, so the field stays conservative.
 *   3. Radial damping on the rope (its internal resistance): opposes the rate
 *      of stretch only, never the swing — damping the full relative velocity
 *      would carry children along rigidly with their parent.
 *   4. Drag wake: the card in hand pushes its neighbours, distance-attenuated,
 *      in its own travel direction. Pure push, so it can never oscillate. This
 *      is the "others float by distance while you drag" half.
 *   5. Seeded Brownian drift (reproducible impulses) — the board breathes.
 *   6. Global velocity damping — it settles the SWING of a towed branch (the
 *      rope only damps its own stretch, see 3), and it dissipates the
 *      drag-wake / repulsion kinetic energy quickly after a drag ends.
 * Integration: fixed-step semi-implicit Euler; cards being dragged are
 * positioned externally and their velocity is recorded by the caller.
 *
 * Pinned cards opt out of all of it: they take no forces, do not drift and
 * are not integrated, so they stay exactly where the user dropped them
 * (Obsidian-style free placement). They still repel their neighbours and
 * still tow their children, so the tree keeps its shape. This is the
 * answer to "the layout fights me": auto-layout is a starting suggestion,
 * and touching a card makes it yours.
 *
 * Dormancy ("the board holds still, but breathes"):
 * a card that has been quiet for `sleepSteps` falls asleep — no drift, no
 * integration, position frozen — until a neighbour's force (a drag, a new
 * card, a ripple) exceeds `sleepForce` and wakes it. So the resting board
 * is a fixed arrangement instead of a constantly vibrating one, while a
 * drag still ripples outward and the whole branch floats back to rest.
 *
 * Reference (Obsidian Canvas RE): Obsidian has no release inertia and no
 * physics at all — this module is cardwall's core differentiator.
 * See the RE report for viewport/snap config defaults.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardPhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONFIG = {
    dt: 1 / 60,            // fixed step (seconds)
    damping: 0.93,         // per-step GLOBAL velocity damping. Softer than 0.95
                           // so a towed branch GLIDES instead of crawling: the
                           // rope's own damper handles the radial mode, this
                           // one just bleeds off the swing and the leftovers of
                           // a drag. Too high and the last few px become a slow
                           // over-damped creep.
    maxSpeed: 3000,        // velocity cap (px/s)

    repulsion: 90000,      // repulsion strength: a = repulsion / d (px/s^2).
                           // Gentle on purpose: a close encounter is a soft
                           // nudge, not a hard bounce, so the wall reads as
                           // floating water rather than elastic coils.
    repulsionCutoff: 800,  // repulsion cutoff (px)

    // ---- rope coupling ------------------------------------------------------
    // Every card hangs from a fixed-length line: roots from the world origin,
    // children from their parent. The line fixes DISTANCE only — there is no
    // angular slot — so a card may swing around its tether and the tree reads
    // as a string of floats being towed, not as a welded radial diagram.
    childRopeLength: 200,  // rope length for a single child (px). With more
                           // siblings the ring grows by ringSpacing so a big
                           // family stays compact; see computeAnchors.
    ropeStiffness: 60,     // tension per px of stretch (px/s^2 per px). Stiff
                           // enough that the tree's slowest mode is fast (~1s):
                           // omega = sqrt(ropeStiffness). The rope is ELASTIC —
                           // it visibly stretches 10-20px under a drag instead
                           // of behaving like a rigid rod.
    ropeDampRatio: 1.0,    // radial damping relative to critical (2*sqrt(K)).
                           // It damps the RATE OF STRETCH, so the rope itself
                           // never rings.
    swingDamp: 0.4,        // tangential resistance along the rope (0..1).
                           // 0 leaves the swing completely free — pretty, but
                           // repulsion then walks the board around its tethers
                           // for tens of seconds (measured), because an angle
                           // with no restoring force is a near-neutral mode.
                           // 1 damps the swing as hard as the stretch, which
                           // makes a child ride along with its parent.
    anchorStiffness: 30,   // ANGLE MEMORY: a soft pull toward the nominal slot
                           // (children: parent + rope direction, roots: their
                           // place on the origin ring). The rope fixes the
                           // RADIUS but leaves the ANGLE free, and a free angle
                           // has almost no restoring force — tangential
                           // stiffness is only ~F/r (measured 0.6 at 400px, a
                           // ~30s relaxation), so without this the board would
                           // never come to rest. At 26 it is ~40% softer than
                           // the rope, so a dragged card still visibly swings
                           // and only then drifts back. Set to 0 for the pure
                           // free-swinging rope.
    ringBaseRadius: 220,   // root ring base radius
    ringSpacing: 60,       // radius increment per extra sibling on the same ring
                           // (C7: 95 -> 60 — with 4 children the anchors reached
                           // 435px and the settled tree needed a 0.66 fit scale;
                           // 60 keeps big families compact, fit scale ~0.8)

    // Drag wake: the card in your hand pushes its neighbours, distance
    // attenuated, in the direction it is moving — like a body moving through
    // water carries the fluid with it. This is what makes "other cards float
    // while you drag" read as organic, and being a pure push (no restoring
    // pull) it can never oscillate.
    wakeRadius: 520,       // how far the ripple reaches (px)
    wakeStrength: 1.5,     // how strongly neighbours are carried along (force per
                           // unit grabbed-card speed, distance-attenuated). Gentle
                           // on purpose: the wake should FLOAT cards, not fling
                           // them — a hard wake injects kinetic energy that the
                           // board then has to dissipate, defeating the ~1s
                           // settle. The structural spring (stiffer) does the
                           // "follow the dragged parent" part; the wake adds the
                           // distance-based drift of UNRELATED neighbours.

    driftImpulse: 14,      // Brownian impulse magnitude (px/s velocity delta)
    driftChance: 0.0009,   // per-step probability of a drift impulse (~1 per 18s
                           // per card: a ripple, not a vibration. The old 0.02
                           // fired ~1.2 times a second and read as "elastic")

    sleepSpeed: 0.6,       // px/s: below this a card counts as momentarily still
    sleepForce: 30,        // px/s^2: net force small enough to be "at rest".
                           // Raised from 10 for the rope model: a hanging card
                           // always carries a large balanced tension (K*(d-L)
                           // ~600 px/s^2), so a tight threshold would keep a
                           // perfectly still card awake forever on the residue
                           // of two big forces that almost cancel.
    sleepSteps: 60,        // consecutive quiet steps (~1s) before a card sleeps

    cardWidth: 250,        // default card width (matches Obsidian text cards)
    cardHeight: 60         // default card height
  };

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
      anchors: new Map(),
      time: 0,
      rng: mulberry32(options.seed == null ? 1 : options.seed),
      drift: options.drift == null ? true : options.drift,
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
    card.pinned = !!card.pinned; // free placement: no forces, no drift
    card.awake = card.awake === undefined ? true : !!card.awake;
    card.still = 0;              // consecutive quiet steps (see dormancy)
    card.fx = 0;
    card.fy = 0;
    world.cards.push(card);
    return card;
  }

  function removeCard(world, id) {
    var i = world.cards.findIndex(function (c) { return c.id === id; });
    if (i >= 0) world.cards.splice(i, 1);
  }

  /**
   * Ring geometry. Each card gets a ROPE: `ringR` is the rope's length (px)
   * and `parentId` is its tether (null = the world origin). The x/y fields are
   * the nominal rest point used for the initial layout, the debug overlay and
   * the tests — the simulation itself never pulls a card toward them, it only
   * enforces the rope length (see step()).
   *
   * Roots are all tied to the origin with one shared radius, so they orbit it;
   * children are tied to their parent with a radius that grows per sibling.
   */
  function computeAnchors(world) {
    var cfg = world.config;
    world.anchors.clear();

    var kidsByParent = new Map();
    var roots = [];
    world.cards.forEach(function (c) {
      var p = c.parent ? findCard(world, c.parent) : null;
      if (!p) { roots.push(c); return; }
      if (!kidsByParent.has(c.parent)) kidsByParent.set(c.parent, []);
      kidsByParent.get(c.parent).push(c);
    });

    world.cards.forEach(function (c) {
      if (c.parent && findCard(world, c.parent)) return; // children handled below, per parent
      var idx = roots.indexOf(c);
      var r = cfg.ringBaseRadius + cfg.ringSpacing * Math.max(0, roots.length - 1);
      var theta = (idx / Math.max(1, roots.length)) * Math.PI * 2 + 0.3;
      world.anchors.set(c.id, { x: Math.cos(theta) * r, y: Math.sin(theta) * r, parentId: null, ringR: r });
    });

    kidsByParent.forEach(function (kids, pid) {
      var p = findCard(world, pid);
      // Child ring radius = spring rest length + sibling increment: with a
      // single child the ring matches the tree edge exactly, so snap and
      // spring never fight each other.
      var r = cfg.childRopeLength + cfg.ringSpacing * Math.max(0, kids.length - 1);
      kids.forEach(function (k, i) {
        var theta = (i / kids.length) * Math.PI * 2 + 0.3;
        world.anchors.set(k.id, {
          x: p.x + Math.cos(theta) * r,
          y: p.y + Math.sin(theta) * r,
          parentId: pid,
          ringR: r
        });
      });
    });
  }

  function step(world, dt) {
    dt = dt || world.config.dt;
    var cfg = world.config;
    var cards = world.cards;
    var n = cards.length;
    world.time += dt;

    computeAnchors(world);

    // 1. zero forces
    for (var i = 0; i < n; i++) { cards[i].fx = 0; cards[i].fy = 0; }

    // 2. pairwise repulsion (a pinned card is an immovable obstacle: it
    //    still pushes its neighbour, but never receives the push back)
    var cutoff2 = cfg.repulsionCutoff * cfg.repulsionCutoff;
    for (var a = 0; a < n; a++) {
      for (var b = a + 1; b < n; b++) {
        if (cards[a].pinned && cards[b].pinned) continue;
        var dx = cards[b].x - cards[a].x;
        var dy = cards[b].y - cards[a].y;
        var d2 = dx * dx + dy * dy;
        if (d2 > cutoff2 || d2 < 1e-6) continue;
        var d = Math.sqrt(d2);
        var f = cfg.repulsion / d;
        var ux = dx / d, uy = dy / d;
        if (!cards[a].pinned) { cards[a].fx -= ux * f; cards[a].fy -= uy * f; }
        if (!cards[b].pinned) { cards[b].fx += ux * f; cards[b].fy += uy * f; }
      }
    }

    // 3. rope coupling — each card hangs from a fixed-length line: roots from
    //    the world origin, children from their parent. The line constrains
    //    DISTANCE only, so a card can swing around its tether; nothing pulls
    //    it into an angular slot. That is the whole difference from the old
    //    spring: a spring owns a POINT (you always return to it, from either
    //    side), a rope owns a LENGTH (you hang wherever the rope, the
    //    repulsion and the drag leave you). Reaction goes to the parent, so
    //    the field stays conservative and no energy is pumped in.
    var K = cfg.ropeStiffness;
    var dampCoef = cfg.ropeDampRatio * 2 * Math.sqrt(K); // critical damping of K
    for (var c = 0; c < n; c++) {
      var card = cards[c];
      if (card.pinned) continue;               // pinned cards are already fixed
      var anchor = world.anchors.get(card.id);
      if (!anchor) continue;

      // Tether point and its velocity: the origin for a root (static), the
      // parent card for a child (it moves, so the rope is towed along).
      var pcard = null;
      var tx = 0, ty = 0, tvx = 0, tvy = 0;
      if (anchor.parentId) {
        pcard = findCard(world, anchor.parentId);
        if (!pcard) continue;                  // dangling parent: no tether
        tx = pcard.x; ty = pcard.y;
        if (!pcard.pinned) { tvx = pcard.vx; tvy = pcard.vy; }
      }
      var ropeLen = anchor.ringR;

      var dx = card.x - tx, dy = card.y - ty;
      var d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      var ux = dx / d, uy = dy / d;            // unit vector tether -> card

      // One-sided tension: a rope pulls, it never pushes. Inside the rope
      // length the line is slack and contributes nothing. Slack is transient
      // rather than a resting state, because the pair also repels each other,
      // so they separate until the rope goes taut. Equilibrium therefore stays
      // the analytic K*(d-L) = repulsion/d — only now it holds at ANY angle.
      //
      // ROOTS ARE THE EXCEPTION: their line is a mooring to the world origin
      // and holds the radius in BOTH directions. A one-sided root line leaves
      // the whole board unanchored whenever the root sits inside its radius,
      // and the tree then translates as a block (measured: every card drifting
      // at ~14px/s, force ~45 with nothing to oppose it) until the line happens
      // to go taut. Two-sided keeps the board's centre where it belongs while
      // still leaving the tree free to rotate around the origin.
      var stretch = d - ropeLen;
      var tension = anchor.parentId ? (stretch > 0 ? stretch * K : 0) : stretch * K;
      var fx = ux * tension, fy = uy * tension;

      // Rope resistance, split into the two modes the line actually has:
      //   radial  — the rate of stretch. Critical here (ropeDampRatio) so the
      //             rope never rings.
      //   tangential — the swing. A real rope has none, but a pure swing mode
      //             is excited by repulsion and has almost no restoring force
      //             (the angle is free), so the board would creep around its
      //             tethers for tens of seconds instead of settling. The
      //             swing damper (0..1) is the "wet rope" knob: 0 = perfectly
      //             free swing, 1 = the child is dragged along with its parent.
      var rvx = card.vx - tvx, rvy = card.vy - tvy;
      var rvRad = rvx * ux + rvy * uy;
      var rvTan = -rvx * uy + rvy * ux;
      var dampRad = rvRad * dampCoef;
      var dampTan = rvTan * dampCoef * cfg.swingDamp;
      fx += ux * dampRad - uy * dampTan;
      fy += uy * dampRad + ux * dampTan;

      // Angle memory. The rope fixes the radius, so the ANGLE is free — and a
      // free angle has almost no restoring force (tangential stiffness is only
      // ~F/r, measured ≈0.6 at 400px, which gives a ~30s relaxation). A soft
      // pull toward the nominal slot gives that mode a gentle gradient without
      // turning the rope into a spring: anchorStiffness is ~3x softer than
      // ropeStiffness, so during a drag the rope still owns the radial motion
      // and the card visibly swings; the memory only decides where it comes to
      // rest. anchorStiffness = 0 restores the pure free-swinging rope.
      if (cfg.anchorStiffness > 0) {
        var mx = card.x - anchor.x, my = card.y - anchor.y;
        card.fx -= mx * cfg.anchorStiffness;
        card.fy -= my * cfg.anchorStiffness;
        if (pcard) { pcard.fx += mx * cfg.anchorStiffness; pcard.fy += my * cfg.anchorStiffness; }
      }
      // Force on the card points back along the rope (toward the tether);
      // equal-and-opposite on the parent. A root has nothing to push against.
      card.fx -= fx; card.fy -= fy;
      if (pcard) { pcard.fx += fx; pcard.fy += fy; }
    }

    // 4. drag wake — a moving card carries its neighbours along, distance
    //    attenuated, in its own direction of travel. Pure push, no restoring
    //    pull, so it can never oscillate (that is the whole point: "float
    //    like a jellyfish, not a spring"). The velocity of the grabbed card
    //    is reconstructed from its position delta, since a dragging card is
    //    positioned externally and its stored velocity is zeroed.
    for (var dg = 0; dg < n; dg++) {
      var dcard = cards[dg];
      if (!dcard.dragging) continue;
      var dvx = (dcard.x - (dcard._px != null ? dcard._px : dcard.x)) / dt;
      var dvy = (dcard.y - (dcard._py != null ? dcard._py : dcard.y)) / dt;
      var dsp2 = dvx * dvx + dvy * dvy;
      if (dsp2 > 1) {
        for (var o = 0; o < n; o++) {
          var other = cards[o];
          if (other.dragging || other.pinned) continue;
          var ox = other.x - dcard.x, oy = other.y - dcard.y;
          var od = Math.sqrt(ox * ox + oy * oy) || 1e-6;
          if (od > cfg.wakeRadius) continue;
          var fall = 1 - od / cfg.wakeRadius; // 1 at the grabbed card -> 0 at edge
          other.fx += dvx * cfg.wakeStrength * fall;
          other.fy += dvy * cfg.wakeStrength * fall;
        }
      }
      dcard._px = dcard.x;
      dcard._py = dcard.y;
    }

    // 5. seeded Brownian drift (reproducible). A ripple also wakes a
    //    sleeping card — that is how the resting board stays alive without
    //    being a vibration: one card stirs, its branch follows, then it
    //    goes back to sleep.
    if (world.drift) {
      for (var g = 0; g < n; g++) {
        if (cards[g].pinned || cards[g].dragging) continue;
        if (world.rng() < cfg.driftChance) {
          cards[g].vx += (world.rng() * 2 - 1) * cfg.driftImpulse;
          cards[g].vy += (world.rng() * 2 - 1) * cfg.driftImpulse;
          if (!cards[g].awake) { cards[g].awake = true; cards[g].still = 0; }
        }
      }
    }

    // 5. wake test: a sleeping card stays frozen until something actually
    //    pulls on it. Pinned and dragged cards are always "awake" so that
    //    releasing them rejoins the float immediately.
    for (var w = 0; w < n; w++) {
      var wc = cards[w];
      if (wc.pinned || wc.dragging || wc.hover) { wc.awake = true; wc.still = 0; continue; }
      if (!wc.awake && (wc.fx * wc.fx + wc.fy * wc.fy) > cfg.sleepForce * cfg.sleepForce) {
        wc.awake = true;
        wc.still = 0;
      }
    }

    // 6. semi-implicit Euler integration (dragged, pinned, hovered and
    //    sleeping cards are positioned externally or intentionally still).
    //    `hover` is the UI's "freeze this card while the pointer is over it"
    //    flag: it keeps the hover toolbar rock-steady on an otherwise
    //    floating card, without persisting a pin.
    for (var k = 0; k < n; k++) {
      var q = cards[k];
      if (q.dragging || q.pinned || q.hover || !q.awake) { q.vx = 0; q.vy = 0; continue; }
      q.vx = (q.vx + q.fx * dt) * cfg.damping;
      q.vy = (q.vy + q.fy * dt) * cfg.damping;
      var sp = Math.sqrt(q.vx * q.vx + q.vy * q.vy);
      if (sp > cfg.maxSpeed) {
        q.vx = q.vx / sp * cfg.maxSpeed;
        q.vy = q.vy / sp * cfg.maxSpeed;
      }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }

    // 7. dormancy: quiet for sleepSteps in a row (low speed *and* low net
    //    force) and the card stops integrating — the arrangement holds.
    for (var s = 0; s < n; s++) {
      var sc = cards[s];
      if (sc.pinned || sc.dragging || sc.hover || !sc.awake) continue;
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
   * Total mechanical energy (KE + spring PE + repulsion PE + snap PE), used
   * by "damping dissipates energy" invariant tests.
   *   Repulsion a = repulsion/d (outward) corresponds to PE = -repulsion*ln(d);
   *   beyond the cutoff there is no force, so PE takes the constant ln(cutoff).
   *   Note: anchors are a function of position (child anchors ride the parent),
   *   so they must be recomputed before evaluation — evaluating stale anchors
   *   against live positions would distort the total.
   *   Pinned cards are frozen by construction, so their stored PE is not
   *   convertible and is left out (only unpinned pairs are counted).
   */
  function totalEnergy(world) {
    var cfg = world.config;
    computeAnchors(world);
    var e = 0;
    var cards = world.cards;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.pinned) continue;
      e += 0.5 * (c.vx * c.vx + c.vy * c.vy);
      var anchor = world.anchors.get(c.id);
      if (anchor) {
        // Rope PE: only a stretched rope stores energy (one-sided).
        var tetherX = 0, tetherY = 0;
        if (anchor.parentId) {
          var p = findCard(world, anchor.parentId);
          if (p) { tetherX = p.x; tetherY = p.y; }
        }
        var rx = c.x - tetherX, ry = c.y - tetherY;
        var rd = Math.sqrt(rx * rx + ry * ry);
        var stretch = rd - anchor.ringR;
        if (stretch > 0) e += 0.5 * cfg.ropeStiffness * stretch * stretch;
        // Angle-memory PE (a soft 2D pull toward the nominal slot).
        if (cfg.anchorStiffness > 0) {
          var ax = c.x - anchor.x, ay = c.y - anchor.y;
          e += 0.5 * cfg.anchorStiffness * (ax * ax + ay * ay);
        }
      }
    }
    for (var a2 = 0; a2 < cards.length; a2++) {
      for (var b2 = a2 + 1; b2 < cards.length; b2++) {
        if (cards[a2].pinned || cards[b2].pinned) continue;
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
    computeAnchors: computeAnchors,
    step: step,
    wake: wake,
    totalEnergy: totalEnergy,
    mulberry32: mulberry32
  };
});
