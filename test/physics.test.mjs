import { test } from 'node:test';
import assert from 'node:assert/strict';
import physics from '../renderer/physics.js';

const { createWorld, addCard, step, totalEnergy, computeAnchors } = physics;

function makeWorld(opts) {
  const w = createWorld({ seed: 42, ...opts });
  return w;
}

test('确定性：同 seed 同输入 → 位置逐位一致', () => {
  function run() {
    const w = makeWorld();
    addCard(w, { id: 'a', x: 0, y: 0 });
    addCard(w, { id: 'b', x: 200, y: 0, parent: 'a' });
    for (let i = 0; i < 500; i++) step(w);
    return w.cards.map(c => [c.x, c.y, c.vx, c.vy]);
  }
  assert.deepEqual(run(), run());
});

test('稳定性：10k 步无 NaN/Infinity', () => {
  const w = makeWorld();
  for (let i = 0; i < 12; i++) addCard(w, { id: 'c' + i, x: i * 130, y: (i % 3) * 90, parent: i > 0 && i % 4 === 0 ? 'c' + (i - 4) : null });
  for (let i = 0; i < 10000; i++) step(w);
  for (const c of w.cards) {
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y), `card ${c.id} pos finite`);
    assert.ok(Number.isFinite(c.vx) && Number.isFinite(c.vy), `card ${c.id} vel finite`);
  }
});

test('能耗散：关漂移后总机械能递减且不发散', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'a', x: 0, y: 0 });
  addCard(w, { id: 'b', x: 400, y: 300 });
  addCard(w, { id: 'c', x: -350, y: 200 });
  addCard(w, { id: 'd', x: 100, y: -400, parent: 'a' });
  const e0 = totalEnergy(w);
  let maxE = e0;
  for (let i = 0; i < 3000; i++) {
    step(w);
    maxE = Math.max(maxE, totalEnergy(w));
  }
  const e1 = totalEnergy(w);
  assert.ok(e1 < e0, `energy should decay: e0=${e0.toFixed(0)} e1=${e1.toFixed(0)}`);
  assert.ok(maxE <= e0 + Math.abs(e0) * 0.05 + 1e-6, `no energy blowup: maxE=${maxE.toFixed(0)} e0=${e0.toFixed(0)}`);
});

test('排斥：重叠卡片被推开', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'a', x: 0, y: 0 });
  addCard(w, { id: 'b', x: 5, y: 5 });
  const d0 = Math.hypot(w.cards[1].x - w.cards[0].x, w.cards[1].y - w.cards[0].y);
  for (let i = 0; i < 300; i++) step(w);
  const d1 = Math.hypot(w.cards[1].x - w.cards[0].x, w.cards[1].y - w.cards[0].y);
  assert.ok(d1 > d0 + 50, `distance should grow: d0=${d0.toFixed(1)} d1=${d1.toFixed(1)}`);
});

test('回弹：单根卡偏离锚点后收敛回锚点', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'solo', x: 800, y: 600 });
  computeAnchors(w);
  const d0 = Math.hypot(w.cards[0].x - w.anchors.get('solo').x, w.cards[0].y - w.anchors.get('solo').y);
  for (let i = 0; i < 900; i++) step(w);
  const solo = w.cards[0];
  const anchor = w.anchors.get('solo');
  const dist = Math.hypot(solo.x - anchor.x, solo.y - anchor.y);
  assert.ok(dist < 5, `snap-back within 5px (from ${d0.toFixed(0)}), got ${dist.toFixed(2)}`);
});

test('回弹：子卡被拉远后回到父卡附近的 ring 位', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'p', x: 0, y: 0 });
  addCard(w, { id: 'k', x: 800, y: 600, parent: 'p' });
  for (let i = 0; i < 900; i++) step(w);
  const k = w.cards[1];
  const anchor = w.anchors.get('k');
  const dist = Math.hypot(k.x - anchor.x, k.y - anchor.y);
  // 静止点被排斥力外推：环半径=弹簧自然长度时恢复力同向（总刚度 snap+spring=16），
  // 解析平衡 K*(d-150) = repulsion/d → d*≈197.5px，即子卡静止在锚点外 ~47px。
  // 这是设计使然的「呼吸空间」（排斥提供间距），非收敛缺陷；阈值按解析解放宽。
  assert.ok(dist < 60, `child settles near ring anchor (repulsion-shifted), got ${dist.toFixed(2)}`);
  const dParent = Math.hypot(k.x - w.cards[0].x, k.y - w.cards[0].y);
  assert.ok(dParent > 100 && dParent < 250, `parent-child distance organic: ${dParent.toFixed(0)}`);
  const speed = Math.hypot(k.vx, k.vy);
  assert.ok(speed < 1, `child fully at rest: speed=${speed.toFixed(3)}`);
});

test('平衡点：父子静止距离符合解析解 K*(d-rest)=repulsion/d', () => {
  // 环半径=弹簧自然长度时 snap/spring 同向，总刚度 K=snap+spring，
  // 与排斥平衡：K*(d-rest) = repulsion/d → 二次方程正根即理论静止距离。
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'p', x: 0, y: 0 });
  addCard(w, { id: 'k', x: 800, y: 600, parent: 'p' });
  const cfg = w.config;
  const K = cfg.snapStiffness + cfg.springStiffness;
  const dTheory = (K * cfg.springRestLength +
    Math.sqrt(K * K * cfg.springRestLength * cfg.springRestLength + 4 * K * cfg.repulsion)) / (2 * K);
  for (let i = 0; i < 900; i++) step(w);
  const dActual = Math.hypot(w.cards[1].x - w.cards[0].x, w.cards[1].y - w.cards[0].y);
  assert.ok(Math.abs(dActual - dTheory) < 5,
    `equilibrium matches analytic solution: theory=${dTheory.toFixed(1)} actual=${dActual.toFixed(1)}`);
});

test('拖拽中卡片位置由外部控制、不受力积分影响', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'a', x: 0, y: 0 });
  addCard(w, { id: 'b', x: 0, y: 0, parent: 'a' });
  w.cards[1].dragging = true;
  w.cards[1].x = 500;
  w.cards[1].y = 400;
  for (let i = 0; i < 60; i++) step(w);
  assert.equal(w.cards[1].x, 500);
  assert.equal(w.cards[1].y, 400);
});

test('锚点结构：子卡锚点绕父卡当前位置成环', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'p', x: 100, y: 100 });
  addCard(w, { id: 'k1', x: 0, y: 0, parent: 'p' });
  addCard(w, { id: 'k2', x: 0, y: 0, parent: 'p' });
  step(w, 0); // 触发 computeAnchors
  const a1 = w.anchors.get('k1'), a2 = w.anchors.get('k2');
  const r1 = Math.hypot(a1.x - 100, a1.y - 100);
  const r2 = Math.hypot(a2.x - 100, a2.y - 100);
  assert.ok(Math.abs(r1 - r2) < 1e-9, 'children anchors share ring radius');
  assert.ok(r1 > 50, `ring radius reasonable: ${r1.toFixed(1)}`);
  // 父卡移动后锚点跟随
  w.cards[0].x = 500;
  step(w, 0);
  const a1b = w.anchors.get('k1');
  assert.ok(Math.hypot(a1b.x - 500, a1b.y - 100) > 50, 'anchor follows parent move');
});

// ---- 自由放置（钉住）：拖动过的卡片归用户所有 -------------------------------

test('钉住：拖放到锚点之外后纹丝不动（不回锚、不漂移）', () => {
  const w = makeWorld(); // 漂移开着，最能暴露"手放好又飘走"
  addCard(w, { id: 'p', x: 0, y: 0 });
  addCard(w, { id: 'k', x: 40, y: 30, parent: 'p' });
  const k = w.cards[1];
  k.pinned = true;       // pointerdown 时发生
  k.x = 600;             // 手放到远离 ring 锚点的位置
  k.y = 420;
  for (let i = 0; i < 600; i++) step(w);
  assert.equal(k.x, 600);
  assert.equal(k.y, 420);
  assert.equal(k.vx, 0);
  assert.equal(k.vy, 0);
});

test('钉住：仍然排斥邻居，但自己不受反作用力', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'pin', x: 0, y: 0, pinned: true });
  addCard(w, { id: 'free', x: 30, y: 0 });
  for (let i = 0; i < 300; i++) step(w);
  const pin = w.cards[0], free = w.cards[1];
  assert.equal(pin.x, 0, 'pinned card never moves');
  assert.equal(pin.y, 0);
  const d = Math.hypot(free.x - pin.x, free.y - pin.y);
  assert.ok(d > 150, `neighbour pushed away: ${d.toFixed(0)}`);
});

test('取消钉住：重新受力并把卡片拉回自己的锚点', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'solo', x: 0, y: 0 });
  const c = w.cards[0];
  c.pinned = true;
  c.x = 700;
  c.y = 500;
  for (let i = 0; i < 120; i++) step(w);
  assert.equal(c.x, 700, 'frozen while pinned');
  c.pinned = false;
  for (let i = 0; i < 900; i++) step(w);
  const back = Math.hypot(c.x - 700, c.y - 500);
  assert.ok(back > 100, `snaps back once unpinned: moved ${back.toFixed(0)}px`);
});
