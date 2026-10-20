/**
 * cardwall physics core — force-directed floating integrator
 *
 * Pure logic, zero dependencies: UMD-wrapped so the same module runs in
 * Node (unit tests) and the browser (renderer).
 *
 * Per-step forces:
 *   1. Pairwise repulsion (O(n^2), with cutoff)
 *   2. Parent-child spring (tree edges, rest length ~150px)
 *   3. Snap-back ring anchor (children orbit the parent's live position;
 *      roots orbit the world origin). Reaction forces are applied to the
 *      parent card so the force field stays conservative.
 *   4. Seeded Brownian drift (reproducible impulses)
 *   5. Velocity damping
 * Integration: fixed-step semi-implicit Euler; cards being dragged are
 * positioned externally and their velocity is recorded by the caller, so
 * inertia carries them on release and the snap spring pulls them home.
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
    damping: 0.975,        // per-step velocity damping (lambda ~1.5/s, "floaty" feel)
    maxSpeed: 3000,        // velocity cap (px/s)

    repulsion: 150000,     // repulsion strength: a = repulsion / d (px/s^2)
    repulsionCutoff: 800,  // repulsion cutoff (px)

    springRestLength: 150, // parent-child spring rest length (px)
    springStiffness: 10,   // tree-edge stiffness (omega ~3.2 rad/s)

    snapStiffness: 6,      // snap-back spring stiffness (weaker than tree edges
                           // so the tree shape stays readable)
    ringBaseRadius: 180,   // root ring base radius
    ringSpacing: 95,       // radius increment per extra sibling on the same ring

    driftImpulse: 25,      // Brownian impulse magnitude (px/s velocity delta)
    driftChance: 0.02,     // per-step probability of a drift impulse

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
   * Ring anchors: root cards orbit the world origin (fixed); child cards
   * orbit their parent's live position (anchor = parent pos + fixed offset).
   * Recomputed every step so the tree never tears when a parent is dragged.
   * The anchors map stores absolute coordinates; a non-null parentId means
   * the anchor is rigidly attached to the parent card, so the snap force
   * must apply an equal-and-opposite reaction to the parent. Without the
   * reaction the field is non-conservative and energy gets pumped in
   * forever (observed as perpetual oscillation).
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
      world.anchors.set(c.id, { x: Math.cos(theta) * r, y: Math.sin(theta) * r, parentId: null });
    });

    kidsByParent.forEach(function (kids, pid) {
      var p = findCard(world, pid);
      // Child ring radius = spring rest length + sibling increment: with a
      // single child the ring matches the tree edge exactly, so snap and
      // spring never fight each other.
      var r = cfg.springRestLength + cfg.ringSpacing * Math.max(0, kids.length - 1);
      kids.forEach(function (k, i) {
        var theta = (i / kids.length) * Math.PI * 2 + 0.3;
        world.anchors.set(k.id, {
          x: p.x + Math.cos(theta) * r,
          y: p.y + Math.sin(theta) * r,
          parentId: pid
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

    // 2. pairwise repulsion
    var cutoff2 = cfg.repulsionCutoff * cfg.repulsionCutoff;
    for (var a = 0; a < n; a++) {
      for (var b = a + 1; b < n; b++) {
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

    // 3. snap springs (child anchors ride the parent; reaction applied to
    //    the parent card) + parent-child springs
    for (var c = 0; c < n; c++) {
      var card = cards[c];
      var anchor = world.anchors.get(card.id);
      if (anchor) {
        var sx = (anchor.x - card.x) * cfg.snapStiffness;
        var sy = (anchor.y - card.y) * cfg.snapStiffness;
        card.fx += sx;
        card.fy += sy;
        if (anchor.parentId) {
          var ap = findCard(world, anchor.parentId);
          if (ap) { ap.fx -= sx; ap.fy -= sy; }
        }
      }
      if (card.parent) {
        var p = findCard(world, card.parent);
        if (p) {
          var ex = p.x - card.x, ey = p.y - card.y;
          var ed = Math.sqrt(ex * ex + ey * ey) || 1e-6;
          var ef = (ed - cfg.springRestLength) * cfg.springStiffness;
          var eux = ex / ed, euy = ey / ed;
          card.fx += eux * ef; card.fy += euy * ef;
          p.fx -= eux * ef; p.fy -= euy * ef;
        }
      }
    }

    // 4. seeded Brownian drift (reproducible)
    if (world.drift) {
      for (var g = 0; g < n; g++) {
        if (world.rng() < cfg.driftChance) {
          cards[g].vx += (world.rng() * 2 - 1) * cfg.driftImpulse;
          cards[g].vy += (world.rng() * 2 - 1) * cfg.driftImpulse;
        }
      }
    }

    // 5. semi-implicit Euler integration (dragged cards are positioned externally)
    for (var k = 0; k < n; k++) {
      var q = cards[k];
      if (q.dragging) continue;
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
  }

  /**
   * Total mechanical energy (KE + spring PE + repulsion PE + snap PE), used
   * by "damping dissipates energy" invariant tests.
   *   Repulsion a = repulsion/d (outward) corresponds to PE = -repulsion*ln(d);
   *   beyond the cutoff there is no force, so PE takes the constant ln(cutoff).
   *   Note: anchors are a function of position (child anchors ride the parent),
   *   so they must be recomputed before evaluation — evaluating stale anchors
   *   against live positions would distort the total.
   */
  function totalEnergy(world) {
    var cfg = world.config;
    computeAnchors(world);
    var e = 0;
    var cards = world.cards;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      e += 0.5 * (c.vx * c.vx + c.vy * c.vy);
      var anchor = world.anchors.get(c.id);
      if (anchor) {
        var ax = anchor.x - c.x, ay = anchor.y - c.y;
        e += 0.5 * cfg.snapStiffness * (ax * ax + ay * ay);
      }
      if (c.parent) {
        var p = findCard(world, c.parent);
        if (p) {
          var dx = p.x - c.x, dy = p.y - c.y;
          var d = Math.sqrt(dx * dx + dy * dy);
          e += 0.5 * cfg.springStiffness * (d - cfg.springRestLength) * (d - cfg.springRestLength);
        }
      }
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
    computeAnchors: computeAnchors,
    step: step,
    totalEnergy: totalEnergy,
    mulberry32: mulberry32
  };
});
