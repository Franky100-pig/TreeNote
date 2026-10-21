/**
 * Sample tree — a small note-fragment card wall, seeded into the first board on
 * a fresh install. Positions are initial only; the physics integrator organizes
 * the tree (rope lengths + repulsion decide the final geometry).
 */
window.SAMPLE_TREE = [
  { id: 'root', title: '漂浮卡片墙', note: 'cardwall · 力导向演示', parent: null, x: 0, y: 0 },
  { id: 'n1', title: '节点 = 一个要点', note: '可拖拽的片段，不是整篇笔记', parent: 'root', x: 160, y: -160 },
  { id: 'n2', title: '父子之间是一根绳子', note: '只定长度，不定角度，所以能摆', parent: 'root', x: 260, y: 90 },
  { id: 'n3', title: '拖动时整棵树跟着漂', note: '手里的卡跟手，其余被绳子拽着走', parent: 'root', x: -80, y: 210 },
  { id: 'n4', title: '松手后自己会停', note: '阻力吃掉摆动，静止后位置就锁住', parent: 'root', x: -260, y: -90 },
  { id: 'n5', title: 'H 键回到首页', note: '每幅图单独命名、随时打开', parent: 'n4', x: -260, y: -300 }
];
