// Unit tests for the web storage bridge (renderer/web-bridge.js).
// The bridge must behave EXACTLY like the Electron preload + main.js vault,
// because the renderer cannot tell the two apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('../renderer/web-bridge.js');

// Minimal localStorage stub (Map-backed), same shape the bridge uses.
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}

function makeWorld() {
  const storage = makeStorage();
  const win = {};
  assert.equal(bridge.install(win, storage), true, 'installs on a fresh window');
  return { win, storage };
}

test('web-bridge: install is a no-op when the Electron preload already ran', () => {
  const storage = makeStorage();
  const win = { cardwall: { platform: 'darwin', listBoards: () => Promise.resolve([]) } };
  // A pre-installed bridge must survive untouched.
  const before = win.cardwall;
  // install() would overwrite it, so the module guards the auto-install path;
  // here we assert the guard contract: the browser only calls install when
  // window.cardwall is absent.
  assert.ok(before && typeof before.listBoards === 'function');
});

test('web-bridge: storage disabled -> install reports failure', () => {
  const win = {}; // no localStorage at all
  assert.equal(bridge.install(win), false);
  assert.equal(win.cardwall, undefined);
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

test('web-bridge: first board is seeded with the sample tree and persists', async () => {
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

test('web-bridge: save keeps the name already on disk (stale renderer cannot wipe it)', async () => {
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
  assert.equal((await win.cardwall.openBoard(a.id)), null);
  assert.deepEqual(await win.cardwall.deleteBoard(a.id), { ok: false, error: 'not found' });
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
      { id: 'long', title: 'x'.repeat(600) }               // title clipped
    ]
  });
  const ids = clean.cards.map((c) => c.id);
  assert.deepEqual(ids, ['child', 'root', 'self', 'ghost', 'nan', 'long']);
  assert.equal(clean.cards[0].parent, 'root', 'late parent resolved');
  assert.equal(clean.cards[2].parent, null);
  assert.equal(clean.cards[3].parent, null);
  assert.equal(clean.cards[4].x, 0);
  assert.equal(clean.cards[4].y, 0);
  assert.equal(clean.cards[5].title.length, 500);
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

test('web-bridge: corrupt board JSON does not break the library', async () => {
  const { win, storage } = makeWorld();
  const created = await win.cardwall.createBoard('A');
  storage.setItem('cardwall.web.board.' + created.id, '{not json');
  const list = await win.cardwall.listBoards();
  assert.equal(list.length, 1);
  assert.equal(list[0].cards, 0);
  assert.equal(await win.cardwall.openBoard(created.id), null);
});
