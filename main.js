const { app, BrowserWindow, ipcMain, shell } = require('electron');
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

// ---- vault (C6, multi-board in 0.4) ----------------------------------------
// A board is one JSON file under <vault>/boards/. The board's NAME lives
// inside its own file, so the library is just "read the directory" — there is
// no index file that can drift out of sync with reality.
// CARDWALL_VAULT_DIR overrides the vault; smoke runs in a fresh temp dir so
// runs stay hermetic.
const VAULT_DIR = process.env.CARDWALL_VAULT_DIR
  ? path.resolve(process.env.CARDWALL_VAULT_DIR)
  : isSmoke
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'cardwall-smoke-'))
    : path.join(app.getPath('userData'), 'vault');
const BOARDS_DIR = path.join(VAULT_DIR, 'boards');
// 0.3 stored a single board here; it is imported once on first launch.
const LEGACY_BOARD_FILE = path.join(VAULT_DIR, 'board.json');
// The packaged app's __dirname lives inside a read-only asar, so the smoke
// screenshot goes to the temp dir there; in dev it lands next to main.js.
const SMOKE_SHOT = app.isPackaged
  ? path.join(os.tmpdir(), 'cardwall-smoke.png')
  : path.join(__dirname, 'smoke.png');
const MAX_CARDS = 5000;
const MAX_TITLE = 500;
const MAX_NOTE = 20000;
const MAX_NAME = 80;
const DEFAULT_NAME = '我的第一幅图';

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

// ---- board files ------------------------------------------------------------
// Untrusted input everywhere: a hand-edited or crafted board must never crash
// the app, escape the boards directory, or bloat memory.
function safeId(id) {
  return String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

function boardPath(id) {
  const safe = safeId(id);
  if (!safe) throw new Error('invalid board id');
  return path.join(BOARDS_DIR, safe + '.json');
}

function newBoardId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function cleanName(name) {
  const s = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return s || DEFAULT_NAME;
}

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
      parent: null,
      // Free placement survives a reload: a card the user has positioned
      // must not start drifting again the next time the board opens.
      pinned: c.pinned === true
    });
  }
  // Second pass: parents may be declared after their children.
  const byId = new Map(cards.map(c => [c.id, c]));
  raw.forEach((c) => {
    if (!c || !byId.has(c.id)) return;
    const parent = typeof c.parent === 'string' ? c.parent : null;
    if (parent && parent !== c.id && byId.has(parent)) byId.get(c.id).parent = parent;
  });
  return { version: 1, cards };
}

function readBoardFile(id) {
  try {
    const data = JSON.parse(fs.readFileSync(boardPath(id), 'utf8'));
    if (!data || !Array.isArray(data.cards)) return null;
    return data;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[vault] read failed:', err.message);
    return null;
  }
}

// Write-then-rename: a crash mid-save leaves the previous board intact.
function writeBoardFile(id, board) {
  fs.mkdirSync(BOARDS_DIR, { recursive: true });
  const file = boardPath(id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2), 'utf8');
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  } catch (err) {
    console.error('[vault] backup failed:', err.message);
  }
  fs.renameSync(tmp, file);
}

// 0.3 shipped a single vault/board.json with no name. Adopt it as the first
// board the first time 0.4 starts, so upgrading does not lose the wall.
function migrateLegacy() {
  try {
    if (!fs.existsSync(LEGACY_BOARD_FILE)) return;
    fs.mkdirSync(BOARDS_DIR, { recursive: true });
    const existing = fs.readdirSync(BOARDS_DIR).filter(f => f.endsWith('.json'));
    if (existing.length) return; // already migrated (or a real library exists)
    const data = JSON.parse(fs.readFileSync(LEGACY_BOARD_FILE, 'utf8'));
    const clean = sanitizeBoard(data);
    const id = newBoardId();
    writeBoardFile(id, {
      version: 1,
      name: DEFAULT_NAME,
      savedAt: data.savedAt || new Date().toISOString(),
      cards: clean.cards
    });
    console.log('[vault] migrated legacy board.json ->', id, '(' + clean.cards.length + ' cards)');
  } catch (err) {
    console.error('[vault] migration failed:', err.message);
  }
}

function listBoards() {
  migrateLegacy();
  let files = [];
  try {
    files = fs.readdirSync(BOARDS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.bak'));
  } catch (err) {
    return [];
  }
  const out = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    const board = readBoardFile(id);
    if (!board) continue;
    out.push({
      id: id,
      name: cleanName(board.name),
      cards: Array.isArray(board.cards) ? board.cards.length : 0,
      savedAt: board.savedAt || null
    });
  }
  // Most recently touched first; a board without a stamp sorts last.
  out.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  return out;
}

ipcMain.handle('boards:list', () => listBoards());

ipcMain.handle('boards:create', (event, name) => {
  const id = newBoardId();
  const clean = cleanName(name);
  writeBoardFile(id, { version: 1, name: clean, savedAt: new Date().toISOString(), cards: [] });
  return { id: id, name: clean, cards: 0 };
});

ipcMain.handle('boards:open', (event, id) => {
  const board = readBoardFile(id);
  if (!board) return null;
  return { id: safeId(id), name: cleanName(board.name), cards: sanitizeBoard(board).cards };
});

ipcMain.handle('boards:save', (event, id, data) => {
  const safe = safeId(id);
  if (!safe) return { ok: false, error: 'invalid id' };
  const clean = sanitizeBoard(data);
  // Keep the name that is already on disk: renaming has its own handler, and a
  // stale renderer must not be able to wipe it.
  const previous = readBoardFile(safe);
  const name = cleanName(previous ? previous.name : (data && data.name));
  writeBoardFile(safe, {
    version: 1,
    name: name,
    savedAt: new Date().toISOString(),
    cards: clean.cards
  });
  return { ok: true, path: boardPath(safe), cards: clean.cards.length, name: name };
});

ipcMain.handle('boards:rename', (event, id, name) => {
  const safe = safeId(id);
  if (!safe) return { ok: false, error: 'invalid id' };
  const board = readBoardFile(safe);
  if (!board) return { ok: false, error: 'not found' };
  const next = cleanName(name);
  board.name = next;
  board.savedAt = new Date().toISOString();
  writeBoardFile(safe, board);
  return { ok: true, name: next };
});

// Deleting a board puts the file in the OS trash instead of unlinking it, so a
// misclick is recoverable from the Finder.
ipcMain.handle('boards:delete', async (event, id) => {
  const safe = safeId(id);
  if (!safe) return { ok: false, error: 'invalid id' };
  const file = boardPath(safe);
  if (!fs.existsSync(file)) return { ok: false, error: 'not found' };
  try {
    await shell.trashItem(file);
    try { fs.rmSync(file + '.bak', { force: true }); } catch (err) { /* no backup */ }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: 'cardwall',
    backgroundColor: '#000000',
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
        // Boot is async now (it opens a board over IPC); wait for the
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
        // Theme: default is dark, shortcut flips and is remembered; the board
        // must end up dark again so the screenshot below shows the default.
        const theme = await win.webContents.executeJavaScript('window.__cardwallThemeCheck()');
        const okTheme = !!theme && theme.ok;
        console.log('[smoke] theme-check:', JSON.stringify(theme), okTheme ? 'PASS' : 'FAIL');
        if (!okTheme) { app.exit(1); return; }
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
        // Hover action bar: edit / add / delete buttons present and functional.
        const toolbar = await win.webContents.executeJavaScript('window.__cardwallToolbarCheck()');
        const okToolbar = !!toolbar && toolbar.ok;
        console.log('[smoke] toolbar-check:', JSON.stringify(toolbar), okToolbar ? 'PASS' : 'FAIL');
        if (!okToolbar) { app.exit(1); return; }
        // Vault round trip: save over IPC, then verify the file on disk.
        const save = await win.webContents.executeJavaScript('window.__cardwallSaveNow()');
        const onDisk = save && save.path && fs.existsSync(save.path)
          ? JSON.parse(fs.readFileSync(save.path, 'utf8'))
          : null;
        const rootCard = onDisk && onDisk.cards.find((c) => c.title === '已编辑标题');
        const persist = {
          ok: !!save && save.ok && !!onDisk && onDisk.cards.length === 5 &&
            !!rootCard && !fs.existsSync(save.path + '.tmp'),
          saved: save && save.cards,
          diskCards: onDisk ? onDisk.cards.length : null,
          editedTitlePersisted: !!rootCard,
          tmpLeftOver: !!(save && save.path) && fs.existsSync(save.path + '.tmp'),
          path: save && save.path
        };
        console.log('[smoke] persist-check:', JSON.stringify(persist), persist.ok ? 'PASS' : 'FAIL');
        if (!persist.ok) { app.exit(1); return; }
        // Board library: the list has a name, and create/rename/delete round-trip.
        const home = await win.webContents.executeJavaScript('window.__cardwallHomeCheck()');
        const okHome = !!home && home.ok;
        console.log('[smoke] home-check:', JSON.stringify(home), okHome ? 'PASS' : 'FAIL');
        if (!okHome) { app.exit(1); return; }
        // Home screenshot for visual review: the library is a whole new surface
        // and the only way to catch layout regressions in it.
        await win.webContents.executeJavaScript('document.getElementById("home-btn").click()');
        const shotHome = await capturePainted(win);
        if (shotHome) {
          const homeShotPath = path.join(path.dirname(SMOKE_SHOT), 'smoke-home.png');
          fs.writeFileSync(homeShotPath, shotHome.img.toPNG());
          console.log('[smoke] home screenshot ->', homeShotPath, 'ink', shotHome.ink.toFixed(3));
        }
        await win.webContents.executeJavaScript('document.getElementById("home-btn").click()');
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
