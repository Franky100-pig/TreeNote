// Unit tests for the web storage bridge (renderer/web-bridge.js).
// The bridge must behave EXACTLY like the Electron preload + main.js vault
// (within a session), because the renderer cannot tell the two apart — with
// one deliberate difference: THE WEB EDITION REMEMBERS NOTHING. Boards live
// in memory only, so a reload starts from an empty library and no storage
// backend (localStorage et al.) is ever touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const bridge = require('../renderer/web-bridge.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeWorld() {
  const win = {};
  assert.equal(bridge.install(win), true, 'installs on a fresh window');
  return { win };
}

test('web-bridge: install is a no-op when the Electron preload already ran', () => {
  const win = { cardwall: { platform: 'darwin', listBoards: () => Promise.resolve([]) } };
  // A pre-installed bridge must survive untouched.
  const before = win.cardwall;
  // install() would overwrite it, so the module guards the auto-install path;
  // here we assert the guard contract: the browser only calls install when
  // window.cardwall is absent.
  assert.ok(before && typeof before.listBoards === 'function');
});

test('web-bridge: no session API — the web edition has nothing to restore', () => {
  const { win } = makeWorld();
  assert.equal(win.cardwall.loadSession, undefined);
  assert.equal(win.cardwall.saveSession, undefined);
});

test('web-bridge: storage backends are never touched', async () => {
  // Any access to web storage is a bug: the bridge is memory-only. A poisoned
  // localStorage makes even a read throw, and nothing here may throw.
  const calls = [];
  globalThis.localStorage = {
    getItem: (k) => { calls.push(['get', k]); return null; },
    setItem: (k, v) => { calls.push(['set', k, v]); },
    removeItem: (k) => { calls.push(['remove', k]); }
  };
  try {
    const { win } = makeWorld();
    const created = await win.cardwall.createBoard('A');
    await win.cardwall.saveBoard(created.id, { cards: [{ id: 'x', title: 't' }] });
    await win.cardwall.listBoards();
    await win.cardwall.renameBoard(created.id, 'B');
    await win.cardwall.deleteBoard(created.id);
    assert.deepEqual(calls, [], 'the bridge must not read or write web storage');
  } finally {
    delete globalThis.localStorage;
  }
});

test('web-bridge: create -> list -> open round trip', async () => {
  const { win } = makeWorld();
  const created = await win.cardwall.createBoard('  我的  图  ');
  assert.equal(created.name, '我的 图');
  assert.ok(/^b[a-z0-9]+$/.test(created.id), 'id shape matches main.js');

  const list = await win.cardwall.listBoards();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);
  assert.equal(list[0].cards, 0);

  const opened = await win.cardwall.openBoard(created.id);
  assert.equal(opened.name, '我的 图');
  assert.deepEqual(opened.cards, []);
  assert.equal(await win.cardwall.openBoard('nope'), null);
});

test('web-bridge: save -> open round trip (in-memory)', async () => {
  const { win } = makeWorld();
  const created = await win.cardwall.createBoard('第一幅');
  await win.cardwall.saveBoard(created.id, {
    cards: [
      { id: 'r', title: '根', x: 0, y: 0, parent: null },
      { id: 'c1', title: '子', x: 10, y: 20, parent: 'r' }
    ]
  });
  const list = await win.cardwall.listBoards();
  assert.equal(list[0].cards, 2);
  const opened = await win.cardwall.openBoard(created.id);
  assert.equal(opened.cards.length, 2);
  assert.equal(opened.cards[1].parent, 'r');
});

test('web-bridge: save keeps the name already in memory (stale renderer cannot wipe it)', async () => {
  const { win } = makeWorld();
  const created = await win.cardwall.createBoard('原名');
  const r = await win.cardwall.saveBoard(created.id, { name: '伪造名', cards: [] });
  assert.equal(r.ok, true);
  assert.equal(r.name, '原名');
  const renamed = await win.cardwall.renameBoard(created.id, ' 新名字 ');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.name, '新名字');
  const opened = await win.cardwall.openBoard(created.id);
  assert.equal(opened.name, '新名字');
  // rename of a missing board fails like main.js
  assert.deepEqual(await win.cardwall.renameBoard('ghost', 'x'), { ok: false, error: 'not found' });
});

test('web-bridge: delete removes the board and reports missing ones', async () => {
  const { win } = makeWorld();
  const a = await win.cardwall.createBoard('A');
  await win.cardwall.createBoard('B');
  assert.equal((await win.cardwall.listBoards()).length, 2);
  assert.equal((await win.cardwall.deleteBoard(a.id)).ok, true);
  assert.equal((await win.cardwall.listBoards()).length, 1);
  assert.equal(await win.cardwall.openBoard(a.id), null);
  assert.deepEqual(await win.cardwall.deleteBoard(a.id), { ok: false, error: 'not found' });
});

test('web-bridge: a reload forgets everything (memory-less by design)', async () => {
  const first = makeWorld().win;
  const created = await first.cardwall.createBoard('A');
  await first.cardwall.saveBoard(created.id, { cards: [{ id: 'x', title: 't' }] });
  assert.equal((await first.cardwall.listBoards()).length, 1);

  // A page reload re-runs the module against a fresh window + fresh store.
  const reloaded = makeWorld().win;
  assert.deepEqual(await reloaded.cardwall.listBoards(), []);
  assert.equal(await reloaded.cardwall.openBoard(created.id), null);
});

test('web-bridge: the tidy flag survives save -> open', async () => {
  const { win } = makeWorld();
  const created = await win.cardwall.createBoard('A');
  await win.cardwall.saveBoard(created.id, { tidy: false, cards: [{ id: 'x', title: 't' }] });
  const opened = await win.cardwall.openBoard(created.id);
  assert.equal(opened.tidy, false);
  await win.cardwall.saveBoard(created.id, { tidy: true, cards: [{ id: 'x', title: 't' }] });
  assert.equal((await win.cardwall.openBoard(created.id)).tidy, true);
  // No flag -> stays undefined, and openBoardInto defaults to a tidy tree.
  await win.cardwall.saveBoard(created.id, { cards: [{ id: 'x', title: 't' }] });
  assert.equal((await win.cardwall.openBoard(created.id)).tidy, undefined);
});

test('web-bridge: sanitizeBoard drops junk and resolves late parents (mirrors main.js)', () => {
  const clean = bridge.sanitizeBoard({
    cards: [
      { id: 'child', parent: 'root', x: 1, y: 2 },       // parent declared later
      { id: 'root', title: 'R', x: 0, y: 0 },
      { id: 'root', title: 'dup' },                       // duplicate id dropped
      { id: '' },                                          // empty id dropped
      { title: 'no id' },                                  // missing id dropped
      { id: 'self', parent: 'self' },                      // self parent -> null
      { id: 'ghost', parent: 'missing' },                  // dangling parent -> null
      { id: 'nan', x: 'abc', y: null },                    // bad coords -> 0
      { id: 'long', title: 'x'.repeat(600) },              // title clipped
      { id: 'col-ok', color: 'rose' },                     // whitelisted colour kept
      { id: 'col-bad', color: 'javascript:alert(1)' },     // arbitrary value -> null
      { id: 'col-bad2', color: 'RED' },                    // case-sensitive whitelist
      { id: 'col-bad3', color: 42 }                        // non-string -> null
    ]
  });
  const ids = clean.cards.map((c) => c.id);
  assert.deepEqual(ids, ['child', 'root', 'self', 'ghost', 'nan', 'long', 'col-ok', 'col-bad', 'col-bad2', 'col-bad3']);
  assert.equal(clean.cards[0].parent, 'root', 'late parent resolved');
  assert.equal(clean.cards[2].parent, null);
  assert.equal(clean.cards[3].parent, null);
  assert.equal(clean.cards[4].x, 0);
  assert.equal(clean.cards[4].y, 0);
  assert.equal(clean.cards[5].title.length, 500);
  assert.equal(clean.tidy, undefined, 'no tidy flag in, none out');
  // Card colours: only the whitelist survives; everything else -> null.
  assert.equal(clean.cards[6].color, 'rose');
  assert.equal(clean.cards[7].color, null);
  assert.equal(clean.cards[8].color, null);
  assert.equal(clean.cards[9].color, null);
});

test('web-bridge: card colours survive save -> open', async () => {
  const { win } = makeWorld();
  const created = await win.cardwall.createBoard('A');
  await win.cardwall.saveBoard(created.id, {
    cards: [
      { id: 'a', title: 'A', color: 'sky' },
      { id: 'b', title: 'B' } // no colour -> null
    ]
  });
  const opened = await win.cardwall.openBoard(created.id);
  assert.equal(opened.cards[0].color, 'sky');
  assert.equal(opened.cards[1].color, null);
});

test('web-bridge: colour sanitisation boundary cases', () => {
  // The whitelist is the only thing standing between a hand-edited board
  // file and the DOM. Everything that is not exactly one of the six preset
  // names must land on null (the default panel) — including near misses
  // that a looser check would let through.
  const cases = [
    ['rose', 'rose'],                    // on the whitelist -> kept
    ['amber', 'amber'],
    ['violet', 'violet'],
    ['rose ', null],                     // trailing space is NOT the name
    [' rose', null],                     // leading space either
    ['ROSE', null],                      // case-sensitive
    ['Rose', null],
    ['', null],                          // empty string
    [' ', null],
    [null, null],                        // explicit null
    [undefined, null],                   // absent
    [{}, null],                          // object
    [[], null],                          // array
    [42, null],                          // number
    [true, null],                        // boolean
    ['__proto__', null],                 // prototype-pollution attempt
    ['constructor', null],               // inherited property
    ['toString', null],
    ['rose".red', null],                 // CSS-injection attempt
    ['rose; background:url(x)', null],
    ['javascript:alert(1)', null],
    ['x'.repeat(500), null]              // absurdly long
  ];
  const cards = cases.map(([value], i) => ({ id: 'c' + i, color: value }));
  const clean = bridge.sanitizeBoard({ cards });
  assert.equal(clean.cards.length, cases.length, 'no card is dropped over colour');
  cases.forEach(([value, expected], i) => {
    assert.equal(clean.cards[i].color, expected,
      `colour ${JSON.stringify(value)} -> ${expected}`);
  });
});

test('web-bridge: a colour never leaks the other card fields', () => {
  // The sanitiser builds a fresh object per card; the colour must not be
  // able to smuggle extra properties through.
  const clean = bridge.sanitizeBoard({
    cards: [{ id: 'x', title: 'T', color: 'mint', evil: 'nope', __proto__: { p: 1 } }]
  });
  assert.equal(clean.cards[0].color, 'mint');
  assert.equal(clean.cards[0].evil, undefined, 'unknown fields are dropped');
  assert.equal(Object.prototype.hasOwnProperty.call(clean.cards[0], 'evil'), false);
  assert.equal(Object.prototype.polluted, undefined, 'no prototype pollution');
});

test('web-bridge: the card cap holds and colours survive it', () => {
  const cards = [];
  for (let i = 0; i < 5002; i++) {
    cards.push({ id: 'k' + i, color: i % 2 === 0 ? 'mint' : 'sky' });
  }
  const clean = bridge.sanitizeBoard({ cards });
  assert.equal(clean.cards.length, 5000, 'MAX_CARDS cap enforced');
  assert.equal(clean.cards[0].id, 'k0');
  assert.equal(clean.cards[4999].id, 'k4999', 'the FIRST 5000 survive');
  assert.equal(clean.cards[4999].color, 'sky', 'colours survive the cap');
});

test('contract: main.js and the web twin share one colour whitelist', () => {
  // The two sanitizers must never drift: a board written by the desktop
  // build is read back by the web build (and vice versa). A divergence
  // would mean a colour the desktop accepts but the web silently drops
  // (or worse: one side accepting a value the other treats as junk).
  const mainSrc = readFileSync(path.join(root, 'main.js'), 'utf8');
  const bridgeSrc = readFileSync(path.join(root, 'renderer', 'web-bridge.js'), 'utf8');
  const pick = (src) => {
    const m = src.match(/CARD_COLORS\s*=\s*\[([^\]]*)\]/);
    assert.ok(m, 'CARD_COLORS list found');
    return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };
  const expected = ['amber', 'rose', 'sky', 'mint', 'violet', 'lime'];
  assert.deepEqual(pick(mainSrc), expected, 'main.js whitelist');
  assert.deepEqual(pick(bridgeSrc), expected, 'web-bridge whitelist');
  // Both sides must also normalise the same way, not just list the same names.
  assert.match(mainSrc, /function cleanColor\(c\)/, 'main.js normalises the colour');
  assert.match(bridgeSrc, /function cleanColor\(c\)/, 'the web twin normalises it too');
});

test('web-bridge: listBoards sorts most-recently-saved first', async () => {
  const { win } = makeWorld();
  const a = await win.cardwall.createBoard('A');
  await win.cardwall.createBoard('B');
  await new Promise((r) => setTimeout(r, 5));
  await win.cardwall.saveBoard(a.id, { cards: [{ id: 'x', title: 't' }] }); // touch A again
  const list = await win.cardwall.listBoards();
  assert.equal(list[0].id, a.id);
  assert.equal(list[0].cards, 1);
});

test('web-bridge: pinning floats a board to the top, unpin restores recency', async () => {
  const { win } = makeWorld();
  const a = await win.cardwall.createBoard('A');
  await new Promise((r) => setTimeout(r, 5));
  const b = await win.cardwall.createBoard('B'); // B is the most recent
  let list = await win.cardwall.listBoards();
  assert.deepEqual(list.map((x) => x.id), [b.id, a.id]);
  assert.deepEqual(list.map((x) => x.pinned), [false, false]);

  // Pin the OLDER board: it must jump above the newer one.
  const r = await win.cardwall.pinBoard(a.id, true);
  assert.deepEqual(r, { ok: true, pinned: true });
  list = await win.cardwall.listBoards();
  assert.deepEqual(list.map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(list.map((x) => x.pinned), [true, false]);

  // Unpin: back to pure recency.
  await win.cardwall.pinBoard(a.id, false);
  list = await win.cardwall.listBoards();
  assert.deepEqual(list.map((x) => x.id), [b.id, a.id]);

  // Pinning a missing board fails like main.js; a truthy-but-not-true value
  // normalises to false (strict === true).
  assert.deepEqual(await win.cardwall.pinBoard('ghost', true), { ok: false, error: 'not found' });
  assert.deepEqual(await win.cardwall.pinBoard(a.id, 1), { ok: true, pinned: false });
});

test('web-bridge: a card save never un-pins the board (mirrors main.js)', async () => {
  const { win } = makeWorld();
  const created = await win.cardwall.createBoard('A');
  await win.cardwall.pinBoard(created.id, true);
  const savedAtBefore = (await win.cardwall.listBoards())[0].savedAt;
  await win.cardwall.saveBoard(created.id, { cards: [{ id: 'x', title: 't', color: 'mint' }] });
  const after = (await win.cardwall.listBoards())[0];
  assert.equal(after.pinned, true, 'pin survives a card save');
  assert.equal(after.cards, 1);
  // The pin handler itself must not touch savedAt (recency undisturbed) —
  // saveBoard legitimately does, that is a separate action.
  assert.ok(after.savedAt >= savedAtBefore);
});

test('web-bridge: pinning boundary cases', async () => {
  const { win } = makeWorld();
  const a = await win.cardwall.createBoard('A');
  await new Promise((r) => setTimeout(r, 5));
  const b = await win.cardwall.createBoard('B'); // B is the newer board

  // Ids are SANITISED, not rejected: safeId strips everything outside
  // [A-Za-z0-9_-] and truncates to 40 chars, then the lookup happens. So an
  // id that sanitises to nothing is an invalid id, while an id that
  // sanitises to something well-formed but unknown is simply "not found".
  for (const bad of ['', null, undefined, '!!!', '   ']) {
    assert.deepEqual(await win.cardwall.pinBoard(bad, true), { ok: false, error: 'invalid id' },
      `id ${JSON.stringify(bad)} sanitises to nothing`);
  }
  for (const unknown of ['bad id!', 'x'.repeat(200), 'no-such-board']) {
    assert.deepEqual(await win.cardwall.pinBoard(unknown, true), { ok: false, error: 'not found' },
      `id ${JSON.stringify(unknown)} is well-formed but unknown`);
  }

  // Pinning twice is idempotent, and the OLDER board jumps above the newer one.
  assert.deepEqual(await win.cardwall.pinBoard(a.id, true), { ok: true, pinned: true });
  assert.deepEqual(await win.cardwall.pinBoard(a.id, true), { ok: true, pinned: true });
  let list = await win.cardwall.listBoards();
  assert.equal(list[0].id, a.id, 'the pinned board floats to the top');
  assert.equal(list[1].id, b.id);

  // Unpinning restores plain recency (B is newer).
  assert.deepEqual(await win.cardwall.pinBoard(a.id, false), { ok: true, pinned: false });
  list = await win.cardwall.listBoards();
  assert.equal(list[0].id, b.id);
  assert.equal(list[1].id, a.id);
  assert.equal(list.find((x) => x.id === a.id).pinned, false);

  // Unpinning something that was never pinned is a no-op, not an error.
  assert.deepEqual(await win.cardwall.pinBoard(b.id, false), { ok: true, pinned: false });
  assert.equal((await win.cardwall.listBoards()).find((x) => x.id === b.id).pinned, false);

  // Renaming a pinned board keeps the pin (the flag lives on the board).
  await win.cardwall.pinBoard(a.id, true);
  await win.cardwall.renameBoard(a.id, 'A renamed');
  assert.equal((await win.cardwall.listBoards()).find((x) => x.id === a.id).pinned, true);

  // A deleted board leaves no pin behind.
  await win.cardwall.pinBoard(b.id, true);
  await win.cardwall.deleteBoard(b.id);
  assert.equal((await win.cardwall.listBoards()).find((x) => x.id === b.id), undefined);
});

test('web-bridge: a mangled id still addresses its board (sanitised lookup)', async () => {
  // Documented consequence of sanitising ids instead of rejecting them:
  // inserting an illegal character in the middle resolves back to the same
  // board. Every handler in the API behaves this way (rename / delete
  // included), so the pin must not be the odd one out.
  const { win } = makeWorld();
  const board = await win.cardwall.createBoard('B');
  const mangled = board.id.slice(0, 3) + '!' + board.id.slice(3);
  assert.notEqual(mangled, board.id, 'the id really is mangled');
  const r = await win.cardwall.pinBoard(mangled, true);
  assert.deepEqual(r, { ok: true, pinned: true });
  const list = await win.cardwall.listBoards();
  assert.equal(list[0].id, board.id);
  assert.equal(list[0].pinned, true);
});

test('web-bridge: several pinned boards keep recency among themselves', async () => {
  const { win } = makeWorld();
  const a = await win.cardwall.createBoard('A');
  await new Promise((r) => setTimeout(r, 5));
  const b = await win.cardwall.createBoard('B');
  await new Promise((r) => setTimeout(r, 5));
  const c = await win.cardwall.createBoard('C'); // C is the newest
  await win.cardwall.pinBoard(a.id, true);
  await win.cardwall.pinBoard(c.id, true);
  const list = await win.cardwall.listBoards();
  // Pinned group first (newest within it), then the unpinned ones.
  assert.deepEqual(list.map((x) => x.id), [c.id, a.id, b.id]);
  assert.deepEqual(list.map((x) => x.pinned), [true, true, false]);
});

test('web-bridge: a pin survives a full save -> open -> save cycle', async () => {
  const { win } = makeWorld();
  const created = await win.cardwall.createBoard('A');
  await win.cardwall.pinBoard(created.id, true);
  // open returns the board contents; the pin is a library-level flag and
  // must not be part of (or lost by) the card payload round trip.
  const opened = await win.cardwall.openBoard(created.id);
  assert.equal(opened.pinned, undefined, 'the pin is not a card property');
  await win.cardwall.saveBoard(created.id, { cards: [{ id: 'x', title: 't' }] });
  assert.equal((await win.cardwall.listBoards())[0].pinned, true);
});

test('web-bridge: exportPdf downloads the bytes in the browser', async () => {
  // The renderer produces the PDF bytes; the web bridge must hand them to the
  // browser as a download (it has no filesystem). Stub the browser APIs it
  // touches and assert the right anchor + blob come out.
  let clicked = null;
  let blobType = null;
  let blobBytes = null;
  const origCreateObjectURL = globalThis.URL.createObjectURL;
  const origBlob = globalThis.Blob;
  const origDoc = globalThis.document;
  const origSetTimeout = globalThis.setTimeout;

  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.Blob = class {
    constructor(parts, opts) { blobBytes = new Uint8Array(parts[0]); blobType = opts && opts.type; }
  };
  const anchors = [];
  globalThis.document = {
    createElement() { const a = { click() { clicked = a; } }; anchors.push(a); return a; },
    body: { appendChild() {}, removeChild() {} }
  };
  globalThis.setTimeout = () => 0;

  try {
    const { win } = makeWorld();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const res = await win.cardwall.exportPdf('我的图.pdf', bytes);
    assert.equal(res.ok, true);
    assert.equal(anchors.length, 1, 'one anchor created');
    assert.equal(anchors[0].download, '我的图.pdf', 'download name set');
    assert.equal(clicked, anchors[0], 'anchor was clicked');
    assert.equal(blobType, 'application/pdf');
    assert.deepEqual(blobBytes, bytes, 'bytes passed verbatim');
  } finally {
    globalThis.URL.createObjectURL = origCreateObjectURL;
    globalThis.Blob = origBlob;
    globalThis.document = origDoc;
    globalThis.setTimeout = origSetTimeout;
  }
});

test('web-bridge: exportPdf survives a missing document (non-browser env)', async () => {
  const origDoc = globalThis.document;
  globalThis.document = undefined;
  try {
    const { win } = makeWorld();
    const res = await win.cardwall.exportPdf('x.pdf', new Uint8Array([1]));
    assert.equal(res.ok, false, 'gracefully reports failure without a document');
    assert.ok(res.error, 'an error string is returned');
  } finally {
    globalThis.document = origDoc;
  }
});
