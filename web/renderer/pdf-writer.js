/**
 * cardwall PDF writer — self-contained, zero dependencies.
 *
 * Builds a minimal but valid PDF (PDF 1.4) that embeds a single JPEG image as
 * a full-page image. We do this instead of pulling in a library (jsPDF) because
 * the renderer has no bundler and the whole app is deliberately dependency-free;
 * a hand-rolled PDF that wraps a JPEG is only a few dozen lines and is trivial
 * to verify byte-for-byte in tests.
 *
 * Why an image PDF? The board is drawn by canvas (so CJK text, card colours and
 * bezier edges all render exactly as on screen) and the canvas is exported as a
 * JPEG. No font embedding, no glyph metrics, no surprises — the PDF is just a
 * container for that one image filling the page.
 *
 * The module is UMD-wrapped so the same file runs in the browser (renderer) and
 * Node (unit tests): `CardwallPdf.buildPdfFromJpeg(...)`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardwallPdf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 10-digit, space-padded, zero-filled offset used by the xref table.
  function pad10(n) {
    var s = String(n);
    while (s.length < 10) s = '0' + s;
    return s;
  }

  function concat(parts) {
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  /**
   * Build a PDF that places `jpeg` (raw JPEG file bytes, must start with
   * 0xFFD8) filling a page of `wPt` x `hPt` PDF points (1pt = 1/72 inch).
   * `imgW` / `imgH` are the JPEG pixel dimensions (the caller knows them from
   * the canvas, so we don't have to parse the JPEG header).
   *
   * Returns a Uint8Array. Throws on obviously invalid input.
   */
  function buildPdfFromJpeg(jpeg, wPt, hPt, imgW, imgH) {
    if (!jpeg || jpeg.length < 2) throw new Error('pdf-writer: empty image');
    if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) throw new Error('pdf-writer: not a JPEG (missing SOI)');
    if (!isFinite(wPt) || !isFinite(hPt) || wPt <= 0 || hPt <= 0) {
      throw new Error('pdf-writer: bad page size');
    }
    if (!isFinite(imgW) || !isFinite(imgH) || imgW <= 0 || imgH <= 0) {
      throw new Error('pdf-writer: bad image size');
    }

    var enc = new TextEncoder();
    function s(str) { return enc.encode(str); }

    // Sequential object assembly with live byte-offset tracking.
    var chunks = [];
    function tell() {
      var n = 0;
      for (var i = 0; i < chunks.length; i++) n += chunks[i].length;
      return n;
    }
    // Appends an object definition, returns its start offset (for xref).
    function obj(num, dict, streamBody) {
      var start = tell();
      chunks.push(s(num + ' 0 obj\n' + dict + '\n'));
      if (streamBody) {
        var body = (typeof streamBody === 'string') ? s(streamBody) : streamBody;
        chunks.push(s('stream\n'), body, s('\nendstream\n'));
      }
      chunks.push(s('endobj\n'));
      return start;
    }

    var header = s('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');
    chunks.push(header);

    var offs = {};
    offs[1] = obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    offs[2] = obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    offs[3] = obj(3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
      wPt.toFixed(2) + ' ' + hPt.toFixed(2) + '] ' +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
    offs[4] = obj(4,
      '<< /Type /XObject /Subtype /Image /Width ' + imgW + ' /Height ' + imgH +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
      jpeg.length + ' >>', jpeg);
    // Place the image flipped vertically: PDF image space is bottom-up, so the
    // negative-y scale + y-translation right itself. cm args: a b c d e f.
    var content = 'q\n' + wPt.toFixed(2) + ' 0 0 -' + hPt.toFixed(2) +
      ' 0 ' + hPt.toFixed(2) + ' cm\n/Im0 Do\nQ\n';
    offs[5] = obj(5, '<< /Length ' + s(content).length + ' >>', content);

    var xrefStart = tell();
    var xref = s('xref\n0 6\n0000000000 65535 f \n');
    for (var n = 1; n <= 5; n++) {
      xref = concat([xref, s(pad10(offs[n]) + ' 00000 n \n')]);
    }
    chunks.push(xref);
    chunks.push(s(
      'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' +
      String(xrefStart) + '\n%%EOF\n'));

    return concat(chunks);
  }

  return { buildPdfFromJpeg: buildPdfFromJpeg };
});
