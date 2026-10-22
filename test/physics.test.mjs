import { test } from 'node:test';
import assert from 'node:assert/strict';
import physics from '../renderer/physics.js';

const { createWorld, addCard, step, totalEnergy, computeTreeLayout } = physics;

function makeWorld(opts) {
  return createWorld({ seed: 42, ...opts });
}

function depthOf(world, id) {
  let d = 0, cur = physics.findCard(world, id), guard = 0;
  while (cur && cur.parent && guard++ < 1000) { d++; cur = physics.findCard(world, cur.parent); }
  return d;
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

test('tidy 布局：同深度共享层级，父节点居中于子节点，叶子不重叠', () => {
  const w = makeWorld({ drift: false });
  // root -> c1,c2,c3 (leaves) and c4 -> g (grandchild)
  addCard(w, { id: 'root', x: 0, y: 0 });
  addCard(w, { id: 'c1', x: -400, y: -200, parent: 'root' });
  addCard(w, { id: 'c2', x: 0, y: -200, parent: 'root' });
  addCard(w, { id: 'c3', x: 400, y: -200, parent: 'root' });
  addCard(w, { id: 'c4', x: 200, y: 200, parent: 'root' });
  addCard(w, { id: 'g', x: 200, y: 400, parent: 'c4' });
  computeTreeLayout(w);
  const cfg = w.config;
  const O = id => physics.findCard(w, id)._ox;
  const Y = id => physics.findCard(w, id)._oy;
  // Same depth -> same vertical level (relative offsets).
  for (const id of ['c1', 'c2', 'c3', 'c4']) assert.equal(Y(id), cfg.levelGap);
  assert.equal(Y('g'), 2 * cfg.levelGap);
  // root centred over its OUTERMOST children (leftmost & rightmost at depth 1).
  // NOTE: computeTreeLayout packs children in x-sorted order, so the rightmost
  // depth-1 child here is c3 (x=400), not c4 (x=200, which has a grandchild).
  // Check against the actual min/max rather than hard-coding the pair.
  const xs1 = ['c1', 'c2', 'c3', 'c4'].map(O);
  assert.ok(Math.abs(O('root') - (Math.min(...xs1) + Math.max(...xs1)) / 2) < 1e-6, 'root centred over outermost children');
  // Leaves on a level are spaced by nodeGap (minimum pairwise distance).
  const leafXs = ['c1', 'c2', 'c3'].map(O).sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 0; i + 1 < leafXs.length; i++) minGap = Math.min(minGap, leafXs[i + 1] - leafXs[i]);
  assert.ok(Math.abs(minGap - cfg.nodeGap) < 1e-6, `leaf spacing = nodeGap: ${minGap}`);
});

test('tidy 静止态：树收敛为整齐层次，无重叠', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'root', x: 0, y: 0 });
  addCard(w, { id: 'n1', x: 160, y: -160, parent: 'root' });
  addCard(w, { id: 'n2', x: 260, y: 90, parent: 'root' });
  addCard(w, { id: 'n3', x: -80, y: 210, parent: 'root' });
  addCard(w, { id: 'n4', x: -260, y: -90, parent: 'root' });
  addCard(w, { id: 'n5', x: -260, y: -300, parent: 'n4' });
  for (let i = 0; i < 1500; i++) step(w);
  const cfg = w.config;
  const root = physics.findCard(w, 'root');
  // depth-1 children share a level at ~levelGap below the root.
  for (const id of ['n1', 'n2', 'n3', 'n4']) {
    const c = physics.findCard(w, id);
    assert.ok(Math.abs((c.y - root.y) - cfg.levelGap) < 30, `${id} at level 1`);
  }
  // depth-2 grandchild two levels below.
  const g = physics.findCard(w, 'n5');
  assert.ok(Math.abs((g.y - root.y) - 2 * cfg.levelGap) < 30, 'n5 at level 2');
  // root centred over its children.
  const xs = ['n1', 'n2', 'n3', 'n4'].map(id => physics.findCard(w, id).x);
  assert.ok(Math.abs(root.x - (Math.min(...xs) + Math.max(...xs)) / 2) < 60, 'root centred over children');
  // no two cards overlap.
  let minD = Infinity;
  for (let i = 0; i < w.cards.length; i++)
    for (let j = i + 1; j < w.cards.length; j++) {
      const a = w.cards[i], b = w.cards[j];
      minD = Math.min(minD, Math.hypot(a.x - b.x, a.y - b.y));
    }
  assert.ok(minD > 150, `cards never overlap: minD=${minD.toFixed(0)}`);
});

test('拖根：根被拖动时，整棵树跟随（子节点 anchoring 在根上）', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'root', x: 0, y: 0 });
  addCard(w, { id: 'c1', x: 0, y: 0, parent: 'root' });
  addCard(w, { id: 'c2', x: 0, y: 0, parent: 'root' });
  const root = physics.findCard(w, 'root');
  const c1 = physics.findCard(w, 'c1');
  const c2 = physics.findCard(w, 'c2');
  // Grab the root and move it; the children should flow to root + their offset.
  root.dragging = true;
  w.dragId = 'root';
  root.x = 600; root.y = 400;
  for (let i = 0; i < 400; i++) step(w);
  assert.equal(root.x, 600);
  assert.equal(root.y, 400);
  assert.ok(Math.abs(c1.x - (600 + c1._ox)) < 20, `c1 followed root x: ${c1.x}`);
  assert.ok(Math.abs(c1.y - (400 + c1._oy)) < 20, `c1 followed root y: ${c1.y}`);
  assert.ok(Math.abs(c2.x - (600 + c2._ox)) < 20, `c2 followed root x: ${c2.x}`);
});

test('拖子：拖一个子节点时，根只小幅移动（树朝手方向轻微倾斜），其子树跟随光标', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'root', x: 0, y: 0 });
  addCard(w, { id: 'c1', x: 0, y: 0, parent: 'root' });
  addCard(w, { id: 'g', x: 0, y: 0, parent: 'c1' });
  const root = physics.findCard(w, 'root');
  const c1 = physics.findCard(w, 'c1');
  const g = physics.findCard(w, 'g');
  c1.dragging = true;
  w.dragId = 'c1';
  c1.x = 1000; c1.y = 0; // yank the child far to the right
  for (let i = 0; i < 500; i++) step(w);
  // Root should lean only `childLean` of the way — far from the child.
  const expectedLean = w.config.childLean * 1000;
  assert.ok(Math.abs(root.x - expectedLean) < 50, `root leans slightly: ${root.x.toFixed(0)} (expect ~${expectedLean})`);
  assert.ok(Math.abs(root.x) < 400, `root did NOT follow all the way: ${root.x.toFixed(0)}`);
  // The dragged child's subtree follows the cursor.
  assert.ok(Math.abs(g.x - (1000 + g._ox - c1._ox)) < 25, `grandchild followed child x: ${g.x.toFixed(0)}`);
  assert.ok(Math.abs(g.y - (0 + g._oy - c1._oy)) < 25, `grandchild followed child y: ${g.y.toFixed(0)}`);
});

test('钉住：钉住的卡片纹丝不动，且作为子树锚点', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'root', x: 100, y: 100, pinned: true });
  addCard(w, { id: 'c', x: 30, y: 20, parent: 'root' });
  const root = physics.findCard(w, 'root');
  const c = physics.findCard(w, 'c');
  for (let i = 0; i < 400; i++) step(w);
  assert.equal(root.x, 100, 'pinned root never moves');
  assert.equal(root.y, 100);
  // child hangs off the pinned root's real position (subroot = pinned root).
  assert.ok(Math.abs(c.y - (100 + w.config.levelGap)) < 40, `child below pinned root: ${c.y.toFixed(0)}`);
  assert.ok(Math.abs(c.x - 100) < 60, `child centred on pinned root x: ${c.x.toFixed(0)}`);
});

test('钉住：拖动过的卡片归用户所有（取消钉住后被拉回树的整齐位置）', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'root', x: 0, y: 0 });
  addCard(w, { id: 'k', x: 0, y: 0, parent: 'root' });
  const k = physics.findCard(w, 'k');
  k.pinned = true;
  k.x = 900; k.y = 700; // user dropped it far away
  for (let i = 0; i < 120; i++) step(w);
  assert.equal(k.x, 900, 'frozen while pinned');
  assert.equal(k.y, 700);
  k.pinned = false;
  for (let i = 0; i < 900; i++) step(w);
  // snaps back to its tidy offset relative to the root (~levelGap below root, same x).
  assert.ok(Math.hypot(k.x - 900, k.y - 700) > 200, `returns to the tidy layout: moved ${Math.hypot(k.x - 900, k.y - 700).toFixed(0)}px`);
  assert.ok(Math.abs(k.y - w.config.levelGap) < 40, `settled at level 1: ${k.y.toFixed(0)}`);
});

test('休眠：安定后卡片停止积分，位置逐位冻结', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'solo', x: 600, y: 400 });
  const c = w.cards[0];
  let sleptAt = -1;
  for (let i = 0; i < 3000 && sleptAt < 0; i++) {
    step(w);
    if (!c.awake) sleptAt = i;
  }
  assert.ok(sleptAt > 0, 'card eventually falls asleep');
  const at = { x: c.x, y: c.y };
  for (let i = 0; i < 600; i++) step(w);
  assert.equal(c.x, at.x, 'asleep card does not move');
  assert.equal(c.y, at.y);
  assert.equal(c.vx, 0);
  assert.equal(c.vy, 0);
});

test('整体固定：漂移开着，安定 20s 后 60s 内位移小于 30px', () => {
  const w = makeWorld();
  const tree = [
    ['root', null, 0, 0], ['n1', 'root', 160, -160], ['n2', 'root', 260, 90],
    ['n3', 'root', -80, 210], ['n4', 'root', -260, -90], ['n5', 'n4', -260, -300]
  ];
  tree.forEach(([id, parent, x, y]) => addCard(w, { id, x, y, parent }));
  for (let i = 0; i < 1200; i++) step(w);
  const base = w.cards.map(c => ({ c, x: c.x, y: c.y }));
  let maxDrift = 0;
  for (let i = 0; i < 3600; i++) {
    step(w);
    for (const b of base) maxDrift = Math.max(maxDrift, Math.hypot(b.c.x - b.x, b.c.y - b.y));
  }
  assert.ok(maxDrift < 30, `resting layout holds still: max drift ${maxDrift.toFixed(1)}px`);
});

test('拖拽中卡片位置由外部控制、不受力积分影响', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'a', x: 0, y: 0 });
  addCard(w, { id: 'b', x: 0, y: 0, parent: 'a' });
  w.cards[1].dragging = true;
  w.dragId = 'b';
  w.cards[1].x = 500;
  w.cards[1].y = 400;
  for (let i = 0; i < 60; i++) step(w);
  assert.equal(w.cards[1].x, 500);
  assert.equal(w.cards[1].y, 400);
});
