# cardwall（TreeNote）

[中文](README.md) · **English** | [English](README.en.md)

<img src="docs/icon.png" width="92" align="right" alt="cardwall icon">

> TreeNote —— 树状笔记的下一种形态：要点能自己排成层次。

力导向**整齐树卡片墙**笔记工具。要点拆成卡片，父子关系自动排成层次分明的树状图：同层对齐、父节点居中在上。随手一拖就能看清整棵树的层次分布，松手就安顿成干净的一张图。

多幅图各自命名，从首页随时打开。

![settled](docs/settled.png)

## 首页：多幅图，各自命名

`H` 或工具栏左上角 `←` 回到首页。起名即建，随时切换；删除的文件进系统废纸篓，能反悔。

![home](docs/home.png)

## 下载

[GitHub Releases](https://github.com/Franky100-pig/TreeNote/releases/latest) 提供 macOS（arm64）dmg。未做代码签名，首次启动需**右键 → 打开**，或执行 `xattr -dr com.apple.quarantine /Applications/cardwall.app`。

## 操作

| 动作 | 手势 |
|---|---|
| 回首页 / 打开别的图 | `H` 或工具栏左上角 `←`；点任意卡片打开 |
| 重命名当前图 | 点工具栏上的图名（或首页卡片上的「重命名」） |
| 编辑卡片 | 悬停卡片 → 点操作条上的 ✎，**或直接双击卡片**（Escape 取消，Enter 提交） |
| 新建子节点 | 悬停卡片 → 点操作条上的 ＋（新卡生在该卡右侧、直接进编辑） |
| 删除卡片 | 悬停卡片 → 点操作条上的 ✕（或选中后按 Delete / Backspace） |
| 新建卡片 | 双击空白处（自动挂到 320px 内最近的卡片，否则为根卡） |
| 改挂父级 | 把卡片拖到另一张卡片上（禁止挂到自己的后代，避免成环） |
| **拖动根节点** | 按住**根卡**拖到任意位置：整棵树以你手里的根为锚**重新排成整齐树**，子节点自动重排，层次一眼可见 |
| **拖动子节点** | 按住**某个子卡**拖：它和**整条子树**跟手，其余的树只朝手的方向**轻微倾斜**（根只挪约 12%），不会整块平移 |
| 钉住 / 解钉 | 选中卡片按 `P`：钉住 = 完全冻结、退出自动布局（你可以像 Obsidian 那样自由摆放）；解钉 = 重新回到整齐树的自动布局里（鼠标停在卡上也照样生效）。新建 / 拖过的卡默认不在钉住态，归树所有 |
| 平移 / 缩放 | 拖动空白处 / 滚轮（以光标为锚点，0.2–2.5） |
| 调试叠加 | `F3` 或 `Cmd+Shift+D`：fps、卡数、仿真时间、scale、峰值速度、机械能、树目标、速度矢量 |
| 切换主题 | `Cmd/Ctrl+Shift+L`：黑色画布 ⇄ 纸感浅色，偏好会被记住 |

悬停卡片时右上角浮出操作条（✎ / ＋ / ✕），同时该卡被临时**冻住**（不参与物理积分），免得操作条在漂浮中滑走、点不准。编辑时物理世界暂停，提交后恢复。

## 物理：整齐树，不是绳子

每一张卡片都有一个**确定的树状目标位置**（tidy-tree / Reingold–Tilford 风格，叶子打包法）：

- **同层对齐**：同一深度的节点共享一条水平线（父在上、子在下，`levelGap` 间距）
- **父居中于子**：父节点落在它最外侧两个子节点的中点上
- **子树不重叠**：叶子沿一条共享游标从左到右排开，间距 `nodeGap`

然后每张未被钉住的卡片被一根**临界阻尼弹簧**拉向自己的目标（`k = 40`，临界阻尼系数 `2√k ≈ 12.6`）——约 0.6 秒无过冲地贴上去，**不会像刚性平移那样整枝一起平移**：每张卡按各自的距离独立贴位，整棵树就这样"解"成一张干净的图。

布局是**确定性的**：同样的结构永远排成同样的图，不靠随机。静止时整面墙就是一张整齐的树状图。

### 三种拖动手感

- **拖根节点**：整棵树以你手里的根为锚重新排布，子节点跟着重排成树
- **拖子节点**：它的整条子树跟手（作为一个整齐的小单元），其余的树只朝手的方向**倾斜 `childLean = 0.12`**——根大约只挪动手移量的 12%，这就是「移动子的时候根小幅度移动」
- **被拖卡片的后代**：自动以光标为锚重排，所以抓一个中间节点，它的整棵子树都跟手

### 关键参数（`renderer/physics.js` 的 `CONFIG`）

| 参数 | 值 | 说明 |
|---|---|---|
| `dt` / `k` / `maxSpeed` | 1/60 s / 40 / 3000 | 固定步长、拉向树目标的弹簧刚度、限速 |
| `nodeGap` / `levelGap` / `rootGap` | 300 / 220 / 360 px | 叶子横向间距 / 层与层纵向间距 / 多棵树之间的间隔 |
| `childLean` | 0.12 | 拖子节点时，其余的树朝手方向倾斜的比例（根只挪约 12%） |
| `repulsion` / `repulsionCutoff` | 22000 / 520 px | 防重叠的软排斥，**只在拖动时生效**（`a = repulsion / d`） |
| `wakeRadius` / `wakeStrength` | 520 / 0.4 | 拖动尾流：手里的卡把邻居按距离推着让开 |
| `driftImpulse` / `driftChance` | 3 px/s / 0.0002 | 静止时极弱的、可复现的布朗"呼吸"（偶发唤醒一张卡轻轻飘一下） |
| `sleepSpeed` / `sleepForce` / `sleepSteps` | 0.6 px/s / 30 px/s² / 60 步 | 休眠判据：够慢、合力够小、连续够久 → 停止积分 |

静止时卡片正好落在树目标上（弹簧归零、没有别的力），所以整面墙是**固定的一张图**，不是一直在抖的一堆卡片；且因为排斥只在拖动时生效，安静的卡片合力低于休眠阈值，会真正睡着。

### 钉住是保护，不是枷锁

`pinned` 的意思是「这张卡你亲手摆过，先停在它该在的地方」——它**退出自动布局**，完全冻结，像 Obsidian 那样自由摆放。它的后代挂在它真实位置之下。

- **新建的卡**是钉住的：你刚把它放在那儿，它就该留在那儿
- **你一拖动某张卡**，它和**整条子树**就永久解冻 —— 你已把它交给树状布局，以后拖它的父卡就能带着它走
- **`P` 键**是手动开关，两个方向都能用，且连子树一起切（一张回到布局、子卡却还钉着的卡，依然带不动）

这就是「一个节点能不能带动别的节点」的答案：能，但前提是那张卡不在钉住状态。

### 布局会安定下来

自动布局是确定的，不是随机初值。没被钉住的卡片安静 60 步就**睡着**，停止积分、位置逐位冻结，直到某个力真的超过阈值才被唤醒。所以安顿下来的布局是固定的一堵墙，而不是一直在抖的一堆卡片。漂移只是偶尔叫醒一张卡轻轻飘一下——一次涟漪，不是持续震颤。

## 数据存放

- 默认路径：`~/Library/Application Support/cardwall/vault/boards/<id>.json`（macOS），一幅图一个文件
- 图库**没有索引文件**：目录本身就是索引，每个文件自带 `name`
- 写入是原子的：先写 `.tmp` 再 rename，上一版保留为 `.bak`
- 重命名只改文件里的 `name`（不搬文件、不改 id），正在打开的图不会丢引用
- 删除走系统回收站（`shell.trashItem`），可以撤销
- 0.3 的单文件 `vault/board.json` 自动迁移成「我的第一幅图」，升级不丢墙
- 主进程会 sanitize 读入的 board：丢弃未知字段、截断超长文本、拒绝重复 id 与悬空 / 自引用父级
- 调试可用 `CARDWALL_VAULT_DIR=/tmp/xxx` 覆盖

## 开发

```bash
npm install
npm start          # 正常启动
npm test           # 物理引擎单测（12 项）
npm run smoke      # 十层自检：渲染 / 相机 / 调试 / 主题 / 交互 / 编辑 / 操作条 / 存盘 / 首页 / 读盘
npm run dist       # 打包 macOS dmg → dist/cardwall-<version>-arm64.dmg
```

`npm run smoke` 会开一个隐藏窗口、用合成事件驱动真实监听器，全部通过才退出 0。

国内网络打包建议带镜像（否则 electron zip 直连会超时）：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
npm run dist
```

### 结构

```
main.js                 Electron 主进程：窗口、图库 IPC、vault 原子写、十层 smoke 断言
preload.js              contextBridge：listBoards / createBoard / openBoard / saveBoard / renameBoard / deleteBoard
index.html styles.css    外壳、主题 token、卡片 / 边 / 调试面板样式
renderer/theme-boot.js  首帧应用已保存的主题（避免浅色闪黑）
renderer/physics.js     整齐树布局 + 临界阻尼弹簧积分器（UMD，Node 单测 + 浏览器共用）
renderer/app.js         世界容器、边几何、固定步长循环、相机、编辑、持久化接线
renderer/interaction.js 平移 / 锚点缩放 / 拖拽 / 改挂
renderer/debug.js       F3 叠加
renderer/sample.js      首次启动的示例树
build/icon.svg          图标源文件；build/icon.icns 由它栅格化生成
test/physics.test.mjs   12 项单测
```

主题全走 `styles.css` 顶部的语义 token（`--bg` / `--surface` / `--ink` / `--edge` …），一套 token 定义就是一种主题：`:root` 是默认深色（纯黑画布），`[data-theme="light"]` 覆盖同一组 token 得到纸感浅色。想加第三套主题，复制一份 token 块 + 在 `applyTheme` 里多认一个名字即可，不用碰任何组件样式。

## 许可

MIT
