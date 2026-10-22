import { test } from 'node:test';
import assert from 'node:assert/strict';
import physics from '../renderer/physics.js';

const { createWorld, addCard, step, totalEnergy, computeTreeLayout, tidy } = physics;

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
  w.tidy = true; // pull active so the spring can dissipate energy
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
  // NOTE: computeTreeLayout packs children in id-sorted order (position-
  // independent, so layout is a pure function of tree structure), so we check
  // against the actual min/max rather than hard-coding the pair.
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
  w.tidy = true; // pull active so the board settles into the tidy tree
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
  w.tidy = true; // pull active so children anchor on the dragged root
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
  w.tidy = true; // pull active so the lean + subtree-follow show up
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
  w.tidy = true; // pull active so the unpinned child anchors on the pinned root
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
  w.tidy = true; // pull active so the unpinned card snaps to the tidy layout
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
  w.tidy = true; // pull active so the tree holds its shape against drift
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

test('松手即自由：拖子释放后停在落点，整面保持自由不自动重排', () => {
  const w = makeWorld({ drift: false });
  w.tidy = true; // board starts tidy, settles into the tree
  addCard(w, { id: 'root', x: 0, y: 0 });
  addCard(w, { id: 'c1', x: 0, y: 0, parent: 'root' });
  addCard(w, { id: 'c2', x: 0, y: 0, parent: 'root' });
  addCard(w, { id: 'c3', x: 0, y: 0, parent: 'root' });
  const root = physics.findCard(w, 'root');
  const c1 = physics.findCard(w, 'c1');
  const c2 = physics.findCard(w, 'c2');
  for (let i = 0; i < 800; i++) step(w); // settle into the tidy tree
  // drag c2 far away and drop it
  const drop = { x: root.x + 520, y: root.y + 360 };
  c2.x = drop.x; c2.y = drop.y;
  w.dragId = null; // release — onCardPlaced sets tidy = false (FREE)
  w.tidy = false;
  const c1Before = { x: c1.x, y: c1.y };
  const rootBefore = { x: root.x, y: root.y };
  for (let i = 0; i < 1500; i++) step(w);
  // the dropped child holds its spot (free, no snap back)
  assert.ok(Math.hypot(c2.x - drop.x, c2.y - drop.y) < 8, `dropped child stays put: moved ${Math.hypot(c2.x - drop.x, c2.y - drop.y).toFixed(1)}px`);
  // and the rest of the board did NOT auto re-tidy around it — it is free too
  assert.ok(Math.hypot(c1.x - c1Before.x, c1.y - c1Before.y) < 8, `sibling stays put (no re-tidy): ${Math.hypot(c1.x - c1Before.x, c1.y - c1Before.y).toFixed(1)}`);
  assert.ok(Math.hypot(root.x - rootBefore.x, root.y - rootBefore.y) < 8, `root stays put (no re-tidy): ${Math.hypot(root.x - rootBefore.x, root.y - rootBefore.y).toFixed(1)}`);
});

test('一键整洁：自由摆放的卡片被重新排成整齐树', () => {
  const w = makeWorld({ drift: false });
  addCard(w, { id: 'root', x: 0, y: 0 });
  addCard(w, { id: 'c1', x: 500, y: -400, parent: 'root' });
  addCard(w, { id: 'c2', x: -300, y: 250, parent: 'root' });
  addCard(w, { id: 'c3', x: 420, y: 380, parent: 'root' });
  addCard(w, { id: 'g', x: -260, y: -300, parent: 'c1' });
  const root = physics.findCard(w, 'root');
  const rootBefore = { x: root.x, y: root.y };
  // everything free (scattered) until the user hits tidy
  w.tidy = false;
  for (let i = 0; i < 200; i++) step(w);
  const cfg = w.config;
  // press the tidy button (physics.tidy re-flows the whole board)
  tidy(w);
  for (let i = 0; i < 1500; i++) step(w);
  // anchored on the root's original spot (reconstructs in place)
  assert.ok(Math.hypot(root.x - rootBefore.x, root.y - rootBefore.y) < 30, `root anchored in place: ${Math.hypot(root.x - rootBefore.x, root.y - rootBefore.y).toFixed(1)}`);
  // depth-1 siblings share a level at ~levelGap below root
  for (const id of ['c1', 'c2', 'c3']) {
    const c = physics.findCard(w, id);
    assert.ok(Math.abs((c.y - root.y) - cfg.levelGap) < 30, `${id} at level 1: dy=${(c.y - root.y).toFixed(0)}`);
  }
  // grandchild two levels below root
  const g = physics.findCard(w, 'g');
  assert.ok(Math.abs((g.y - root.y) - 2 * cfg.levelGap) < 30, `grandchild at level 2: dy=${(g.y - root.y).toFixed(0)}`);
  // root centred over its children
  const xs = ['c1', 'c2', 'c3'].map(id => physics.findCard(w, id).x);
  assert.ok(Math.abs(root.x - (Math.min(...xs) + Math.max(...xs)) / 2) < 60, 'root centred over children');
  // no two cards overlap
  let minD = Infinity;
  for (let i = 0; i < w.cards.length; i++)
    for (let j = i + 1; j < w.cards.length; j++)
      minD = Math.min(minD, Math.hypot(w.cards[i].x - w.cards[j].x, w.cards[i].y - w.cards[j].y));
  assert.ok(minD > 150, `cards never overlap: minD=${minD.toFixed(0)}`);
});

test('松手后无阻尼滑行：自由态下别的节点残余速度必须衰减归零（修"一直往下漂"）', () => {
  const w = makeWorld({ drift: false });
  w.tidy = true; // 载入即整齐树；拖拽时整棵树被拉力带动
  addCard(w, { id: 'root', x: 0, y: 0 });
  addCard(w, { id: 'c1', x: 0, y: 0, parent: 'root' });
  addCard(w, { id: 'c2', x: 0, y: 0, parent: 'root' });
  addCard(w, { id: 'c3', x: 0, y: 0, parent: 'root' });
  const root = physics.findCard(w, 'root');
  const c2 = physics.findCard(w, 'c2');
  for (let i = 0; i < 800; i++) step(w); // 先收敛成整齐树
  // 模拟拖拽 c2 并移动（像指针那样）：c2 被 external 定位，其余被拉力/倾斜带着动
  c2.dragging = true;
  w.dragId = 'c2';
  c2.x = 700; c2.y = 500;
  for (let i = 0; i < 60; i++) step(w); // 这一步会给 root/c1/c3 注入残余速度
  const maxResidual = Math.max(
    ...w.cards.filter(c => c.id !== 'c2').map(c => Math.hypot(c.vx, c.vy))
  );
  assert.ok(maxResidual > 5, `拖拽确实让别的节点产生了残余速度（${maxResidual.toFixed(1)} px/s）——否则本测试无意义`);
  // 松手：interaction.endPointer 会清零被抓卡的速度并令整面自由
  c2.dragging = false;
  c2.vx = 0; c2.vy = 0;
  w.dragId = null;
  w.tidy = false;
  const atRelease = w.cards.map(c => ({ c, x: c.x, y: c.y }));
  for (let i = 0; i < 2000; i++) step(w);
  // 1) 所有卡速度必须衰减到接近 0（不再匀速滑行）
  const maxSpeed = Math.max(...w.cards.map(c => Math.hypot(c.vx, c.vy)));
  assert.ok(maxSpeed < 1, `松手后所有节点速度收敛归零: maxSpeed=${maxSpeed.toFixed(3)} px/s`);
  // 2) 每张卡停在落点附近，没有无限漂移（位置有界）
  let maxDrift = 0;
  for (const b of atRelease) maxDrift = Math.max(maxDrift, Math.hypot(b.c.x - b.x, b.c.y - b.y));
  assert.ok(maxDrift < 10, `松手后所有节点停在落点附近（不再漂走）: maxDrift=${maxDrift.toFixed(1)}px`);
});
