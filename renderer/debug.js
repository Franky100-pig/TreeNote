/**
 * cardwall debug overlay (C7): F3 toggles a live stats panel plus
 * anchor / velocity markers inside the world, so feel problems can be
 * diagnosed against the actual force field instead of guessed at.
 *
 * Markers live in the SVG layer (world coordinates, so they pan and zoom
 * with the content); the panel is fixed in the viewport corner.
 */
(function () {
  'use strict';

  var REFRESH_MS = 100; // 10Hz: cheap enough but still reads as live

  function init(opts) {
    var viewport = opts.viewport;
    var world = opts.world;
    var view = opts.view;
    var edgesEl = opts.edgesEl;
    var physics = opts.physics;

    var panel = document.getElementById('debug-panel');
    var on = false;
    var lastRefresh = 0;
    var frameTimes = [];

    var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('id', 'debug-layer');
    g.style.display = 'none';
    edgesEl.appendChild(g);

    function mark(tag, attrs) {
      var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      g.appendChild(el);
      return el;
    }

    function setOn(v) {
      on = v;
      panel.classList.toggle('visible', on);
      g.style.display = on ? '' : 'none';
      if (on) lastRefresh = 0; // force an immediate redraw
    }

    function toggle() { setOn(!on); }

    function draw() {
      while (g.firstChild) g.removeChild(g.firstChild);
      var biggest = 0;
      world.cards.forEach(function (c) {
        // anchor marker (where the snap spring wants the card)
        var a = world.anchors.get(c.id);
        if (a) {
          mark('circle', {
            cx: a.x.toFixed(1), cy: a.y.toFixed(1), r: 4,
            class: 'dbg-anchor'
          });
          mark('line', {
            x1: c.x.toFixed(1), y1: c.y.toFixed(1),
            x2: a.x.toFixed(1), y2: a.y.toFixed(1),
            class: 'dbg-anchor-line'
          });
        }
        // velocity vector (0.25s lookahead)
        var sp = Math.hypot(c.vx, c.vy);
        biggest = Math.max(biggest, sp);
        if (sp > 1) {
          mark('line', {
            x1: c.x.toFixed(1), y1: c.y.toFixed(1),
            x2: (c.x + c.vx * 0.25).toFixed(1), y2: (c.y + c.vy * 0.25).toFixed(1),
            class: 'dbg-vel'
          });
        }
      });
      return biggest;
    }

    /** Called once per rendered frame; cheap unless the overlay is on. */
    function update(now, dtMs) {
      frameTimes.push(dtMs);
      if (frameTimes.length > 30) frameTimes.shift();
      if (!on) return;
      if (now - lastRefresh < REFRESH_MS) return;
      lastRefresh = now;

      var biggest = draw();
      var avg = 0;
      for (var i = 0; i < frameTimes.length; i++) avg += frameTimes[i];
      avg = frameTimes.length ? avg / frameTimes.length : 0;
      var energy = physics.totalEnergy(world);

      panel.textContent = [
        'fps      ' + (avg > 0 ? (1000 / avg).toFixed(0) : '—'),
        'cards    ' + world.cards.length,
        'time     ' + world.time.toFixed(2) + 's',
        'scale    ' + view.scale.toFixed(3),
        'max |v|  ' + biggest.toFixed(0) + ' px/s',
        'energy   ' + energy.toFixed(0),
        'tween    ' + (opts.isTweening && opts.isTweening() ? 'on' : 'off'),
        'paused   ' + (opts.isPaused && opts.isPaused() ? 'yes' : 'no')
      ].join('\n');
    }

    // F3 (with Fn on Macs) or Cmd+Shift+D.
    window.addEventListener('keydown', function (e) {
      var isF3 = e.key === 'F3';
      var isChord = (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'D' || e.key === 'd');
      if (!isF3 && !isChord) return;
      e.preventDefault();
      toggle();
    });

    return {
      toggle: toggle,
      isOn: function () { return on; },
      update: update
    };
  }

  window.CardDebug = { init: init };
})();
