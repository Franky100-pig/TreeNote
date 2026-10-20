# cardwall

力导向**漂浮卡片墙**笔记工具：要点级卡片 + 自由拖动 + 物理飘动（斥力 / 弹簧 / 阻尼 / 布朗漂移 / 释放惯性）。

Electron 桌面应用，零前端框架（DOM 卡片 + SVG 连线 + CSS transform 世界容器，架构对标 Obsidian Canvas 逆向结论，详见仓库外 `obsidian-canvas-re/RE-obsidian-canvas.md`）。

## 开发

```bash
npm install
npm start          # 正常启动
npm run smoke      # 自检：开窗 → 渲染/相机/交互三层断言 → 截图 smoke.png → 自动退出
```

### 环境注意事项（本机实测）

- **二进制下载走国内镜像**（GitHub releases 直连会 fetch failed）：
  `cd node_modules/electron && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node install.js`
- **WorkBuddy 沙箱预设了 `ELECTRON_RUN_AS_NODE=1`**，会让 Electron 退化成纯 Node
  （症状：`require('electron').app` 为 undefined / "Cannot find module 'electron'"）。
  启动时需清除：`env -u ELECTRON_RUN_AS_NODE npm start`

### 操作

| 动作 | 手势 |
|---|---|
| 编辑卡片 | 双击卡片（Escape 取消，标题里 Enter 提交） |
| 新建卡片 | 双击空白处（自动挂到 320px 内最近的卡片） |
| 删除卡片 | 选中后按 Delete / Backspace（子卡改挂到祖父卡） |
| 改挂父级 | 把卡片拖到另一张卡片上（禁止挂到自己的后代，避免成环） |
| 拖动 | 按住卡片拖动，松手有惯性与回弹 |
| 平移 / 缩放 | 拖动空白处 / 滚轮（以光标为锚点） |
| 调试叠加 | `F3`（Mac 上可能是 Fn+F3）或 `Cmd+Shift+D`：fps、能量、锚点、速度矢量 |

## 数据存放

- 默认路径：`~/Library/Application Support/cardwall/vault/board.json`（macOS）
- 写入是原子的：先写 `board.json.tmp` 再 rename，上一版保留为 `board.json.bak`
- 首次启动没有存档时展示示例树，改动后自动保存（600ms 防抖）
- 调试/测试可用 `CARDWALL_VAULT_DIR=/tmp/xxx` 覆盖；`npm run smoke` 默认使用一次性临时目录

## 当前进度

- [x] C1 脚手架（Electron 最小窗口）
- [x] C2 物理核心（力导向集成器 + 9 项单测）
- [x] C3 渲染骨架（DOM 卡 + SVG 贝塞尔边 + 固定步长 rAF）
- [x] C4 交互（平移/锚点缩放/拖拽 + 释放惯性 + 相机补间/安定取景）
- [x] C5 卡片编辑（选中/双击编辑/新建/删除）
- [x] C6 持久化（JSON vault + IPC + 原子写）
- [x] C7 手感调参 + F3 调试叠加
- [ ] C8 dmg 打包
- [ ] C9 README/截图/tag
