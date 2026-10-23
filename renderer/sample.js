/**
 * Sample tree — a small note-fragment card wall, seeded into the first board on
 * a fresh install. Positions are initial only; the tidy-tree layout decides the
 * final geometry (same depth shares a level, parents centre over children).
 */
window.SAMPLE_TREE = [
  { id: 'root', title: '漂浮卡片墙', note: 'cardwall · 整齐树演示', parent: null, x: 0, y: 0 },
  { id: 'n1', title: '节点 = 一个要点', note: '可拖拽的片段，不是整篇笔记', parent: 'root', x: 160, y: -160 },
  { id: 'n2', title: '静止时是整齐树', note: '同层对齐，父节点居中在上', parent: 'root', x: 260, y: 90 },
  { id: 'n3', title: '拖根节点：整棵树跟着走', note: '子节点自动重排，层次一眼可见', parent: 'root', x: -80, y: 210 },
  { id: 'n4', title: '拖子节点：根只轻轻偏一下', note: '子树跟手，其余微微倾斜', parent: 'root', x: -260, y: -90 },
  { id: 'n5', title: 'H 键回到首页', note: '每幅图单独命名、随时打开', parent: 'n4', x: -260, y: -300 }
];
