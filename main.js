const { app, BrowserWindow } = require('electron');
const path = require('path');

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
    win.webContents.on('did-finish-load', () => {
      console.log('[smoke] renderer loaded, window ok');
      app.exit(0);
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
