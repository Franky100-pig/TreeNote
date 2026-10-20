const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// --smoke: 开窗后等渲染完成即退出，用于 CI/脚手架自检
const isSmoke = process.argv.includes('--smoke');

// Restricted environments (agent sandboxes, CI) block Chromium's OS-level
// sandbox and GPU helpers — smoke mode runs sandbox-free and software
// rendered so the self-checks stay deterministic there. Normal launches
// keep the default Chromium sandbox and hardware acceleration.
if (isSmoke) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.disableHardwareAcceleration();
}

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
        // Settle-fit + tween: drives frames synchronously, checks that the
        // settled tree is framed without clipping.
        const camera = await win.webContents.executeJavaScript('window.__cardwallCameraCheck()');
        const okCamera = !!camera && camera.ok;
        console.log('[smoke] camera-check:', JSON.stringify(camera), okCamera ? 'PASS' : 'FAIL');
        if (!okCamera) { app.exit(1); return; }
        // Screenshot the settled floating state for visual review (gitignored artifact).
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'smoke.png'), img.toPNG());
        console.log('[smoke] screenshot -> smoke.png');
        // Synthetic pointer/wheel events against the real interaction listeners.
        const interaction = await win.webContents.executeJavaScript('window.__cardwallInteractionCheck()');
        const okInteraction = !!interaction && interaction.ok;
        console.log('[smoke] interaction-check:', JSON.stringify(interaction), okInteraction ? 'PASS' : 'FAIL');
        if (!okInteraction) { app.exit(1); return; }
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
