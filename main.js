const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// --smoke: 开窗后等渲染完成即退出，用于 CI/脚手架自检
// The packaged macOS binary rejects unknown CLI options, so the env var
// works for both dev and packaged runs.
const isSmoke = process.argv.includes('--smoke') || process.env.CARDWALL_SMOKE === '1';

// Restricted environments (agent sandboxes, CI) block Chromium's OS-level
// sandbox and GPU helpers — smoke mode runs sandbox-free and software
// rendered so the self-checks stay deterministic there. Normal launches
// keep the default Chromium sandbox and hardware acceleration.
if (isSmoke) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.disableHardwareAcceleration();
}

// ---- vault (C6) -------------------------------------------------------------
// One board file under the app's userData directory. CARDWALL_VAULT_DIR
// overrides it; smoke runs in a fresh temp dir so runs stay hermetic.
const VAULT_DIR = process.env.CARDWALL_VAULT_DIR
  ? path.resolve(process.env.CARDWALL_VAULT_DIR)
  : isSmoke
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'cardwall-smoke-'))
    : path.join(app.getPath('userData'), 'vault');
const BOARD_FILE = path.join(VAULT_DIR, 'board.json');
// The packaged app's __dirname lives inside a read-only asar, so the smoke
// screenshot goes to the temp dir there; in dev it lands next to main.js.
const SMOKE_SHOT = app.isPackaged
  ? path.join(os.tmpdir(), 'cardwall-smoke.png')
  : path.join(__dirname, 'smoke.png');
const MAX_CARDS = 5000;
const MAX_TITLE = 500;
const MAX_NOTE = 20000;

// capturePage can return a frame the compositor has not painted yet, which
// comes back as a blank canvas. Swapping the theme made this reproducible
// (~1 run in 3), so the screenshot path now waits for two animation frames
// and then checks that the image actually contains content.
function frameInkRatio(img) {
  const size = img.getSize();
  const bmp = img.getBitmap();
  const total = size.width * size.height;
  if (!total || bmp.length < total * 4) return 0;
  const b = bmp[0];
  const g = bmp[1];
  const r = bmp[2];
  let differing = 0;
  for (let i = 0; i < total * 4; i += 4) {
    if (Math.abs(bmp[i] - b) > 10 || Math.abs(bmp[i + 1] - g) > 10 || Math.abs(bmp[i + 2] - r) > 10) {
      differing++;
    }
  }
  return differing / total;
}

async function capturePainted(win, minInk) {
  const threshold = minInk === undefined ? 0.02 : minInk;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await win.webContents.executeJavaScript(
      'new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); })'
    );
    await new Promise((resolve) => setTimeout(resolve, 80 * attempt));
    const img = await win.webContents.capturePage();
    const ink = frameInkRatio(img);
    if (ink >= threshold) return { img: img, ink: ink, attempt: attempt };
    console.log('[smoke] capture retry: ink', ink.toFixed(4), 'attempt', attempt);
  }
  return null;
}


function readBoard() {
  try {
    const data = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    if (!data || !Array.isArray(data.cards)) return null;
    return data;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[vault] read failed:', err.message);
    return null;
  }
}

// Untrusted input (the renderer is the only writer, but a hand-edited or
// crafted board file must never crash or bloat the app).
function sanitizeBoard(data) {
  const raw = data && Array.isArray(data.cards) ? data.cards.slice(0, MAX_CARDS) : [];
  const ids = new Set();
  const cards = [];
  for (const c of raw) {
    if (!c || typeof c.id !== 'string' || !c.id || ids.has(c.id)) continue;
    ids.add(c.id);
    cards.push({
      id: c.id,
      title: String(c.title == null ? '' : c.title).slice(0, MAX_TITLE),
      note: String(c.note == null ? '' : c.note).slice(0, MAX_NOTE),
      x: Number.isFinite(c.x) ? c.x : 0,
      y: Number.isFinite(c.y) ? c.y : 0,
      parent: null
    });
  }
  // Second pass: parents may be declared after their children.
  const byId = new Map(cards.map(c => [c.id, c]));
  raw.forEach((c, i) => {
    if (!c || !byId.has(c.id)) return;
    const parent = typeof c.parent === 'string' ? c.parent : null;
    if (parent && parent !== c.id && byId.has(parent)) byId.get(c.id).parent = parent;
  });
  return { version: 1, cards };
}

// Write-then-rename: a crash mid-save leaves the previous board intact.
function writeBoardAtomic(board) {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  const tmp = BOARD_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2), 'utf8');
  try {
    if (fs.existsSync(BOARD_FILE)) fs.copyFileSync(BOARD_FILE, BOARD_FILE + '.bak');
  } catch (err) {
    console.error('[vault] backup failed:', err.message);
  }
  fs.renameSync(tmp, BOARD_FILE);
}

ipcMain.handle('board:load', () => readBoard());
ipcMain.handle('board:save', (event, data) => {
  const clean = sanitizeBoard(data);
  const board = { version: 1, savedAt: new Date().toISOString(), cards: clean.cards };
  writeBoardAtomic(board);
  return { ok: true, path: BOARD_FILE, cards: clean.cards.length };
});

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
    // `once`: the load-check reloads the window at the end.
    win.webContents.once('did-finish-load', async () => {
      try {
        // Boot is async now (it loads the board over IPC); wait for the
        // renderer to signal readiness before running the checks.
        let ready = false;
        for (let i = 0; i < 150; i++) {
          ready = await win.webContents.executeJavaScript('!!window.__cardwallReady');
          if (ready) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!ready) { console.error('[smoke] FAIL renderer never became ready'); app.exit(1); return; }
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
        // Debug overlay: F3 toggles the panel and world markers.
        const dbg = await win.webContents.executeJavaScript('window.__cardwallDebugCheck()');
        const okDbg = !!dbg && dbg.ok;
        console.log('[smoke] debug-check:', JSON.stringify(dbg), okDbg ? 'PASS' : 'FAIL');
        if (!okDbg) { app.exit(1); return; }
        // Screenshot the settled floating state for visual review (gitignored artifact).
        const shot = await capturePainted(win);
        if (!shot) {
          console.error('[smoke] FAIL screenshot never painted (blank frames only)');
          app.exit(1);
          return;
        }
        fs.writeFileSync(SMOKE_SHOT, shot.img.toPNG());
        console.log('[smoke] screenshot ->', SMOKE_SHOT, 'ink', shot.ink.toFixed(3), 'attempt', shot.attempt);
        // Synthetic pointer/wheel events against the real interaction listeners.
        const interaction = await win.webContents.executeJavaScript('window.__cardwallInteractionCheck()');
        const okInteraction = !!interaction && interaction.ok;
        console.log('[smoke] interaction-check:', JSON.stringify(interaction), okInteraction ? 'PASS' : 'FAIL');
        if (!okInteraction) { app.exit(1); return; }
        // Selection / inline edit / create / delete — mutates the world, so last.
        const editor = await win.webContents.executeJavaScript('window.__cardwallEditorCheck()');
        const okEditor = !!editor && editor.ok;
        console.log('[smoke] editor-check:', JSON.stringify(editor), okEditor ? 'PASS' : 'FAIL');
        if (!okEditor) { app.exit(1); return; }
        // Vault round trip: save over IPC, then verify the file on disk.
        const save = await win.webContents.executeJavaScript('window.__cardwallSaveNow()');
        const onDisk = fs.existsSync(BOARD_FILE) ? JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')) : null;
        const rootCard = onDisk && onDisk.cards.find((c) => c.title === '已编辑标题');
        const persist = {
          ok: !!save && save.ok && !!onDisk && onDisk.cards.length === 5 &&
            !!rootCard && !fs.existsSync(BOARD_FILE + '.tmp'),
          saved: save && save.cards,
          diskCards: onDisk ? onDisk.cards.length : null,
          editedTitlePersisted: !!rootCard,
          tmpLeftOver: fs.existsSync(BOARD_FILE + '.tmp'),
          path: BOARD_FILE
        };
        console.log('[smoke] persist-check:', JSON.stringify(persist), persist.ok ? 'PASS' : 'FAIL');
        if (!persist.ok) { app.exit(1); return; }
        // Load path: reload the window and confirm the board comes back from disk.
        win.webContents.reload();
        let ready2 = false;
        for (let i = 0; i < 150; i++) {
          try {
            ready2 = await win.webContents.executeJavaScript('!!window.__cardwallReady');
          } catch (err) {
            ready2 = false; // still navigating
          }
          if (ready2) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        const loaded = ready2
          ? await win.webContents.executeJavaScript(
              '({ cards: window.__cardwall.world.cards.length, hasEdited: window.__cardwall.world.cards.some(function (c) { return c.title === "已编辑标题"; }) })'
            )
          : null;
        const okLoad = !!loaded && loaded.cards === 5 && loaded.hasEdited;
        console.log('[smoke] load-check:', JSON.stringify(loaded), okLoad ? 'PASS' : 'FAIL');
        if (!okLoad) { app.exit(1); return; }
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
