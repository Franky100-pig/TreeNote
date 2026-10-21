# cardwall（TreeNote）

<img src="docs/icon.png" width="92" align="right" alt="cardwall icon">

> The next version of taking digital notes — 但笔记得能飘。

力导向**漂浮卡片墙**笔记工具：要点级卡片 + 自由拖动 + 物理飘动（斥力 / 绳子 / 阻尼）。每幅图是一个可以命名的独立卡片树，从首页随时打开。拖过的卡片立刻定住，整块布局安顿下来就静止；只有被你碰过的地方才继续呼吸。

Electron 桌面应用，零前端框架：DOM 卡片 + SVG 连线 + CSS transform 世界容器，架构对标 Obsidian Canvas 的逆向结论（证据见仓库外 `obsidian-canvas-re/RE-obsidian-canvas.md`）。与 Obsidian 的关键差异：Canvas 没有物理、没有释放惯性；cardwall 用**绳子（只定长度）+ 斥力 + 阻力**决定卡片怎么「漂」过去。

默认黑色画布（`Cmd/Ctrl+Shift+L` 可切回纸感浅色，选择会被记住）：

![settled](docs/settled.png)

按 `F3` 打开调试叠加（锚点虚线 + 速度矢量 + 实时能量）：

![debug](docs/debug.png)

浅色主题（同一棵树，`Cmd/Ctrl+Shift+L` 切换）：

![light theme](docs/theme-light.png)

## 首页：多幅图，各自命名

按 `H` 或点工具栏左上角的 `←` 回到首页。每幅图是 `<vault>/boards/` 下的一个文件，名字存在文件里，所以列表就是「读目录」——没有会漂移的索引文件。

![home](docs/home.png)

- **新建一幅**：起名即建，空画布从双击开始
- **重命名**：点卡片上的「重命名」，或者直接在画板里点工具栏上的图名
- **删除**：文件进系统废纸篓（`shell.trashItem`），误点了能从 Finder 恢复
- 卡片数与「刚刚 / N 分钟前」按最近保存时间排在前面；启动时自动打开最近用过的那幅
- 0.3 的单文件 `vault/board.json` 会在首次启动时自动认领为「我的第一幅图」，升级不丢墙

## 下载

[GitHub Releases](https://github.com/Franky100-pig/TreeNote/releases/latest) 提供 macOS（arm64）dmg。未做代码签名，首次启动需**右键 → 打开**，或执行 `xattr -dr com.apple.quarantine /Applications/cardwall.app`。

## 开发

```bash
npm install
npm start          # 正常启动
npm test           # 物理引擎单测（15 项）
npm run smoke      # 九层自检：渲染 / 相机 / 调试 / 主题 / 交互 / 编辑 / 操作条 / 存盘 / 首页 / 读盘 + 两张截图
npm run dist       # 打包 macOS dmg
```

`npm run smoke` 会开一个隐藏窗口、用合成事件驱动真实监听器，全部通过才退出 0；末尾把落定画面写到 `smoke.png`（打包版写到系统临时目录）。

### 打包

```bash
npm run dist       # → dist/cardwall-<version>-arm64.dmg
```

未做代码签名（无 Developer ID），首次打开需在 Finder 里右键 →「打开」。国内网络建议带镜像：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
npm run dist
```

### 环境注意事项（本机实测）

- **二进制下载走国内镜像**（GitHub releases 直连会 fetch failed）：
  `cd node_modules/electron && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node install.js`
- **WorkBuddy 沙箱预设了 `ELECTRON_RUN_AS_NODE=1`**，会让 Electron 退化成纯 Node
  （症状：`require('electron').app` 为 undefined / 进入 Node REPL）。
  启动时需清除：`env -u ELECTRON_RUN_AS_NODE npm start`
- 沙箱内 Chromium 的 OS 级 sandbox 初始化会被拒，smoke 模式已内置 `--no-sandbox --disable-gpu` 与软件渲染，因此 `npm run smoke` 在受限环境中也能直接跑；正常启动仍用默认沙箱与硬件加速。

## 操作

| 动作 | 手势 |
|---|---|
| 回首页 / 打开别的图 | `H` 或工具栏左上角 `←`；点任意卡片打开 |
| 重命名当前图 | 点工具栏上的图名（或首页卡片上的「重命名」） |
| 编辑卡片 | 鼠标悬停卡片 → 点操作条上的 ✎，**或直接双击卡片**（Escape 取消，标题里 Enter 提交） |
| 新建子节点 | 鼠标悬停卡片 → 点操作条上的 ＋（新卡生在该卡右侧、直接进编辑） |
| 删除卡片 | 鼠标悬停卡片 → 点操作条上的 ✕（或选中后按 Delete / Backspace；子卡改挂到祖父卡） |
| 新建卡片 | 双击空白处（自动挂到 320px 内最近的卡片，否则为根卡） |
| 改挂父级 | 把卡片拖到另一张卡片上（禁止挂到自己的后代，避免成环） |
| 自由拖动 | 按住卡片拖到任意位置，**松手即定**（无惯性、无回弹）；手里的卡跟手，其余被**绳子**拽着走（只在被拉远时拉、拉近时绳子变松，所以是拖着走而不是整块平移）；邻居按下式「尾流」按距离浮动，越近漂得越多 |
| 重新漂浮 | 选中卡片按 `P`：交还给力场，被绳子拉回自己的长度上（鼠标停在卡上也照样生效） |
| 平移 / 缩放 | 拖动空白处 / 滚轮（以光标为锚点，缩放范围 0.2–2.5） |
| 调试叠加 | `F3`（Mac 上可能是 Fn+F3）或 `Cmd+Shift+D`：fps、卡数、仿真时间、scale、峰值速度、机械能、锚点、速度矢量 |
| 切换主题 | `Cmd/Ctrl+Shift+L`：黑色画布 ⇄ 纸感浅色，偏好存 localStorage |

悬停某张卡片时，卡片右上角浮出操作条（✎ 编辑 / ＋ 新节点 / ✕ 删除），同时该卡片被临时**冻住**（`hover` 标志，不参与物理积分）以防操作条在漂浮中滑走、点不准；鼠标移开即恢复漂浮。编辑态下操作条自动隐藏，避免挡住正在输入的文字。

编辑时物理世界会暂停（否则文字在光标下滑动），提交后恢复。

### 自由放置 vs 自动布局

自动布局只是**初值建议**：新建的卡片会落在环位上并被力场整理成树。但你一旦碰过某张卡片——拖动它，或者在空白处新建它——它就被**钉住**（`pinned`）：不受绳子拉、不参与漂移、不积分，停在手放下的那一格，重启后依旧在原处（图文件里带 `pinned` 字段）。想让它回到力场里，选中按 `P`。

没有被钉住的卡片也不会一直乱飘：**安静 60 步（速度与合力都低于阈值）就睡着**（`awake = false`），停止积分、位置逐位冻结，直到某个力真的超过阈值才被唤醒。所以安顿下来的布局是固定的一堵墙，而不是一直在抖的一堆卡片；漂移降到每张卡约 18 秒一次，作用只是偶尔叫醒一张卡让它轻轻飘一下——一次涟漪，不是持续震颤。实测示例树静置 60 秒的最大位移从 21.4px 降到 4.0px。

拖动的语义因此是：**只有你手里那张卡跟手，其余的都交给物理**。每张卡被一根**定长绳子**拴着（根卡拴在世界原点，子卡拴在父卡上），绳子只定长度、不定角度，所以子卡可以绕着父卡摆——被拖的父卡把它们**拽着走**而不是整块平移；邻居则被你手里的卡激起的「尾流」按距离推着漂（近的多、远的不动），像把石头丢进水里。

绳子的问题是物理事实：**角度自由 ⇒ 切向没有回复力**（切向刚度只有 `F/r`，400px 处约 0.6），整块墙会绕着各自的拴点慢慢公转，实测 15 秒后还有 6–8 px/s，加大阻尼只会更慢。所以加了很弱的一层**角度记忆**（`anchorStiffness` 30，比绳子 60 软一半）：拖的时候照样看得见摆动，松手后它把方向慢慢收回原处。实测 6 卡树拖 400px：**肉眼静止 1.9–3.3 秒、全部休眠 3.3–5.1 秒**，此后零蠕动（位移 < 0.1px / 5s）。把 `anchorStiffness` 设成 0 就是纯自由摆动的绳子——好看，但整块墙要半分钟才停。

## 主题

所有颜色都从 `styles.css` 顶部的语义 token 取（`--bg` / `--surface` / `--ink` / `--edge` / `--accent-*` …），一套 token 定义就是一种主题：

- `:root` 是默认的深色（纯黑画布 `#000000` + `#16161a` 卡片），也是启动即见的样子
- `[data-theme="light"]` 覆盖同一组 token，还原最初的纸感配色
- 首帧由 `renderer/theme-boot.js` 在 `<head>` 里抢先应用（CSP 禁内联脚本，故独立成文件）；如果等到 `app.js` 再设，浅色主题会先闪一下黑

想加第三套主题（比如高对比 / 护眼），复制一份 token 块 + 在 `applyTheme` 里多认一个名字即可，不需要碰任何组件样式。

## 物理参数（`renderer/physics.js` 的 `CONFIG`）

| 参数 | 值 | 说明 |
|---|---|---|
| `dt` / `damping` / `maxSpeed` | 1/60 s / 0.93 / 3000 | 固定步长、每步阻尼（负责把摆动耗散掉 + 漂动软度）、限速 |
| `repulsion` / `repulsionCutoff` | 90000 / 800px | `a = repulsion / d`，中心距排斥（柔和，像水不是弹簧） |
| `childRopeLength` | 200px | 绳长：根卡拴到世界原点、子卡拴到父卡，距离锁死、角度自由 |
| `ropeStiffness` | 60 | 绳子拉力刚度。子卡**只拉不推**（松弛时拉力为 0，可以贴上去）；根卡双向拴住，否则整面墙会整体漂走 |
| `ropeDampRatio` | 1.0 | **径向**阻尼比（临界）：沿绳方向的速度分量被吃掉，所以不会像弹簧那样来回弹 |
| `swingDamp` | 0.4 | **切向**阻尼系数（相对径向）：0 = 摆得最久，1 = 摆动和归位一样快变闷 |
| `anchorStiffness` | 30 | 角度记忆：额外把卡往「标称位置方向」拉一点点（比绳子软一半）。设 0 = 纯自由摆动的绳子，但整面墙要半分钟才停 |
| `wakeRadius` / `wakeStrength` | 520px / 1.5 | 拖动尾流：手里的卡按距离把邻居推着漂，纯推力不会振荡 |
| `ringBaseRadius` / `ringSpacing` | 220 / 60 | 根卡环半径（也是根卡的绳长）、每多一个同层卡片的增量 |
| `driftImpulse` / `driftChance` | 14 px/s / 0.0009 | 偶发漂移（seeded，可复现；约 18 秒一次，同时负责唤醒） |
| `sleepSpeed` / `sleepForce` / `sleepSteps` | 0.6 px/s / 30 px/s² / 60 步 | 休眠判据：够慢、合力够小、连续够久 → 停止积分。阈值比弹簧时代宽，因为吊着的卡始终背着约 600 px/s² 的平衡张力 |

静止距离不是绳长：排斥会把静止点外推，单子卡的解析平衡是 `K·(d−L) = repulsion/d`（K = `ropeStiffness + anchorStiffness`），单测里用这个解析解做回归——`childRopeLength` 200px 的卡实际停在 197px 附近，是排斥外推的正常结果，不是 bug。

绳子没有「刚度合成」这一说：它不提供方向回复力。要让一棵子树整体跟着父卡走，靠的是**绳子把父卡的位移传下去**（父卡动了，子卡的绳子就被拽斜，拉力也就有了横向分量）；松手之后摆动靠 `swingDamp` 和 `anchorStiffness` 收。

## 数据存放

- 默认路径：`~/Library/Application Support/cardwall/vault/boards/<id>.json`（macOS），一幅图一个文件
- 图库没有索引文件：**目录本身就是索引**，每个文件自带 `name`，所以删掉/拷进一个 json 就等于删掉/加进一幅图
- 文件名是 `b` + 36 进制的建图时间 + 随机后缀（`bmg3k2x9f1` 这种），只接受 `[A-Za-z0-9_-]` 且不超过 40 字，杜绝路径穿越
- 写入是原子的：先写 `<id>.json.tmp` 再 rename，上一版保留为 `<id>.json.bak`
- 重命名只改文件里的 `name`（不搬文件、不改 id），所以正在打开的图不会因为改名而丢引用
- 删除走系统回收站（`shell.trashItem`），可以撤销；当前打开的那幅被删掉时自动退回图库并打开另一幅
- 0.3 的单文件 `vault/board.json` 会在首次启动时自动迁移成 `boards/<id>.json`（名字记为「我的第一幅图」），迁移后原件改名留底
- 首次启动什么都没用时，图库空着 → 自动建「我的第一幅图」并塞进示例树，改动后自动保存（600ms 防抖）
- 调试/测试可用 `CARDWALL_VAULT_DIR=/tmp/xxx` 覆盖；`npm run smoke` 默认使用一次性临时目录
- 主进程会 sanitize 读入的 board：丢弃未知字段、截断超长文本、拒绝重复 id 与悬空/自引用父级；`boards:save` 只接受 blob，**不会**让渲染进程改掉磁盘上的名字

## 结构

```
main.js                 Electron 主进程：窗口、图库 IPC、vault 原子写、九层 smoke 断言
preload.js              contextBridge：listBoards / createBoard / openBoard / saveBoard / renameBoard / deleteBoard
index.html styles.css    外壳、主题 token（深色默认 + 浅色覆盖）、卡片/边/调试面板样式
renderer/theme-boot.js  首帧应用已保存的主题（避免浅色闪黑）
renderer/physics.js     力导向积分器（UMD，Node 单测 + 浏览器共用）
renderer/app.js         世界容器、边几何、固定步长循环、相机、编辑、持久化接线
renderer/interaction.js 平移 / 锚点缩放 / 拖拽（钉住 + 子树漂浮）/ 改挂
renderer/debug.js       F3 叠加
renderer/sample.js      首次启动的示例树
build/icon.svg          图标源文件（1024 画布，圆角底板 + 卡片树）
build/icon.icns         由上面的 SVG 栅格化后 iconutil 生成，electron-builder 取用
test/physics.test.mjs   15 项单测
```

## 当前进度

- [x] C1 脚手架（Electron 最小窗口）
- [x] C2 物理核心（力导向集成器 + 单测）
- [x] C3 渲染骨架（DOM 卡 + SVG 贝塞尔边 + 固定步长 rAF）
- [x] C4 交互（平移/锚点缩放/拖拽 + 相机补间/安定取景）
- [x] C5 卡片编辑（选中/双击编辑/新建/删除/拖拽改挂）
- [x] C6 持久化（JSON vault + IPC + 原子写）
- [x] C7 手感调参 + F3 调试叠加
- [x] C8 dmg 打包（electron-builder，arm64）
- [x] C9 README/截图/tag
- [x] C10 深色主题（纯黑画布 + `Cmd/Ctrl+Shift+L` 切换 + 首帧无闪）
- [x] C11 应用图标（卡片树字形，SVG 源 + icns）+ 首个 Release
- [x] C12 自由放置（拖过即定住、`P` 交还力场）
- [x] C13 固定布局（休眠 + 偶发涟漪）+ 拖动时子树漂浮而非刚性平移

## 许可

MIT
