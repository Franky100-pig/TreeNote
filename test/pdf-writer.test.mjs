import test from 'node:test';
import assert from 'node:assert/strict';
import CardwallPdf from '../renderer/pdf-writer.js';

// A fake JPEG: SOI + a little payload + EOI. The writer never decodes the
// image, it only wraps it, so the internals don't matter for this test.
function fakeJpeg() {
  var b = [0xFF, 0xD8];
  for (var i = 0; i < 40; i++) b.push((i * 7) & 0xFF);
  b.push(0xFF, 0xD9);
  return Uint8Array.from(b);
}

function decode(bytes) {
  // Latin1 so every byte maps to one char — safe for scanning PDF structure.
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

// Parse the xref and verify each object offset really points at "N 0 obj".
function verifyXref(bytes) {
  var text = decode(bytes);
  var sx = text.lastIndexOf('startxref');
  assert.ok(sx >= 0, 'has startxref');
  var startxref = parseInt(text.slice(sx + 9).trim().split(/\s+/)[0], 10);
  var xref = text.slice(startxref);
  assert.ok(xref.startsWith('xref'), 'xref section present');
  // "xref\n0 6\n<10digits> 65535 f \n<10digits> 00000 n \n..."
  var lines = xref.split('\n');
  // lines[0]='xref', lines[1]='0 6', then offsets.
  var expected = parseInt(lines[1].trim().split(/\s+/)[1], 10); // 6
  assert.equal(expected, 6, 'xref count is 6 (1 free + 5 objects)');
  var ok = true;
  // lines[0]='xref', lines[1]='0 6', lines[2]=free entry, lines[3..]=objects 1..5
  for (var n = 1; n <= 5; n++) {
    var offLine = lines[2 + n];
    var off = parseInt(offLine.trim().split(/\s+/)[0], 10);
    var at = text.slice(off, off + 12);
    if (!new RegExp('^' + n + ' 0 obj').test(at)) {
      ok = false;
      console.error('object', n, 'offset', off, 'points at:', JSON.stringify(at));
    }
  }
  assert.ok(ok, 'every xref offset points at the correct "N 0 obj"');
}

test('buildPdfFromJpeg produces a structurally valid PDF', () => {
  var jpeg = fakeJpeg();
  var pdf = CardwallPdf.buildPdfFromJpeg(jpeg, 842, 595, 1684, 1190);
  var text = decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4'), 'PDF header');
  assert.ok(text.endsWith('%%EOF\n') || text.includes('%%EOF'), 'EOF marker');
  assert.ok(text.includes('/Type /Catalog'), 'catalog present');
  assert.ok(text.includes('/MediaBox [0 0 842.00 595.00]'), 'media box matches');
  assert.ok(text.includes('/Filter /DCTDecode'), 'JPEG filter present');
  assert.ok(text.includes('/Im0 Do'), 'image drawn in content stream');
  // The JPEG is embedded verbatim: its SOI bytes appear in the stream.
  assert.ok(text.includes(String.fromCharCode(0xFF) + String.fromCharCode(0xD8)), 'JPEG SOI embedded');
  verifyXref(pdf);
});

test('page size / orientation is reflected in MediaBox', () => {
  var pdf = CardwallPdf.buildPdfFromJpeg(fakeJpeg(), 595, 842, 100, 100);
  assert.ok(decode(pdf).includes('/MediaBox [0 0 595.00 842.00]'));
});

test('rejects empty image', () => {
  assert.throws(() => CardwallPdf.buildPdfFromJpeg(new Uint8Array(0), 100, 100, 10, 10),
    /empty image/);
});

test('rejects non-JPEG (missing SOI)', () => {
  assert.throws(() => CardwallPdf.buildPdfFromJpeg(Uint8Array.from([1, 2, 3]), 100, 100, 3, 1),
    /not a JPEG/);
});

test('rejects non-positive page or image size', () => {
  assert.throws(() => CardwallPdf.buildPdfFromJpeg(fakeJpeg(), 0, 100, 10, 10), /bad page size/);
  assert.throws(() => CardwallPdf.buildPdfFromJpeg(fakeJpeg(), 100, 100, -5, 10), /bad image size/);
});

test('image Length in the XObject matches the actual bytes', () => {
  var jpeg = fakeJpeg();
  var pdf = CardwallPdf.buildPdfFromJpeg(jpeg, 100, 100, jpeg.length, 1);
  var text = decode(pdf);
  assert.ok(text.includes('/Length ' + jpeg.length + ' >>'), 'Length equals JPEG byte count');
});
