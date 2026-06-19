/**
 * app.js — Productivity Time controller / integrator.
 *
 * Wires the four specialist modules together:
 *   ClockEngine (clock.js) · PC_THEMES (themes.js) · Alarms/Countdown/GCal (features.js)
 *
 * Vanilla JS, no build step. Owns: view + theme + direction state, the rAF
 * tick loop, the Tools sheet (alarms + "time till"), persistence, PWA install,
 * and service-worker registration.
 */
(function () {
  'use strict';

  // ---- Element lookups ----------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };

  var root        = $('pc-root');
  var svg         = $('pc-analog');
  var digital     = $('pc-digital');
  var digitalTime = $('pc-digital-time');
  var digitalMeta = $('pc-digital-meta');

  var viewToggle  = $('pc-view-toggle');
  var directionEl = $('pc-direction');
  var themeEl     = $('pc-theme');
  var toolsBtn    = $('pc-tools-btn');
  var installBtn  = $('pc-install');

  var sheet       = $('pc-sheet');
  var backdrop    = $('pc-sheet-backdrop');
  var sheetClose  = $('pc-sheet-close');

  var notifBtn    = $('pc-notif-btn');
  var alarmTime   = $('pc-alarm-time');
  var alarmLabel  = $('pc-alarm-label');
  var alarmAdd    = $('pc-alarm-add');
  var alarmList   = $('pc-alarm-list');

  var tillTarget  = $('pc-till-target');
  var tillDisplay = $('pc-till-display');
  var tillGcal    = $('pc-till-gcal');

  var toast       = $('pc-toast');
  var themeColorMeta = $('pc-theme-color');

  // ---- Settings persistence ----------------------------------------------
  var SETTINGS_KEY = 'pc_settings';
  var DEFAULTS = { view: 'analog', direction: 'reverseSeconds', theme: 'focus' };

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  var settings = loadSettings();

  // ---- Direction → ClockEngine opts --------------------------------------
  function dirOpts() {
    if (settings.direction === 'reverseAll') return { reverseAll: true };
    if (settings.direction === 'reverseSeconds') return { reverseSeconds: true };
    return {};
  }

  // ---- Theme --------------------------------------------------------------
  function populateThemes() {
    var themes = (typeof window !== 'undefined' && window.PC_THEMES) || [{ id: 'focus', name: 'Deep Focus' }];
    themeEl.innerHTML = '';
    themes.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      themeEl.appendChild(opt);
    });
    // Guard against a saved theme that no longer exists.
    if (!themes.some(function (t) { return t.id === settings.theme; })) {
      settings.theme = themes[0].id;
    }
    themeEl.value = settings.theme;
  }

  function applyTheme(id) {
    settings.theme = id;
    root.className = 'pc-root theme-' + id;
    // Sync the browser/OS chrome color to the theme background.
    try {
      var bg = getComputedStyle(root).getPropertyValue('--pc-bg').trim();
      if (bg && themeColorMeta) themeColorMeta.setAttribute('content', bg);
    } catch (e) {}
    saveSettings();
  }

  // ---- View (analog / digital) -------------------------------------------
  function applyView(view) {
    settings.view = view;
    var isAnalog = view === 'analog';
    svg.hidden = !isAnalog;
    digital.hidden = isAnalog;
    // Button shows the destination, not the current state.
    viewToggle.textContent = isAnalog ? 'Digital' : 'Analog';
    saveSettings();
  }

  // ---- The tick loop ------------------------------------------------------
  var lastSecond = -1;

  function frame() {
    var now = new Date();
    var opts = dirOpts();

    if (settings.view === 'analog') {
      ClockEngine.updateAnalog(now, opts);
    }

    var sec = now.getSeconds();
    if (sec !== lastSecond) {
      lastSecond = sec;

      // Digital readout (updates once per second is plenty).
      if (settings.view === 'digital') {
        var f = ClockEngine.formatDigital(now, opts);
        digitalTime.textContent = f.display;
        digitalMeta.textContent = formatMeta(now, f);
      }

      // Alarm engine: check every second.
      if (window.Alarms && typeof window.Alarms.check === 'function') {
        window.Alarms.check(now);
      }

      // Live countdown, if a target is set and the sheet is open.
      updateTill(now);
    }

    requestAnimationFrame(frame);
  }

  function formatMeta(now, f) {
    var date = now.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric'
    });
    return date + ' · ' + f.ampm;
  }

  // ---- Tools sheet --------------------------------------------------------
  function openSheet() {
    backdrop.hidden = false;
    sheet.hidden = false;
    renderAlarms();
    updateTill(new Date());
  }
  function closeSheet() {
    backdrop.hidden = true;
    sheet.hidden = true;
  }

  // ---- Alarms UI ----------------------------------------------------------
  function renderAlarms() {
    if (!window.Alarms) return;
    var items = window.Alarms.list();
    alarmList.innerHTML = '';

    if (!items.length) {
      var empty = document.createElement('li');
      empty.className = 'pc-empty';
      empty.textContent = 'No alarms yet. Add one above.';
      alarmList.appendChild(empty);
      return;
    }

    items.forEach(function (a) {
      var li = document.createElement('li');
      li.className = 'pc-list-item' + (a.enabled ? '' : ' pc-alarm-off');

      var meta = document.createElement('div');
      meta.className = 'pc-alarm-meta';
      var time = document.createElement('span');
      time.className = 'pc-alarm-time';
      time.textContent = a.time;
      var label = document.createElement('span');
      label.className = 'pc-alarm-label';
      label.textContent = a.label || 'Alarm';
      meta.appendChild(time);
      meta.appendChild(label);

      var toggle = document.createElement('button');
      toggle.className = 'pc-icon-btn';
      toggle.type = 'button';
      toggle.textContent = a.enabled ? 'On' : 'Off';
      toggle.addEventListener('click', function () {
        window.Alarms.toggle(a.id);
        renderAlarms();
      });

      var gcal = document.createElement('a');
      gcal.className = 'pc-icon-btn';
      gcal.textContent = '📅';
      gcal.title = 'Add to Google Calendar (fires even when app is closed)';
      gcal.target = '_blank';
      gcal.rel = 'noopener';
      try { gcal.href = window.GCal.alarmReminderLink(a, new Date()); } catch (e) { gcal.href = '#'; }

      var del = document.createElement('button');
      del.className = 'pc-icon-btn';
      del.type = 'button';
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Delete alarm');
      del.addEventListener('click', function () {
        window.Alarms.remove(a.id);
        renderAlarms();
      });

      li.appendChild(meta);
      li.appendChild(toggle);
      li.appendChild(gcal);
      li.appendChild(del);
      alarmList.appendChild(li);
    });
  }

  function addAlarm() {
    if (!window.Alarms) return;
    var t = (alarmTime.value || '').trim();
    if (!t) { showToast('Pick a time first'); return; }
    window.Alarms.add({ time: t, label: (alarmLabel.value || '').trim(), days: null });
    alarmLabel.value = '';
    // Nudge for notification permission on first alarm.
    if (window.Notification && Notification.permission === 'default') {
      window.Alarms.requestPermission();
    }
    renderAlarms();
    showToast('Alarm set for ' + t);
  }

  // ---- "How much time till" ----------------------------------------------
  function currentTarget() {
    if (!tillTarget.value) return null;
    var d = new Date(tillTarget.value);
    return isNaN(d.getTime()) ? null : d;
  }

  function updateTill(now) {
    if (sheet.hidden || !window.Countdown) return;
    var target = currentTarget();
    if (!target) { tillDisplay.textContent = '—'; tillGcal.setAttribute('aria-disabled', 'true'); return; }

    var parts = window.Countdown.timeTill(target);
    tillDisplay.textContent = parts.past ? 'That moment has passed' : window.Countdown.format(parts);

    try {
      tillGcal.href = window.GCal.eventLink({
        title: 'Countdown target',
        start: target,
        details: 'Created in Productivity Time'
      });
      tillGcal.setAttribute('aria-disabled', 'false');
    } catch (e) {
      tillGcal.setAttribute('aria-disabled', 'true');
    }
  }

  // ---- Toast --------------------------------------------------------------
  var toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2600);
  }

  // ---- PWA install + service worker --------------------------------------
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(function () {
      deferredPrompt = null;
      installBtn.hidden = true;
    });
  });
  window.addEventListener('appinstalled', function () { installBtn.hidden = true; });

  function registerSW() {
    if ('serviceWorker' in navigator) {
      // Relative path so it works under /productivity-clock/.
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('SW registration failed:', e);
      });
    }
  }

  // ---- Wire events --------------------------------------------------------
  viewToggle.addEventListener('click', function () {
    applyView(settings.view === 'analog' ? 'digital' : 'analog');
    // Refresh digital immediately so it doesn't wait a second.
    if (settings.view === 'digital') {
      var f = ClockEngine.formatDigital(new Date(), dirOpts());
      digitalTime.textContent = f.display;
      digitalMeta.textContent = formatMeta(new Date(), f);
    }
  });

  directionEl.addEventListener('change', function () {
    settings.direction = directionEl.value;
    saveSettings();
  });

  themeEl.addEventListener('change', function () { applyTheme(themeEl.value); });

  toolsBtn.addEventListener('click', openSheet);
  sheetClose.addEventListener('click', closeSheet);
  backdrop.addEventListener('click', closeSheet);

  notifBtn.addEventListener('click', function () {
    if (!window.Alarms) return;
    window.Alarms.requestPermission().then(function (p) {
      showToast(p === 'granted' ? 'Notifications enabled' : 'Notifications: ' + p);
    });
  });

  alarmAdd.addEventListener('click', addAlarm);
  tillTarget.addEventListener('change', function () { updateTill(new Date()); });

  if (window.Alarms) {
    window.Alarms.onFire = function (a) {
      showToast('⏰ ' + (a.label || 'Alarm') + ' — ' + a.time);
      if (!sheet.hidden) renderAlarms();
    };
  }

  // ---- Boot ---------------------------------------------------------------
  function init() {
    ClockEngine.buildAnalog(svg);
    populateThemes();
    applyTheme(settings.theme);
    directionEl.value = settings.direction;
    applyView(settings.view);
    registerSW();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
