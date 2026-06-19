/*
 * features.js — Productivity Clock feature layer
 *
 * Exposes three dependency-free globals:
 *   window.Alarms    — alarm manager (localStorage-backed, notifications, sound, vibrate)
 *   window.Countdown — pure countdown helpers
 *   window.GCal      — Google Calendar deep-link builders
 *
 * Vanilla JS only. No frameworks, no imports, no audio files.
 * All access to browser-only objects (window, Notification, navigator) is
 * guarded so this file is safe to load anywhere and passes `node --check`.
 */
(function () {
  "use strict";

  // A safe reference to the global object that works in browsers and node.
  var GLOBAL =
    (typeof window !== "undefined" && window) ||
    (typeof globalThis !== "undefined" && globalThis) ||
    {};

  /* =======================================================================
   * Small shared helpers
   * ===================================================================== */

  // Zero-pad a number to 2 digits.
  function pad2(n) {
    n = Math.floor(Math.abs(n));
    return (n < 10 ? "0" : "") + n;
  }

  // Format a Date as "HH:MM" in local time.
  function toHHMM(date) {
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  }

  // Best-effort localStorage accessors (guarded — may be unavailable / blocked).
  function lsGet(key) {
    try {
      if (typeof localStorage !== "undefined") {
        return localStorage.getItem(key);
      }
    } catch (e) {
      /* access denied or unavailable */
    }
    return null;
  }
  function lsSet(key, value) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(key, value);
      }
    } catch (e) {
      /* quota / privacy mode — ignore */
    }
  }

  /* =======================================================================
   * 1) Alarms
   * ===================================================================== */

  var ALARMS_KEY = "pc_alarms";

  // In-memory cache of the alarm list.
  var _alarms = null;

  // Dedupe set so each alarm fires at most once per "minute key".
  // Entries look like "<alarmId>@<YYYY-MM-DD-HH:MM>".
  var _firedThisMinute = new Set();

  // Load alarms from localStorage (parsed once, then cached).
  function loadAlarms() {
    if (_alarms) return _alarms;
    var raw = lsGet(ALARMS_KEY);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          _alarms = parsed;
          return _alarms;
        }
      } catch (e) {
        /* corrupt data — start fresh */
      }
    }
    _alarms = [];
    return _alarms;
  }

  // Persist the current alarm list.
  function saveAlarms() {
    lsSet(ALARMS_KEY, JSON.stringify(loadAlarms()));
  }

  // Generate a unique-enough id.
  function makeId() {
    return String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
  }

  /*
   * WebAudio beep generator.
   * Plays a short repeating beep using OscillatorNode — no audio assets.
   * Fully self-contained and guarded; returns silently if WebAudio is absent.
   */
  function playAlarmSound(opts) {
    opts = opts || {};
    var beeps = opts.beeps || 4; // number of beeps
    var beepMs = opts.beepMs || 180; // length of each beep
    var gapMs = opts.gapMs || 120; // silence between beeps
    var freq = opts.freq || 880; // tone frequency (A5)

    try {
      var Ctx = GLOBAL.AudioContext || GLOBAL.webkitAudioContext;
      if (!Ctx) return; // no WebAudio support
      var ctx = new Ctx();

      // Some browsers start the context suspended until a user gesture.
      if (ctx.state === "suspended" && typeof ctx.resume === "function") {
        try {
          ctx.resume();
        } catch (e) {
          /* ignore */
        }
      }

      var now = ctx.currentTime;
      var step = (beepMs + gapMs) / 1000;
      var dur = beepMs / 1000;

      for (var i = 0; i < beeps; i++) {
        var startAt = now + i * step;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;

        // Quick attack/decay envelope to avoid clicks.
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.25, startAt + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startAt);
        osc.stop(startAt + dur + 0.02);
      }

      // Close the context shortly after the last beep to free resources.
      var totalMs = beeps * (beepMs + gapMs) + 300;
      if (typeof setTimeout !== "undefined") {
        setTimeout(function () {
          try {
            ctx.close();
          } catch (e) {
            /* ignore */
          }
        }, totalMs);
      }
    } catch (e) {
      /* WebAudio failed — fire silently */
    }
  }

  // Trigger device vibration if supported.
  function vibrate(pattern) {
    try {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.vibrate === "function"
      ) {
        navigator.vibrate(pattern);
      }
    } catch (e) {
      /* ignore */
    }
  }

  // Show a notification if permission has been granted.
  function showNotification(label, body, tag) {
    try {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        return new Notification(label || "Alarm", {
          body: body || "",
          vibrate: [200, 100, 200],
          tag: tag
        });
      }
    } catch (e) {
      /* notification construction can throw on some platforms */
    }
    return null;
  }

  // Does `alarm` apply on the weekday of `date`? days null/empty = every day.
  function alarmMatchesDay(alarm, date) {
    if (alarm.days == null) return true;
    if (!Array.isArray(alarm.days) || alarm.days.length === 0) return true;
    return alarm.days.indexOf(date.getDay()) !== -1;
  }

  var Alarms = {
    // Callback the integrator may assign to react to a fired alarm.
    onFire: null,

    // Return the array of alarms (live reference to the cached list).
    list: function () {
      return loadAlarms();
    },

    // Create and persist a new alarm. Returns the created alarm object.
    add: function (input) {
      input = input || {};
      var alarm = {
        id: makeId(),
        time: input.time || "00:00", // "HH:MM"
        label: input.label || "Alarm",
        enabled: true,
        days: input.days != null ? input.days : null // null = every day
      };
      var list = loadAlarms();
      list.push(alarm);
      saveAlarms();
      return alarm;
    },

    // Merge `patch` into the alarm with `id`. Returns the updated alarm or null.
    update: function (id, patch) {
      var list = loadAlarms();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          patch = patch || {};
          for (var k in patch) {
            if (Object.prototype.hasOwnProperty.call(patch, k) && k !== "id") {
              list[i][k] = patch[k];
            }
          }
          saveAlarms();
          return list[i];
        }
      }
      return null;
    },

    // Remove the alarm with `id`. Returns true if something was removed.
    remove: function (id) {
      var list = loadAlarms();
      var before = list.length;
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i].id === id) list.splice(i, 1);
      }
      if (list.length !== before) {
        saveAlarms();
        return true;
      }
      return false;
    },

    // Flip the enabled flag. Returns the updated alarm or null.
    toggle: function (id) {
      var list = loadAlarms();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          list[i].enabled = !list[i].enabled;
          saveAlarms();
          return list[i];
        }
      }
      return null;
    },

    // Ask for notification permission. Async; resolves to the permission string.
    requestPermission: function () {
      try {
        if (typeof Notification === "undefined") {
          return Promise.resolve("denied");
        }
        var result = Notification.requestPermission();
        // Older API used a callback; normalise to a Promise either way.
        if (result && typeof result.then === "function") {
          return result;
        }
        return new Promise(function (resolve) {
          try {
            Notification.requestPermission(function (perm) {
              resolve(perm);
            });
          } catch (e) {
            resolve(Notification.permission || "default");
          }
        });
      } catch (e) {
        return Promise.resolve("denied");
      }
    },

    /*
     * Call this once per second with a Date.
     * Fires any enabled alarm whose time/day matches the current minute,
     * exactly once per minute (deduped via _firedThisMinute).
     */
    check: function (now) {
      if (!(now instanceof Date)) now = new Date();
      var hhmm = toHHMM(now);
      // Stable minute key for dedupe (independent of locale formatting).
      var minuteStamp =
        now.getFullYear() +
        "-" +
        pad2(now.getMonth() + 1) +
        "-" +
        pad2(now.getDate()) +
        "-" +
        hhmm;

      var list = loadAlarms();
      for (var i = 0; i < list.length; i++) {
        var alarm = list[i];
        if (!alarm.enabled) continue;
        if (alarm.time !== hhmm) continue;
        if (!alarmMatchesDay(alarm, now)) continue;

        var fireKey = alarm.id + "@" + minuteStamp;
        if (_firedThisMinute.has(fireKey)) continue; // already fired this minute
        _firedThisMinute.add(fireKey);

        this._fire(alarm, now);
      }

      // Keep the dedupe set small: drop keys not from the current minute.
      if (_firedThisMinute.size > 64) {
        var keep = new Set();
        _firedThisMinute.forEach(function (key) {
          if (key.indexOf("@" + minuteStamp) !== -1) keep.add(key);
        });
        _firedThisMinute = keep;
      }
    },

    // Internal: do the actual firing (notification + sound + vibrate + callback).
    _fire: function (alarm, now) {
      var label = alarm.label || "Alarm";
      var body = "Alarm for " + alarm.time;

      // Notification (guarded inside helper).
      try {
        showNotification(label, body, "pc-alarm-" + alarm.id);
      } catch (e) {
        /* ignore */
      }

      // Sound (guarded inside helper).
      try {
        playAlarmSound();
      } catch (e) {
        /* ignore */
      }

      // Vibrate (guarded inside helper).
      try {
        vibrate([200, 100, 200]);
      } catch (e) {
        /* ignore */
      }

      // Integrator UI callback.
      try {
        if (typeof this.onFire === "function") {
          this.onFire(alarm, now || new Date());
        }
      } catch (e) {
        /* never let a bad callback break alarm checking */
      }
    },

    // Exposed for advanced/testing use.
    _playSound: playAlarmSound
  };

  /* =======================================================================
   * 2) Countdown
   * ===================================================================== */

  var Countdown = {
    /*
     * Pure: compute the breakdown from now -> targetDate.
     * Accepts a Date or an ISO string. No side effects.
     */
    timeTill: function (targetDate) {
      var target =
        targetDate instanceof Date ? targetDate : new Date(targetDate);
      var nowMs = Date.now();
      var targetMs = target.getTime();
      var diff = targetMs - nowMs;
      var past = diff < 0;
      var abs = Math.abs(diff);

      var totalSeconds = Math.floor(abs / 1000);
      var days = Math.floor(totalSeconds / 86400);
      var hours = Math.floor((totalSeconds % 86400) / 3600);
      var minutes = Math.floor((totalSeconds % 3600) / 60);
      var seconds = totalSeconds % 60;

      return {
        days: days,
        hours: hours,
        minutes: minutes,
        seconds: seconds,
        totalMs: diff, // signed: negative when in the past
        past: past
      };
    },

    /*
     * Format a parts object into "2d 03h 14m 09s".
     * Leading zero units are omitted; smaller units are zero-padded once a
     * larger unit is present. Always shows at least seconds.
     */
    format: function (parts) {
      parts = parts || {};
      var d = parts.days || 0;
      var h = parts.hours || 0;
      var m = parts.minutes || 0;
      var s = parts.seconds || 0;

      var out = [];
      var started = false;

      if (d > 0) {
        out.push(d + "d");
        started = true;
      }
      if (started || h > 0) {
        out.push((started ? pad2(h) : h) + "h");
        started = true;
      }
      if (started || m > 0) {
        out.push((started ? pad2(m) : m) + "m");
        started = true;
      }
      // Seconds always shown.
      out.push((started ? pad2(s) : s) + "s");

      return out.join(" ");
    }
  };

  /* =======================================================================
   * 3) GCal — Google Calendar deep links
   * ===================================================================== */

  // Format a Date as compact UTC "YYYYMMDDTHHMMSSZ" for Google Calendar.
  function toGCalUTC(date) {
    var d = date instanceof Date ? date : new Date(date);
    return (
      d.getUTCFullYear() +
      pad2(d.getUTCMonth() + 1) +
      pad2(d.getUTCDate()) +
      "T" +
      pad2(d.getUTCHours()) +
      pad2(d.getUTCMinutes()) +
      pad2(d.getUTCSeconds()) +
      "Z"
    );
  }

  // Compute the next occurrence (as a Date) of an alarm relative to baseDate.
  function nextAlarmOccurrence(alarm, baseDate) {
    var base = baseDate instanceof Date ? new Date(baseDate) : new Date();
    var parts = String(alarm.time || "00:00").split(":");
    var hh = parseInt(parts[0], 10) || 0;
    var mm = parseInt(parts[1], 10) || 0;

    // Candidate today at the alarm time.
    var candidate = new Date(base);
    candidate.setHours(hh, mm, 0, 0);

    var validDay = function (date) {
      if (alarm.days == null) return true;
      if (!Array.isArray(alarm.days) || alarm.days.length === 0) return true;
      return alarm.days.indexOf(date.getDay()) !== -1;
    };

    // Look ahead up to 8 days for the next valid, future occurrence.
    for (var i = 0; i < 8; i++) {
      if (candidate.getTime() > base.getTime() && validDay(candidate)) {
        return candidate;
      }
      candidate = new Date(candidate);
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(hh, mm, 0, 0);
    }
    // Fallback: tomorrow at the alarm time.
    var fallback = new Date(base);
    fallback.setDate(fallback.getDate() + 1);
    fallback.setHours(hh, mm, 0, 0);
    return fallback;
  }

  var GCal = {
    /*
     * Build a "create event" deep link. Opens Google Calendar prefilled —
     * no API or auth required. Everything is URL-encoded.
     */
    eventLink: function (opts) {
      opts = opts || {};
      var start = opts.start instanceof Date ? opts.start : new Date(opts.start);

      var end;
      if (opts.end != null) {
        end = opts.end instanceof Date ? opts.end : new Date(opts.end);
      } else {
        // Default duration: 25 minutes after start.
        end = new Date(start.getTime() + 25 * 60 * 1000);
      }

      var params = [];
      params.push("action=TEMPLATE");
      params.push("text=" + encodeURIComponent(opts.title || ""));
      params.push(
        "dates=" +
          encodeURIComponent(toGCalUTC(start) + "/" + toGCalUTC(end))
      );
      if (opts.details != null) {
        params.push("details=" + encodeURIComponent(opts.details));
      }
      if (opts.location != null) {
        params.push("location=" + encodeURIComponent(opts.location));
      }

      return (
        "https://calendar.google.com/calendar/render?" + params.join("&")
      );
    },

    /*
     * Build a calendar event for an alarm's next occurrence, with a 0-minute
     * duration and a popup reminder. This is the "fire when the app is closed"
     * fallback — the user adds it to their real calendar.
     */
    alarmReminderLink: function (alarm, baseDate) {
      alarm = alarm || {};
      var occ = nextAlarmOccurrence(alarm, baseDate);
      var params = [];
      params.push("action=TEMPLATE");
      params.push("text=" + encodeURIComponent(alarm.label || "Alarm"));
      // Zero-minute duration: start == end.
      params.push(
        "dates=" + encodeURIComponent(toGCalUTC(occ) + "/" + toGCalUTC(occ))
      );
      params.push(
        "details=" +
          encodeURIComponent(
            "Productivity Clock alarm reminder. Set a popup notification."
          )
      );
      // Hint Google Calendar to attach a popup reminder at event time.
      params.push("reminders=" + encodeURIComponent("popup,0"));

      return (
        "https://calendar.google.com/calendar/render?" + params.join("&")
      );
    },

    // Exposed for testing/reuse.
    _toGCalUTC: toGCalUTC,
    _nextAlarmOccurrence: nextAlarmOccurrence
  };

  /* =======================================================================
   * Publish globals
   * ===================================================================== */

  GLOBAL.Alarms = Alarms;
  GLOBAL.Countdown = Countdown;
  GLOBAL.GCal = GCal;
})();
