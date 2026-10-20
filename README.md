# cardwall

力导向**漂浮卡片墙**笔记工具：要点级卡片 + 自由拖动 + 物理飘动（斥力 / 弹簧 / 阻尼 / 布朗漂移 / 释放惯性）。

Electron 桌面应用，零前端框架（DOM 卡片 + SVG 连线 + CSS transform 世界容器，架构对标 Obsidian Canvas 逆向结论，详见仓库外 `obsidian-canvas-re/RE-obsidian-canvas.md`）。

## 开发

```bash
npm install
npm start          # 正常启动
npm run smoke      # 脚手架自检：开窗 → 渲染加载 → 自动退出
```

### 环境注意事项（本机实测）

- **二进制下载走国内镜像**（GitHub releases 直连会 fetch failed）：
  `cd node_modules/electron && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node install.js`
- **WorkBuddy 沙箱预设了 `ELECTRON_RUN_AS_NODE=1`**，会让 Electron 退化成纯 Node
  （症状：`require('electron').app` 为 undefined / "Cannot find module 'electron'"）。
  启动时需清除：`env -u ELECTRON_RUN_AS_NODE npm start`

## 当前进度

- [x] C1 脚手架（Electron 最小窗口）
- [ ] C2 物理核心
- [ ] C3 渲染骨架
- [ ] C4 交互（平移/缩放/拖拽）
- [ ] C5 卡片编辑
- [ ] C6 持久化
- [ ] C7 手感调参
- [ ] C8 dmg 打包
- [ ] C9 README/截图/tag
