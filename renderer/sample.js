/**
 * Sample tree for the C3 skeleton — a small note-fragment card wall.
 * Positions are initial only; the physics integrator organizes the tree.
 * Editing/persistence arrive in C5/C6.
 */
window.SAMPLE_TREE = [
  { id: 'root', title: '漂浮卡片墙', note: 'cardwall · 力导向演示', parent: null, x: 0, y: 0 },
  { id: 'n1', title: '节点 = 一个要点', note: '可拖拽的片段，不是整篇笔记', parent: 'root', x: 160, y: -160 },
  { id: 'n2', title: '父子之间有弹簧', note: '树形结构一目了然', parent: 'root', x: 260, y: 90 },
  { id: 'n3', title: '整体布局是固定的', note: '安顿下来就静止，不再一直发抖', parent: 'root', x: -80, y: 210 },
  { id: 'n4', title: '拖动时其余卡片一起漂', note: '被拖的那张跟手，其余靠弹簧带过去', parent: 'root', x: -260, y: -90 },
  { id: 'n5', title: '环位 = 父卡周围的锚点', note: '排斥力留出呼吸空间', parent: 'n4', x: -260, y: -300 }
];
