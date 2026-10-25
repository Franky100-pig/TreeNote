/**
 * cardwall export geometry — pure helpers shared by the canvas renderer.
 *
 * Everything here is DOM-free so it can be unit-tested in Node (no canvas,
 * no browser). The browser-only canvas drawing lives in export-pdf.js and
 * calls into these.
 *
 * UMD-wrapped: `CardwallGeom.*` in the browser, `require(...)` in tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardwallGeom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Theme palettes mirrored 1:1 from styles.css so the export looks exactly
  // like the on-screen wall (dark = black canvas, light = paper). 'auto' is
  // resolved by the caller (app.js already knows the active theme).
  var THEME_COLORS = {
    dark: {
      bg: '#000000',
      ink: '#e8e6e1',
      muted: '#8d887c',
      surface: '#16161a',
      surfaceBorder: '#2b2b31',
      rootBorder: '#6b5c33',
      edge: '#5a5a64'
    },
    light: {
      bg: '#f7f5f0',
      ink: '#3d3a34',
      muted: '#8a8577',
      surface: '#ffffff',
      surfaceBorder: '#e8e4da',
      rootBorder: '#d8cfae',
      edge: '#c9c2b3'
    }
  };

  // Six preset card pigments, exactly the rgba/tint pairs from styles.css.
  // null colour (default surface) is handled by cardColorTokens returning null.
  var CARD_COLORS = {
    dark: {
      amber:  { wash: 'rgba(201,169,80,0.10)',  tint: '#c9a950' },
      rose:   { wash: 'rgba(224,122,138,0.10)', tint: '#e07a8a' },
      sky:    { wash: 'rgba(106,169,224,0.10)', tint: '#6aa9e0' },
      mint:   { wash: 'rgba(110,200,170,0.10)', tint: '#6ec8aa' },
      violet: { wash: 'rgba(167,139,250,0.10)', tint: '#a78bfa' },
      lime:   { wash: 'rgba(163,214,108,0.10)', tint: '#a3d66c' }
    },
    light: {
      amber:  { wash: 'rgba(201,169,80,0.16)',  tint: '#9a7d2a' },
      rose:   { wash: 'rgba(224,122,138,0.14)', tint: '#b04a5c' },
      sky:    { wash: 'rgba(106,169,224,0.16)', tint: '#2f6ea8' },
      mint:   { wash: 'rgba(110,200,170,0.16)', tint: '#2e8a6e' },
      violet: { wash: 'rgba(167,139,250,0.14)', tint: '#6d4fc4' },
      lime:   { wash: 'rgba(163,214,108,0.18)', tint: '#5d8a2e' }
    }
  };

  function getTheme(theme) {
    return THEME_COLORS[theme === 'light' ? 'light' : 'dark'];
  }

  // Returns { wash, tint } for a preset colour, or null for the default
  // surface. Unknown names (sanitised away upstream) fall back to null too.
  function cardColorTokens(name, theme) {
    var table = CARD_COLORS[theme === 'light' ? 'light' : 'dark'];
    if (!name || !table[name]) return null;
    return table[name];
  }

  // Axis-aligned bounding box of every card, in world units. Cards are centred
  // at (x, y); half-extents come from the live DOM size (domW/domH) when
  // available, else the configured w/h. Returns null when there are no cards.
  function computeBBox(cards) {
    if (!cards || cards.length === 0) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var w = (c.domW || c.w || 250);
      var h = (c.domH || c.h || 60);
      var hw = w / 2, hh = h / 2;
      var x = c.x || 0, y = c.y || 0;
      if (x - hw < minX) minX = x - hw;
      if (x + hw > maxX) maxX = x + hw;
      if (y - hh < minY) minY = y - hh;
      if (y + hh > maxY) maxY = y + hh;
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY };
  }

  var A4 = { w: 595.28, h: 841.89 }; // points (1pt = 1/72 in)

  // Fit `bbox` onto a page with a margin, auto-picking portrait/landscape by
  // aspect ratio (the orientation that yields the larger scale wins, so a wide
  // board never gets squashed). Returns the page size, the uniform scale, and
  // the page-space origin of the bbox's top-left corner (y-up, as PDF wants).
  function fitPage(bbox, opts) {
    opts = opts || {};
    var paper = opts.paper || A4;
    var margin = opts.margin == null ? 36 : opts.margin; // ~12.7mm
    var bw = bbox.w > 0 ? bbox.w : 1;
    var bh = bbox.h > 0 ? bbox.h : 1;

    function scaleFor(pw, ph) {
      return Math.min((pw - 2 * margin) / bw, (ph - 2 * margin) / bh);
    }
    var sPortrait = scaleFor(paper.w, paper.h);
    var sLandscape = scaleFor(paper.h, paper.w);
    var landscape = sLandscape >= sPortrait;
    var pageW = landscape ? paper.h : paper.w;
    var pageH = landscape ? paper.w : paper.h;
    var scale = landscape ? sLandscape : sPortrait;

    var contentW = pageW - 2 * margin;
    var contentH = pageH - 2 * margin;
    var originX = margin + (contentW - bw * scale) / 2;
    var originY = margin + (contentH - bh * scale) / 2;
    return {
      pageW: pageW, pageH: pageH, scale: scale,
      originX: originX, originY: originY, orientation: landscape ? 'landscape' : 'portrait'
    };
  }

  // Greedy word/character wrapping. `measure(ch)` returns the advance width of
  // a single character (the caller passes ctx.measureText in the browser). We
  // wrap per character so CJK (no spaces) and Latin both work; explicit '\n'
  // in the input always forces a break.
  function wrapText(text, maxWidth, measure) {
    if (text == null) return [];
    var paragraphs = String(text).split('\n');
    var out = [];
    for (var p = 0; p < paragraphs.length; p++) {
      var para = paragraphs[p];
      if (para.length === 0) { out.push(''); continue; }
      var line = '';
      var lineW = 0;
      for (var i = 0; i < para.length; i++) {
        var ch = para[i];
        var cw = measure(ch);
        if (lineW + cw > maxWidth && line.length > 0) {
          out.push(line);
          line = ch;
          lineW = cw;
        } else {
          line += ch;
          lineW += cw;
        }
      }
      out.push(line);
    }
    return out;
  }

  // Filesystem/URL-safe filename: strip path separators and reserved chars,
  // collapse runs of spaces, cap length, fall back to 'cardwall'.
  function sanitizeFilename(name) {
    var s = (name == null ? '' : String(name)).replace(/[\/\\:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ').trim();
    if (!s) s = 'cardwall';
    if (s.length > 80) s = s.slice(0, 80).trim();
    return s;
  }

  return {
    THEME_COLORS: THEME_COLORS,
    CARD_COLORS: CARD_COLORS,
    A4: A4,
    getTheme: getTheme,
    cardColorTokens: cardColorTokens,
    computeBBox: computeBBox,
    fitPage: fitPage,
    wrapText: wrapText,
    sanitizeFilename: sanitizeFilename
  };
});
