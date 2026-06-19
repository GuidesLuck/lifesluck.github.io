/**
 * ClockEngine — Productivity Clock rendering/animation engine.
 *
 * Vanilla JS, dependency-free, no build step, no modules. Exposes a single
 * global: window.ClockEngine.
 *
 * Conventions used throughout:
 *  - The analog clock lives inside an <svg viewBox="0 0 200 200">.
 *  - Center is (100, 100); face radius is ~92.
 *  - Angles are in DEGREES, with 12 o'clock = 0deg and clockwise positive.
 *    This matches SVG's rotate(<deg> cx cy) which rotates clockwise for
 *    positive values in the default coordinate system.
 *  - All theme-able colors are expressed via CSS custom properties so that
 *    a stylesheet/theme can restyle the clock without touching this engine:
 *      --pc-face   face fill
 *      --pc-tick   minute/hour ticks
 *      --pc-text   hour numerals
 *      --pc-hour   hour hand
 *      --pc-minute minute hand
 *      --pc-second second hand
 */
(function (global) {
  'use strict';

  // ---- Geometry constants -------------------------------------------------
  var CENTER = 100;     // cx / cy
  var RADIUS = 92;      // face radius
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ---- Small DOM helpers --------------------------------------------------

  /**
   * Create an SVG element in the SVG namespace and apply the given attributes.
   * @param {string} name - tag name (e.g. 'circle', 'line', 'text')
   * @param {Object} [attrs] - attribute name/value pairs
   * @returns {SVGElement}
   */
  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          node.setAttribute(key, attrs[key]);
        }
      }
    }
    return node;
  }

  /**
   * Convert a clock angle (degrees, 0 = 12 o'clock, clockwise positive)
   * into an {x, y} point on a circle of the given radius around center.
   * Used for laying out static geometry (ticks, numerals).
   * @param {number} angleDeg
   * @param {number} r
   * @returns {{x:number, y:number}}
   */
  function pointOnCircle(angleDeg, r) {
    // Convert "12 o'clock = 0, clockwise" to standard math radians.
    // Standard math: 0rad points +x (3 o'clock), counter-clockwise positive.
    // Our 0deg points up (-y) and goes clockwise, so:
    var rad = (angleDeg - 90) * Math.PI / 180;
    return {
      x: CENTER + r * Math.cos(rad),
      y: CENTER + r * Math.sin(rad)
    };
  }

  // ---- Public: buildAnalog -----------------------------------------------

  /**
   * Populate an existing empty <svg viewBox="0 0 200 200"> with a full analog
   * clock face: face circle, 60 minute ticks (12 thicker hour ticks), hour
   * numerals 1-12, three hands, and a center cap.
   *
   * Hands are created so that applying transform="rotate(<deg> 100 100)"
   * orients them correctly (each hand is drawn pointing straight up at 0deg).
   *
   * Hand element ids:
   *   #pc-hand-hour  #pc-hand-minute  #pc-hand-second
   *
   * @param {SVGSVGElement} svgEl - the target empty SVG element
   * @returns {SVGSVGElement} the same element (for chaining)
   */
  function buildAnalog(svgEl) {
    if (!svgEl) {
      throw new Error('ClockEngine.buildAnalog: svgEl is required');
    }

    // Ensure a sane viewBox even if the caller forgot to set one.
    if (!svgEl.getAttribute('viewBox')) {
      svgEl.setAttribute('viewBox', '0 0 200 200');
    }

    // Clear any prior content so the call is idempotent.
    while (svgEl.firstChild) {
      svgEl.removeChild(svgEl.firstChild);
    }

    // --- Face circle ---
    svgEl.appendChild(el('circle', {
      cx: CENTER,
      cy: CENTER,
      r: RADIUS,
      fill: 'var(--pc-face)',
      stroke: 'var(--pc-tick)',
      'stroke-width': 2
    }));

    // --- Minute / hour ticks ---
    // 60 ticks total; every 5th tick (hours) is longer and thicker.
    var ticks = el('g', { 'stroke-linecap': 'round' });
    for (var i = 0; i < 60; i++) {
      var isHour = (i % 5 === 0);
      var angle = i * 6; // 360 / 60
      // Tick lengths measured inward from the rim.
      var outer = pointOnCircle(angle, RADIUS - 2);
      var inner = pointOnCircle(angle, RADIUS - (isHour ? 10 : 5));
      ticks.appendChild(el('line', {
        x1: outer.x.toFixed(3),
        y1: outer.y.toFixed(3),
        x2: inner.x.toFixed(3),
        y2: inner.y.toFixed(3),
        stroke: 'var(--pc-tick)',
        'stroke-width': isHour ? 2.4 : 1
      }));
    }
    svgEl.appendChild(ticks);

    // --- Hour numerals 1-12 ---
    var numerals = el('g', {
      'font-family': 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
      'font-size': 13,
      'font-weight': 600,
      'text-anchor': 'middle',
      fill: 'var(--pc-text)'
    });
    var numeralRadius = RADIUS - 22;
    for (var n = 1; n <= 12; n++) {
      var pos = pointOnCircle(n * 30, numeralRadius);
      var label = el('text', {
        x: pos.x.toFixed(3),
        // dominant-baseline keeps text vertically centered on its point;
        // a small dy fallback helps engines that ignore it.
        y: pos.y.toFixed(3),
        'dominant-baseline': 'central'
      });
      label.textContent = String(n);
      numerals.appendChild(label);
    }
    svgEl.appendChild(numerals);

    // --- Hands ---
    // Each hand points straight up (toward 12) at 0deg, anchored at center,
    // so a rotate(angle 100 100) transform aims it. We use <line> for hour
    // and minute, and a <line> with an extended tail for the second hand.

    // Hour hand: short, thick.
    svgEl.appendChild(el('line', {
      id: 'pc-hand-hour',
      x1: CENTER,
      y1: CENTER + 8,          // small tail behind the center
      x2: CENTER,
      y2: CENTER - 50,         // length toward 12
      stroke: 'var(--pc-hour)',
      'stroke-width': 5,
      'stroke-linecap': 'round',
      transform: 'rotate(0 100 100)'
    }));

    // Minute hand: longer, medium.
    svgEl.appendChild(el('line', {
      id: 'pc-hand-minute',
      x1: CENTER,
      y1: CENTER + 12,
      x2: CENTER,
      y2: CENTER - 72,
      stroke: 'var(--pc-minute)',
      'stroke-width': 3.2,
      'stroke-linecap': 'round',
      transform: 'rotate(0 100 100)'
    }));

    // Second hand: longest, thin, with a visible counterweight tail.
    svgEl.appendChild(el('line', {
      id: 'pc-hand-second',
      x1: CENTER,
      y1: CENTER + 18,
      x2: CENTER,
      y2: CENTER - 80,
      stroke: 'var(--pc-second)',
      'stroke-width': 1.4,
      'stroke-linecap': 'round',
      transform: 'rotate(0 100 100)'
    }));

    // --- Center cap ---
    svgEl.appendChild(el('circle', {
      cx: CENTER,
      cy: CENTER,
      r: 3.4,
      fill: 'var(--pc-second)',
      stroke: 'var(--pc-face)',
      'stroke-width': 1
    }));

    return svgEl;
  }

  // ---- Angle computation (shared by updateAnalog) -------------------------

  /**
   * Compute smooth forward (clockwise) angles for all three hands.
   * @param {Date} date
   * @returns {{hour:number, minute:number, second:number}}
   */
  function computeAngles(date) {
    var h = date.getHours();
    var m = date.getMinutes();
    var s = date.getSeconds();
    var ms = date.getMilliseconds();

    return {
      // 30deg per hour, plus fractional progress from minutes/seconds.
      hour: ((h % 12) + m / 60 + s / 3600) * 30,
      // 6deg per minute, plus fractional progress from seconds.
      minute: (m + s / 60) * 6,
      // 6deg per second, plus fractional progress from ms (smooth sweep).
      second: (s + ms / 1000) * 6
    };
  }

  // ---- Public: updateAnalog ----------------------------------------------

  /**
   * Update the three hand transforms for the given time. Intended to be called
   * once per animation frame for a smooth sweep.
   *
   * Modes (via opts):
   *   reverseSeconds: only the second hand counts down / sweeps CCW.
   *   reverseAll:     all three hands sweep CCW. Wins if both flags set.
   *
   * @param {Date} date
   * @param {{reverseSeconds?:boolean, reverseAll?:boolean}} [opts]
   */
  function updateAnalog(date, opts) {
    opts = opts || {};
    var reverseAll = !!opts.reverseAll;
    // reverseAll wins; reverseSeconds only applies when reverseAll is off.
    var reverseSeconds = !reverseAll && !!opts.reverseSeconds;

    var a = computeAngles(date);

    var hourAngle = a.hour;
    var minuteAngle = a.minute;
    var secondAngle = a.second;

    if (reverseAll) {
      // Mirror every hand to sweep counter-clockwise.
      hourAngle = 360 - hourAngle;
      minuteAngle = 360 - minuteAngle;
      secondAngle = 360 - secondAngle;
    } else if (reverseSeconds) {
      // Only the second hand counts down toward the next minute. At :00 it's
      // at the top (360 -> rendered as top) and sweeps backward, arriving at
      // the top again at the next :00.
      secondAngle = 360 - secondAngle;
    }

    applyHand('pc-hand-hour', hourAngle);
    applyHand('pc-hand-minute', minuteAngle);
    applyHand('pc-hand-second', secondAngle);
  }

  // Cache hand lookups so we don't query the DOM every frame.
  var handCache = {};

  /**
   * Apply a rotation transform to a hand by id, with light caching.
   * @param {string} id
   * @param {number} angleDeg
   */
  function applyHand(id, angleDeg) {
    var node = handCache[id];
    if (!node || !node.isConnected) {
      node = document.getElementById(id);
      handCache[id] = node;
    }
    if (node) {
      node.setAttribute(
        'transform',
        'rotate(' + angleDeg.toFixed(3) + ' 100 100)'
      );
    }
  }

  // ---- Public: formatDigital ---------------------------------------------

  /**
   * Format a Date for the digital readout.
   *
   * In reverse modes (reverseSeconds OR reverseAll), the seconds field shows
   * the countdown to the next minute (60 - seconds), where 60 is shown as 00.
   *
   * @param {Date} date
   * @param {{reverseSeconds?:boolean, reverseAll?:boolean}} [opts]
   * @returns {{hh:string, mm:string, ss:string, hh12:string,
   *            ampm:string, display:string}}
   */
  function formatDigital(date, opts) {
    opts = opts || {};
    var reverse = !!opts.reverseSeconds || !!opts.reverseAll;

    var h24 = date.getHours();
    var m = date.getMinutes();
    var s = date.getSeconds();

    // Seconds value depends on mode.
    var secValue;
    if (reverse) {
      secValue = 60 - s;     // countdown to next minute
      if (secValue === 60) { // when real seconds == 0 -> show 00, not 60
        secValue = 0;
      }
    } else {
      secValue = s;
    }

    // 12-hour conversion.
    var h12 = h24 % 12;
    if (h12 === 0) { h12 = 12; }
    var ampm = h24 < 12 ? 'AM' : 'PM';

    var hh = pad2(h24);
    var mm = pad2(m);
    var ss = pad2(secValue);

    return {
      hh: hh,
      mm: mm,
      ss: ss,
      hh12: pad2(h12),
      ampm: ampm,
      display: hh + ':' + mm + ':' + ss
    };
  }

  /**
   * Zero-pad a non-negative integer to two digits.
   * @param {number} v
   * @returns {string}
   */
  function pad2(v) {
    return String(v).padStart(2, '0');
  }

  // ---- Export -------------------------------------------------------------
  global.ClockEngine = {
    buildAnalog: buildAnalog,
    updateAnalog: updateAnalog,
    formatDigital: formatDigital
  };

})(typeof window !== 'undefined' ? window : this);
