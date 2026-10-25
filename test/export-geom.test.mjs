import test from 'node:test';
import assert from 'node:assert/strict';
import G from '../renderer/export-geom.js';

test('computeBBox wraps cards around their centre', () => {
  var b = G.computeBBox([{ x: 0, y: 0, w: 250, h: 60 }]);
  assert.equal(b.minX, -125);
  assert.equal(b.maxX, 125);
  assert.equal(b.w, 250);
  assert.equal(b.h, 60);
});

test('computeBBox spans multiple cards', () => {
  var b = G.computeBBox([
    { x: 0, y: 0, w: 200, h: 50 },
    { x: 400, y: 300, w: 200, domH: 80 }
  ]);
  assert.equal(b.minX, -100);
  assert.equal(b.maxX, 500);
  assert.equal(b.w, 600);
  assert.equal(b.h, 365); // minY -25 .. maxY 340
});

test('computeBBox returns null for no cards', () => {
  assert.equal(G.computeBBox([]), null);
  assert.equal(G.computeBBox(null), null);
});

test('fitPage picks landscape for a wide board', () => {
  var fit = G.fitPage({ minX: 0, minY: 0, maxX: 2000, maxY: 500, w: 2000, h: 500 });
  assert.equal(fit.orientation, 'landscape');
  assert.equal(fit.pageW, 841.89);
  assert.equal(fit.pageH, 595.28);
  // scale = (842-72)/2000 = 0.384945
  assert.ok(Math.abs(fit.scale - 0.384945) < 1e-6, 'scale = 0.384945, got ' + fit.scale);
  // centred: horizontal slack is zero, so originX = margin
  assert.ok(Math.abs(fit.originX - 36) < 1e-6);
});

test('fitPage picks portrait for a tall board', () => {
  var fit = G.fitPage({ minX: 0, minY: 0, maxX: 400, maxY: 2000, w: 400, h: 2000 });
  assert.equal(fit.orientation, 'portrait');
  assert.equal(fit.pageW, 595.28);
});

test('fitPage keeps the board inside the page (no overflow)', () => {
  var b = { minX: -100, minY: -50, maxX: 900, maxY: 750, w: 1000, h: 800 };
  var fit = G.fitPage(b, { margin: 36 });
  var right = fit.originX + b.w * fit.scale;
  var top = fit.originY + b.h * fit.scale;
  assert.ok(right <= fit.pageW - 36 + 1e-6, 'right edge inside page');
  assert.ok(top <= fit.pageH - 36 + 1e-6, 'top edge inside page');
});

test('wrapText breaks by character width', () => {
  var measure = function () { return 10; }; // every char 10 wide
  var lines = G.wrapText('abc', 25, measure); // 2 chars per line
  assert.deepEqual(lines, ['ab', 'c']);
});

test('wrapText honours explicit newlines', () => {
  var measure = function () { return 10; };
  assert.deepEqual(G.wrapText('a\nbc', 100, measure), ['a', 'bc']);
});

test('wrapText handles empty and single-line', () => {
  var measure = function () { return 10; };
  assert.deepEqual(G.wrapText('', 100, measure), ['']);
  assert.deepEqual(G.wrapText('hi', 100, measure), ['hi']);
});

test('cardColorTokens returns pigment pairs and null for defaults', () => {
  assert.deepEqual(G.cardColorTokens('amber', 'dark'), { wash: 'rgba(201,169,80,0.10)', tint: '#c9a950' });
  assert.deepEqual(G.cardColorTokens('sky', 'light'), { wash: 'rgba(106,169,224,0.16)', tint: '#2f6ea8' });
  assert.equal(G.cardColorTokens(null, 'dark'), null);
  assert.equal(G.cardColorTokens('not-a-color', 'dark'), null);
});

test('getTheme resolves auto to dark and light to light', () => {
  assert.equal(G.getTheme('light').bg, '#f7f5f0');
  assert.equal(G.getTheme('dark').bg, '#000000');
  assert.equal(G.getTheme('auto').bg, '#000000'); // auto -> dark default
  assert.equal(G.getTheme(undefined).bg, '#000000');
});

test('sanitizeFilename strips reserved chars and falls back', () => {
  assert.equal(G.sanitizeFilename('my/board:name'), 'my_board_name');
  assert.equal(G.sanitizeFilename(''), 'cardwall');
  assert.equal(G.sanitizeFilename('a*b?c'), 'a_b_c');
  var long = 'x'.repeat(200);
  assert.ok(G.sanitizeFilename(long).length <= 80);
});
