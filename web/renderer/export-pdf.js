/**
 * cardwall PDF export — browser canvas renderer.
 *
 * Draws the current board (cards + bezier edges + CJK-capable text) onto a
 * high-resolution offscreen canvas that matches the active theme, JPEG-encodes
 * it, and hands the bytes to CardwallPdf (which wraps them in a PDF). Kept
 * browser-only on purpose: it needs Canvas2D, which is unavailable in Node.
 *
 * The pure geometry/layout decisions live in export-geom.js so they can be
 * unit-tested without a DOM; this file only does the pixel pushing.
 */
(function (root) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Where a ray from `center` toward (dx,dy) exits a box of half-extents hw,hh.
  function borderPoint(cx, cy, hw, hh, dx, dy) {
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    var sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    var sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    var t = Math.min(sx, sy);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function drawEdges(ctx, cards, geo, theme) {
    var byId = {};
    for (var i = 0; i < cards.length; i++) byId[cards[i].id] = cards[i];
    ctx.strokeStyle = theme.edge;
    ctx.lineWidth = Math.max(1.2, 1.6 * geo.k);
    ctx.lineCap = 'round';
    for (i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c.parent || !byId[c.parent]) continue;
      var p = byId[c.parent];
      var cw = (c.domW || c.w || 250) * geo.k / 2;
      var ch = (c.domH || c.h || 60) * geo.k / 2;
      var pw = (p.domW || p.w || 250) * geo.k / 2;
      var ph = (p.domH || p.h || 60) * geo.k / 2;
      var ccx = geo.ox + (c.x - geo.bbox.minX) * geo.k;
      var ccy = geo.oy + (geo.bbox.maxY - c.y) * geo.k;
      var pcx = geo.ox + (p.x - geo.bbox.minX) * geo.k;
      var pcy = geo.oy + (geo.bbox.maxY - p.y) * geo.k;
      var dx = ccx - pcx, dy = ccy - pcy;
      var len = Math.hypot(dx, dy) || 1;
      var ux = dx / len, uy = dy / len;
      var a = borderPoint(pcx, pcy, pw, ph, ux, uy);
      var b = borderPoint(ccx, ccy, cw, ch, -ux, -uy);
      // Gentle bow perpendicular to the axis, like the on-screen bezier edges.
      var bow = len * 0.06;
      var nx = -uy, ny = ux;
      var c1x = a.x + (b.x - a.x) / 3 + nx * bow;
      var c1y = a.y + (b.y - a.y) / 3 + ny * bow;
      var c2x = a.x + 2 * (b.x - a.x) / 3 + nx * bow;
      var c2y = a.y + 2 * (b.y - a.y) / 3 + ny * bow;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, b.x, b.y);
      ctx.stroke();
    }
  }

  function drawCard(ctx, c, geo, theme, themeName) {
    var w = (c.domW || c.w || 250) * geo.k;
    var h = (c.domH || c.h || 60) * geo.k;
    var cx = geo.ox + (c.x - geo.bbox.minX) * geo.k;
    var cy = geo.oy + (geo.bbox.maxY - c.y) * geo.k;
    var left = cx - w / 2;
    var top = cy - h / 2;
    var radius = 10 * geo.k;

    var tokens = CardwallGeom.cardColorTokens(c.color, themeName);
    var fill = tokens ? tokens.wash : theme.surface;
    var border = tokens ? tokens.tint : (c.parent ? theme.surfaceBorder : theme.rootBorder);

    // Soft shadow (reset immediately so text isn't blurred).
    ctx.save();
    ctx.shadowColor = themeName === 'light' ? 'rgba(61,58,52,0.12)' : 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 8 * geo.k;
    ctx.shadowOffsetY = 3 * geo.k;
    roundRect(ctx, left, top, w, h, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();

    // Border (and the 3px left colour bar for tinted cards).
    roundRect(ctx, left, top, w, h, radius);
    ctx.lineWidth = Math.max(1, 1 * geo.k);
    ctx.strokeStyle = border;
    ctx.stroke();
    if (tokens) {
      var barW = Math.max(3 * geo.k, 3);
      ctx.save();
      roundRect(ctx, left, top, w, h, radius);
      ctx.clip();
      ctx.fillStyle = tokens.tint;
      ctx.fillRect(left, top, barW, h);
      ctx.restore();
    }

    // Text. Proportions mirror styles.css (title 14/600, note 12, pad 10x12).
    var padX = 12 * geo.k;
    var padY = 10 * geo.k;
    var titleFont = 14 * geo.k;
    var noteFont = 12 * geo.k;
    var lhTitle = titleFont * 1.4;
    var lhNote = noteFont * 1.4;
    var maxTextW = w - 2 * padX;

    var title = c.title || '';
    var note = c.note || '';
    var measure = function (ch) { return ctx.measureText(ch).width; };

    var titleLines = CardwallGeom.wrapText(title, maxTextW, measure);
    var titleMax = Math.max(1, Math.floor((h * 0.5) / lhTitle));
    var titleClip = titleLines.length > titleMax;
    if (titleClip) titleLines = titleLines.slice(0, titleMax);
    // Note area = remaining height after the (possibly clipped) title block.
    var usedByTitle = titleLines.length * lhTitle;
    var noteArea = (h - 2 * padY) - usedByTitle;
    var noteMax = Math.max(1, Math.floor(noteArea / lhNote));
    var noteLines = CardwallGeom.wrapText(note, maxTextW, measure);
    var noteClip = noteLines.length > noteMax;
    if (noteClip) noteLines = noteLines.slice(0, noteMax);

    var tx = left + padX;
    var ty = top + padY + titleFont; // baseline-ish (textBaseline 'alphabetic')

    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = theme.ink;
    ctx.font = '600 ' + titleFont.toFixed(2) + 'px -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
    for (var i = 0; i < titleLines.length; i++) {
      var line = titleLines[i];
      if (titleClip && i === titleLines.length - 1 && endsMid(titleLines, title, maxTextW, measure)) {
        line = ellipsize(ctx, line, maxTextW);
      }
      ctx.fillText(line, tx, ty + i * lhTitle);
    }
    ty = top + padY + usedByTitle + noteFont;
    ctx.fillStyle = theme.muted;
    ctx.font = noteFont.toFixed(2) + 'px -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
    for (i = 0; i < noteLines.length; i++) {
      line = noteLines[i];
      if (noteClip && i === noteLines.length - 1 && endsMid(noteLines, note, maxTextW, measure)) {
        line = ellipsize(ctx, line, maxTextW);
      }
      ctx.fillText(line, tx, ty + i * lhNote);
    }
  }

  // Did the wrapping actually truncate this paragraph (so we should add "…")?
  function endsMid(lines, original, maxW, measure) {
    if (!original) return false;
    var joined = lines.join('\n');
    if (joined.length >= original.length) return false;
    return true;
  }

  function ellipsize(ctx, line, maxW) {
    var ell = '…';
    var ew = ctx.measureText(ell).width;
    var s = line;
    while (s.length > 0 && ctx.measureText(s + ell).width > maxW) {
      s = s.slice(0, -1);
    }
    return s + ell;
  }

  /**
   * Render the board to an offscreen canvas. Returns { canvas, pageW, pageH }.
   * `opts.theme` is 'dark' | 'light' (already resolved from auto).
   */
  function renderBoardToPdf(cards, opts) {
    opts = opts || {};
    var themeName = opts.theme === 'light' ? 'light' : 'dark';
    var theme = CardwallGeom.getTheme(themeName);
    var bbox = CardwallGeom.computeBBox(cards);
    if (!bbox) bbox = { minX: -300, minY: -200, maxX: 300, maxY: 200, w: 600, h: 400 };
    var fit = CardwallGeom.fitPage(bbox, { margin: 36 });
    // High resolution: 300 DPI keeps card text and bezier edges crisp when the
    // board is scaled down to fit the page. (The on-screen wall is WYSIWYG — we
    // only raise the raster density, never change the layout.)
    var dpi = opts.dpi || 300;
    var scaleToPx = dpi / 72;
    var pxW = Math.max(1, Math.round(fit.pageW * scaleToPx));
    var pxH = Math.max(1, Math.round(fit.pageH * scaleToPx));
    var canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, pxW, pxH);

    var geo = {
      k: fit.scale * scaleToPx,
      ox: fit.originX * scaleToPx,
      oy: fit.originY * scaleToPx,
      bbox: bbox
    };
    if (cards && cards.length) {
      drawEdges(ctx, cards, geo, theme);
      for (var i = 0; i < cards.length; i++) drawCard(ctx, cards[i], geo, theme, themeName);
    }
    return { canvas: canvas, pageW: fit.pageW, pageH: fit.pageH };
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('toBlob returned null')); return; }
          var fr = new FileReader();
          fr.onload = function () {
            resolve(new Uint8Array(fr.result));
          };
          fr.onerror = function () { reject(fr.error); };
          fr.readAsArrayBuffer(blob);
        }, 'image/jpeg', quality == null ? 0.95 : quality);
      } else {
        // Fallback for very old engines.
        var dataUrl = canvas.toDataURL('image/jpeg', quality == null ? 0.95 : quality);
        var bin = atob(dataUrl.split(',')[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(arr);
      }
    });
  }

  // Assemble the final PDF bytes from the rendered canvas.
  function buildPdfFromCanvas(render, quality) {
    var pageW = render.pageW, pageH = render.pageH;
    var cw = render.canvas.width, ch = render.canvas.height;
    return canvasToJpeg(render.canvas, quality).then(function (bytes) {
      return CardwallPdf.buildPdfFromJpeg(bytes, pageW, pageH, cw, ch);
    });
  }

  root.CardwallExport = {
    renderBoardToPdf: renderBoardToPdf,
    canvasToJpeg: canvasToJpeg,
    buildPdfFromCanvas: buildPdfFromCanvas
  };
})(typeof self !== 'undefined' ? self : this);
