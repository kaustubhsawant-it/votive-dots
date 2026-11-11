'use strict';
//
// Desktop alerts for the Linux tray: a notification through org.freedesktop.Notifications and a sound, by the same rules as the Mac app.
//   - the first look at the sessions is a baseline: nothing fires for sessions that were already there
//   - a message a session was asked to send (the notify tool, or a plan-limit message) shows when "notifyOnRequest" is on
//   - "bannerOnEveryChange" or "popupOnEveryChange" (both mean a notification here) shows one when a session finishes, needs you, errors or stops
//   - each session has one notification that is replaced, not a stack of them
//   - sounds follow the sound settings and play even when notifications are off, if "sounds" is on
// Text from a session is clipped before it is shown.
//
const { Variant } = require('./dbus/wire');

const NOTIFY = { destination: 'org.freedesktop.Notifications', path: '/org/freedesktop/Notifications', interface: 'org.freedesktop.Notifications' };
const MAX_STALE_MS = 5 * 60 * 1000;   // a message older than this at first sight is history (the tray was not running when it was sent)

const SOUND_FOR = { needsInput: 'soundNeedsYou', warning: 'soundError', stuck: 'soundStuck', stopped: 'soundStopped', done: 'soundDone' };
const BANNER_STATES = new Set(['done', 'needsInput', 'warning', 'stopped']);
const URGENCY = { needsInput: 2, warning: 2, stopped: 2, done: 1 };   // freedesktop: 0 low, 1 normal, 2 critical
const VERB = { done: 'finished', needsInput: 'needs you', warning: 'hit an error', stopped: 'stopped' };

const audible = (v) => typeof v === 'string' && v !== '' && v.toLowerCase() !== 'none';
const clip = (s, n) => { const c = Array.from(String(s == null ? '' : s)); return c.length > n ? c.slice(0, n - 1).join('') + '…' : c.join(''); };
const escapeMarkup = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class Alerter {
  /**
   * opts: { conn, settings: () => {name: value}, play: (soundSetting) => bool, now: () => ms, gate?: (session) => bool, notify?: override for tests }
   * `settings` returns plain values keyed by the setting names of Scripts/overlay-settings.js.
   */
  constructor(opts) {
    this.conn = opts.conn;
    this.settings = opts.settings;
    this.play = opts.play || (() => false);
    this.now = opts.now || Date.now;
    this.gate = opts.gate || null;     // (session) => may an AUTOMATIC alert fire for it? ('only high-priority sessions'); a requested message ignores it
    this.sendNotification = opts.notify || ((n) => this._dbusNotify(n));
    this.prev = null;                 // key -> state, null until the first look
    this.lastNotifyAt = new Map();    // key -> notifyAt already shown
    this.ids = new Map();             // key -> notification id, so the next one replaces it
  }

  /** Looks at the current sessions; sends what is due. Returns the list of alerts it raised (for tests and logs). */
  observe(sessions) {
    const cfg = this.settings();
    const raised = [];
    const states = new Map(sessions.map((s) => [s.key, s.state]));
    const first = this.prev === null;
    for (const s of sessions) {
      // 1. a message the session was asked to send
      if (s.notifyMessage && s.notifyAt && s.notifyAt > (this.lastNotifyAt.get(s.key) || 0)) {
        const fresh = this.now() - s.notifyAt <= MAX_STALE_MS;
        if (!first || fresh) {
          this.lastNotifyAt.set(s.key, s.notifyAt);
          if (fresh && cfg.notifyOnRequest !== false) raised.push(this._alert(s, s.agentName + ' · ' + s.name, s.notifyMessage, 'notify', 1, 'soundNotify', cfg));
        } else this.lastNotifyAt.set(s.key, s.notifyAt);   // old and unseen: remember it so it never shows later
      }
      // 2. a change of state
      const before = this.prev ? this.prev.get(s.key) : undefined;
      if (!first && before !== s.state && (before !== undefined || s.state !== 'starting') && (!this.gate || this.gate(s))) {
        const banner = (cfg.bannerOnEveryChange === true || cfg.popupOnEveryChange === true) && BANNER_STATES.has(s.state);
        const sound = SOUND_FOR[s.state];
        if (banner) raised.push(this._alert(s, s.agentName + ' ' + VERB[s.state], s.name + (s.prompt ? ': ' + s.prompt : ''), s.state, URGENCY[s.state] || 1, sound, cfg));
        else if (sound && cfg.sounds !== false) { const snd = cfg[sound]; if (audible(snd) && this.play(snd)) raised.push({ key: s.key, kind: s.state, sound: snd }); }
      }
    }
    for (const k of [...this.lastNotifyAt.keys()]) if (!states.has(k)) this.lastNotifyAt.delete(k);
    for (const k of [...this.ids.keys()]) if (!states.has(k)) this.ids.delete(k);
    this.prev = states;
    return raised;
  }

  _alert(s, title, body, kind, urgency, soundName, cfg) {
    const a = { key: s.key, kind, title: clip(title, 80), body: clip(body, 300), urgency };
    this.sendNotification(a);
    if (cfg.sounds !== false && soundName && audible(cfg[soundName]) && this.play(cfg[soundName])) a.sound = cfg[soundName];
    return a;
  }

  _dbusNotify(a) {
    const replaces = this.ids.get(a.key) || 0;
    const hints = new Map([['urgency', new Variant('y', a.urgency)], ['desktop-entry', new Variant('s', 'votive')]]);
    this.conn.call(Object.assign({ member: 'Notify', signature: 'susssasa{sv}i', body: ['Votive Dots', replaces, '', a.title, escapeMarkup(a.body), [], hints, a.urgency === 2 ? 0 : 8000] }, NOTIFY), 5000)
      .then(([id]) => { if (Number.isInteger(id) && id > 0) this.ids.set(a.key, id); })
      .catch(() => { /* no notification service: the tray icon still shows the state */ });
  }
}

module.exports = { Alerter, NOTIFY, SOUND_FOR, clip };
