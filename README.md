# cardwall（TreeNote）

[中文](README.md) · **English** | [English](README.en.md)

<img src="docs/icon.png" width="92" align="right" alt="cardwall icon">

> The next version of taking digital notes — 但笔记得能飘。

力导向**漂浮卡片墙**笔记工具。要点拆成卡片，拖到哪就留在哪；没碰过的卡片被一根**定长绳子**拴着，随手一拖会跟着晃，但松手就安顿下来。

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
| 自由拖动 | 按住卡片拖到任意位置，**松手即定**；手里的卡跟手，其余被绳子拽着走，邻居按距离被「尾流」推着漂 |
| 重新漂浮 | 选中卡片按 `P`：交还给力场，被绳子拉回自己的长度上（鼠标停在卡上也照样生效） |
| 平移 / 缩放 | 拖动空白处 / 滚轮（以光标为锚点，0.2–2.5） |
| 调试叠加 | `F3` 或 `Cmd+Shift+D`：fps、卡数、仿真时间、scale、峰值速度、机械能、锚点、速度矢量 |
| 切换主题 | `Cmd/Ctrl+Shift+L`：黑色画布 ⇄ 纸感浅色，偏好会被记住 |

悬停卡片时右上角浮出操作条（✎ / ＋ / ✕），同时该卡被临时**冻住**（不参与物理积分），免得操作条在漂浮中滑走、点不准。编辑时物理世界暂停，提交后恢复。

## 物理：绳子，不是弹簧

每张卡被一根**定长绳子**拴着 —— 根卡拴在世界原点，子卡拴在父卡上。绳子只定长度、不定角度，所以：

- 子卡能绕着父卡**摆**，被拖的父卡把它们**拽着走**，不是整块刚性平移
- 绳子**只拉不推**（贴上去时变松），所以不会有弹簧那种来回弹
- 阻力分两半：径向临界阻尼（零回弹）+ 一点切向阻尼（像湿绳子）

有个绕不过去的物理事实：**角度自由 ⇒ 切向没有回复力**（切向刚度只有 `F/r`，400px 处约 0.6），整块墙会绕各自拴点慢慢公转。所以加了很弱的一层**角度记忆**（`anchorStiffness` 30，比绳子 60 软一半）：拖的时候照样看得见摆动，松手后它把方向慢慢收回原处。

实测 6 卡树拖 400px：**肉眼静止 1.9–3.3 秒、全部休眠 3.3–5.1 秒**，此后零蠕动（< 0.1px / 5s）。把 `anchorStiffness` 设成 0 就是纯自由摆动的绳子——好看，但整块墙要半分钟才停。

### 关键参数（`renderer/physics.js` 的 `CONFIG`）

| 参数 | 值 | 说明 |
|---|---|---|
| `dt` / `damping` / `maxSpeed` | 1/60 s / 0.93 / 3000 | 固定步长、每步阻尼（把摆动耗散掉）、限速 |
| `repulsion` / `repulsionCutoff` | 90000 / 800px | `a = repulsion / d`，中心距排斥（像水不是弹簧） |
| `childRopeLength` | 200px | 绳长：根卡拴世界原点、子卡拴父卡，距离锁死、角度自由 |
| `ropeStiffness` | 60 | 绳子拉力刚度。子卡只拉不推；根卡双向拴住，否则整面墙会整体漂走 |
| `ropeDampRatio` | 1.0 | **径向**阻尼比（临界）：沿绳方向的速度分量被吃掉，所以不会来回弹 |
| `swingDamp` | 0.4 | **切向**阻尼：0 = 摆得最久，1 = 摆动和归位一样快变闷 |
| `anchorStiffness` | 30 | 角度记忆：把卡往标称位置方向拉一点点。设 0 = 纯自由摆 |
| `wakeRadius` / `wakeStrength` | 520px / 1.5 | 拖动尾流：手里的卡按距离把邻居推着漂，纯推力不会振荡 |
| `ringBaseRadius` / `ringSpacing` | 220 / 60 | 根卡环半径（也是根卡的绳长）、每多一个同层卡片的增量 |
| `driftImpulse` / `driftChance` | 14 px/s / 0.0009 | 偶发漂移（seeded，可复现；约 18 秒一次，同时负责唤醒） |
| `sleepSpeed` / `sleepForce` / `sleepSteps` | 0.6 px/s / 30 px/s² / 60 步 | 休眠判据：够慢、合力够小、连续够久 → 停止积分 |

静止距离不是绳长：排斥会把静止点外推，单子卡的解析平衡是 `K·(d−L) = repulsion/d`（K = `ropeStiffness + anchorStiffness`），单测用这个解析解做回归 —— `childRopeLength` 200px 的卡实际停在 197px 附近，是排斥外推的正常结果，不是 bug。

### 布局会安定下来

自动布局只是**初值建议**。你一旦碰过某张卡片（拖过它、或在空白处新建它），它就被**钉住**（`pinned`）：不受绳子拉、不参与漂移、不积分，停在手放下的那一格，重启后依旧在原处。按 `P` 交还给力场。

没被钉住的卡片安静 60 步就**睡着**，停止积分、位置逐位冻结，直到某个力真的超过阈值才被唤醒。所以安顿下来的布局是固定的一堵墙，而不是一直在抖的一堆卡片。漂移降到每张卡约 18 秒一次，作用只是偶尔叫醒一张卡轻轻飘一下——一次涟漪，不是持续震颤。

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
npm test           # 物理引擎单测（15 项）
npm run smoke      # 九层自检：渲染 / 相机 / 调试 / 主题 / 交互 / 编辑 / 操作条 / 存盘 / 首页 / 读盘
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
main.js                 Electron 主进程：窗口、图库 IPC、vault 原子写、九层 smoke 断言
preload.js              contextBridge：listBoards / createBoard / openBoard / saveBoard / renameBoard / deleteBoard
index.html styles.css    外壳、主题 token、卡片 / 边 / 调试面板样式
renderer/theme-boot.js  首帧应用已保存的主题（避免浅色闪黑）
renderer/physics.js     力导向积分器（UMD，Node 单测 + 浏览器共用）
renderer/app.js         世界容器、边几何、固定步长循环、相机、编辑、持久化接线
renderer/interaction.js 平移 / 锚点缩放 / 拖拽 / 改挂
renderer/debug.js       F3 叠加
renderer/sample.js      首次启动的示例树
build/icon.svg          图标源文件；build/icon.icns 由它栅格化生成
test/physics.test.mjs   15 项单测
```

主题全走 `styles.css` 顶部的语义 token（`--bg` / `--surface` / `--ink` / `--edge` …），一套 token 定义就是一种主题：`:root` 是默认深色（纯黑画布），`[data-theme="light"]` 覆盖同一组 token 得到纸感浅色。想加第三套主题，复制一份 token 块 + 在 `applyTheme` 里多认一个名字即可，不用碰任何组件样式。

## 许可

MIT
