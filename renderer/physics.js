/**
 * cardwall 物理核心 —— 力导向漂浮积分器
 *
 * 纯逻辑、零依赖：UMD 包装，Node（单测）与浏览器（renderer）双端可用。
 *
 * 每帧受力：
 *   1. 成对排斥（O(n^2)，带 cutoff）
 *   2. 父子弹簧（树边，rest length ~150px）
 *   3. 回弹锚点（父卡当前位置 + 子序号极坐标 ring 位；根卡绕世界原点 ring）
 *   4. 布朗微漂移（seeded 随机脉冲，幅度可调）
 *   5. 阻尼
 * 积分：固定步长半隐式欧拉；拖拽中的卡片由外部直接设位置并记录速度，
 * 松手后惯性自然接管、回锚弹簧拉回。
 *
 * 对标依据（Obsidian Canvas RE）：Obsidian 无释放惯性/无物理，
 * 本模块是 cardwall 的核心差异点；视口/吸附等其余参数见 RE 报告 config 表。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardPhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONFIG = {
    dt: 1 / 60,            // 固定步长（秒）
    damping: 0.975,        // 每步速度阻尼（λ≈1.5/s，偏「漂浮」手感）
    maxSpeed: 3000,        // 速度上限（px/s）

    repulsion: 150000,     // 排斥强度：a = repulsion / d（px/s²）
    repulsionCutoff: 800,  // 排斥 cutoff（px）

    springRestLength: 150, // 父子弹簧自然长度（px）
    springStiffness: 10,   // 父子弹簧刚度（ω≈3.2 rad/s）

    snapStiffness: 6,      // 回锚弹簧刚度（弱于树边，树形更清晰）
    ringBaseRadius: 180,   // 根卡 ring 基础半径
    ringSpacing: 95,       // 每多一个同层卡片的半径增量

    driftImpulse: 25,      // 布朗脉冲幅度（px/s 速度增量）
    driftChance: 0.02,     // 每步触发脉冲的概率

    cardWidth: 250,        // 默认卡宽（对标 Obsidian 文本卡）
    cardHeight: 60         // 默认卡高
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
   * 回锚 ring：根卡绕世界原点（固定）；子卡绕父卡当前位置（锚点 = 父位 + 固定偏移）。
   * 每步重算（父卡被拖动时子卡锚点跟随，树不撕裂）。
   * anchors 表存绝对坐标；parentId 非空表示该锚点刚性挂在父卡上，
   * 回锚力必须把等大反向的反作用力加回父卡，否则力场非保守、能量被持续泵入
   * （实测表现为永动振荡）。
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
      if (c.parent && findCard(world, c.parent)) return; // 子卡在下面按父卡处理
      var idx = roots.indexOf(c);
      var r = cfg.ringBaseRadius + cfg.ringSpacing * Math.max(0, roots.length - 1);
      var theta = (idx / Math.max(1, roots.length)) * Math.PI * 2 + 0.3;
      world.anchors.set(c.id, { x: Math.cos(theta) * r, y: Math.sin(theta) * r, parentId: null });
    });

    kidsByParent.forEach(function (kids, pid) {
      var p = findCard(world, pid);
      // 子卡 ring 半径 = 弹簧自然长度 + 同胞增量：单子卡时与树边完全同长，回锚与树边不互斗
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

    // 1. 清零受力
    for (var i = 0; i < n; i++) { cards[i].fx = 0; cards[i].fy = 0; }

    // 2. 成对排斥
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

    // 3. 回锚弹簧（子卡锚点挂在父卡上，反作用力回传父卡）+ 父子弹簧
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

    // 4. 布朗微漂移（seeded，保证可复现）
    if (world.drift) {
      for (var g = 0; g < n; g++) {
        if (world.rng() < cfg.driftChance) {
          cards[g].vx += (world.rng() * 2 - 1) * cfg.driftImpulse;
          cards[g].vy += (world.rng() * 2 - 1) * cfg.driftImpulse;
        }
      }
    }

    // 5. 半隐式欧拉积分（拖拽中的卡片位置由外部控制）
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

  /** 总机械能（KE + 弹簧 PE + 排斥 PE + 回锚 PE），用于「阻尼使能耗散」类不变量测试。
   *  排斥力 a = repulsion/d（向外）对应 PE = −repulsion·ln(d)；超过 cutoff 无力，取 ln(cutoff) 常值。
   *  注意：锚点是位置的函数（子卡锚随父卡），求值前必须重算，否则用旧锚点对当前位置求值会失真。 */
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
