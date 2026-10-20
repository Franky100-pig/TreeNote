const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// --smoke: 开窗后等渲染完成即退出，用于 CI/脚手架自检
const isSmoke = process.argv.includes('--smoke');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: 'cardwall',
    backgroundColor: '#f7f5f0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile('index.html');

  if (isSmoke) {
    win.webContents.on('did-finish-load', async () => {
      try {
        // Deterministic renderer self-check (no rAF dependency): steps the
        // world, syncs the DOM, then verifies the render pipeline.
        const report = await win.webContents.executeJavaScript('window.__cardwallSelfCheck(120)');
        const ok = !!report &&
          report.cards === 6 && report.edges === 5 && report.edgesWithPath === 5 &&
          report.allFinite && /scale\(/.test(report.worldTransform || '');
        console.log('[smoke] self-check:', JSON.stringify(report), ok ? 'PASS' : 'FAIL');
        if (!ok) { app.exit(1); return; }
        // Screenshot for visual review (gitignored artifact).
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'smoke.png'), img.toPNG());
        console.log('[smoke] screenshot -> smoke.png');
        app.exit(0);
      } catch (err) {
        console.error('[smoke] error:', err);
        app.exit(1);
      }
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
