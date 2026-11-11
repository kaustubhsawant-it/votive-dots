'use strict';
//
// The tray icon: an org.kde.StatusNotifierItem on the session bus, with its menu (dbusmenu) at /MenuBar.
// The desktop's tray host (GNOME's AppIndicator extension, KDE Plasma, XFCE, ...) draws it. This file only talks D-Bus:
// it never reads an agent's files or runs a program.
//
const { EventEmitter } = require('events');
const { Variant } = require('./dbus/wire');
const { DbusMenu } = require('./dbus/dbusmenu');
const icon = require('./icon');

const SNI = 'org.kde.StatusNotifierItem';
const WATCHER = 'org.kde.StatusNotifierWatcher';
const ITEM_PATH = '/StatusNotifierItem';
const MENU_PATH = '/MenuBar';
const PULSE_MS = 800;
let instances = 0;   // the name is org.kde.StatusNotifierItem-<pid>-<instance>, so a second tray in one process gets its own

const escapeMarkup = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class Tray extends EventEmitter {
  /**
   * conn: a connected Connection. opts: { id, title, onActivate }.
   * The state is set with update({ states, tooltipLines, attention, shapes, colors }).
   */
  constructor(conn, opts = {}) {
    super();
    this.conn = conn;
    this.id = opts.id || 'dev.votive.Votive';
    this.title = opts.title || 'Votive Dots';
    this.menu = new DbusMenu();
    this.state = { states: [], tooltipLines: [], attention: false, shapes: false, colors: undefined, badge: false };
    this.phase = 0;
    this.status = 'Active';
    this.pixmap = icon.pixmaps([], { phase: 0 });
    this.tooltip = ['', [], this.title, ''];
    this.label = '';          // what the host is told
    this.wantedLabel = '';    // what it should show
    this.serviceName = null;
    this.registered = false;
    this._timer = null;
  }

  _setLabel(label) {
    if (label === this.label) return;
    this.label = label;
    this._emitNew('XAyatanaNewLabel', 'ss', [label, label]);
  }

  _emitNew(member, sig = '', body = []) {
    if (!this.started) return;   // nothing is listening before we are on the bus
    try { this.conn.emitSignal(ITEM_PATH, SNI, member, sig, body); } catch (e) { /* closed */ }
  }

  async start() {
    const c = this.conn;
    c.exportObject(ITEM_PATH, { [SNI]: this._definition() });
    c.exportObject(MENU_PATH, this.menu.definition());
    this.menu.onChange = (rev, what) => {
      try {
        // properties first, so a host that re-reads the layout on the second signal already has the new text
        if (what.updated.length || what.removed.length) c.emitSignal(MENU_PATH, 'com.canonical.dbusmenu', 'ItemsPropertiesUpdated', 'a(ia{sv})a(ias)', [what.updated, what.removed]);
        if (what.layout) c.emitSignal(MENU_PATH, 'com.canonical.dbusmenu', 'LayoutUpdated', 'ui', [rev, 0]);
      } catch (e) { /* closed */ }
    };
    this.serviceName = SNI + '-' + process.pid + '-' + (++instances);
    if (!(await c.requestName(this.serviceName))) throw new Error('could not own ' + this.serviceName);
    await c.addMatch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='" + WATCHER + "'");
    this._onOwner = (m) => {
      if (m.body[0] === WATCHER && m.body[2]) this._register().catch((e) => this.emit('warning', e));   // the tray host restarted: sign up again
      if (m.body[0] === WATCHER && !m.body[2]) this.registered = false;
    };
    c.on('signal:org.freedesktop.DBus.NameOwnerChanged', this._onOwner);
    this.started = true;
    await this._register();
    return this;
  }

  /** Tells the watcher about us. Returns false (and keeps waiting for a watcher to appear) when there is no tray host yet. */
  async _register() {
    try {
      await this.conn.call({ destination: WATCHER, path: '/StatusNotifierWatcher', interface: WATCHER, member: 'RegisterStatusNotifierItem', signature: 's', body: [this.serviceName] });
      this.registered = true;
    } catch (e) {
      if (e.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown' || e.dbusName === 'org.freedesktop.DBus.Error.NameHasNoOwner') { this.registered = false; return false; }
      throw e;
    }
    this.emit('registered');
    // GNOME's extension shows a label only when it changes after it is listening (the same text again is ignored), so change it once
    if (this.wantedLabel) {
      const t = setTimeout(() => {
        if (!this.started) return;
        this._setLabel('·');
        const u = setTimeout(() => this._setLabel(this.wantedLabel), 400);
        u.unref();
      }, 1500);
      t.unref();
    }
    return true;
  }

  _definition() {
    const noop = () => [];
    return {
      methods: {
        Activate: { in: 'ii', out: '', fn: (x, y) => { this.emit('activate', x, y); return []; } },
        SecondaryActivate: { in: 'ii', out: '', fn: noop },
        ContextMenu: { in: 'ii', out: '', fn: noop },   // the host draws /MenuBar itself
        Scroll: { in: 'is', out: '', fn: noop },
      },
      properties: {
        Category: { sig: 's', get: () => 'ApplicationStatus' },
        Id: { sig: 's', get: () => this.id },
        Title: { sig: 's', get: () => this.title },
        Status: { sig: 's', get: () => this.status },
        WindowId: { sig: 'u', get: () => 0 },
        IconThemePath: { sig: 's', get: () => '' },
        IconName: { sig: 's', get: () => '' },
        IconPixmap: { sig: 'a(iiay)', get: () => this.pixmap },
        OverlayIconName: { sig: 's', get: () => '' },
        OverlayIconPixmap: { sig: 'a(iiay)', get: () => [] },
        AttentionIconName: { sig: 's', get: () => '' },
        AttentionIconPixmap: { sig: 'a(iiay)', get: () => this.pixmap },
        AttentionMovieName: { sig: 's', get: () => '' },
        ToolTip: { sig: '(sa(iiay)ss)', get: () => this.tooltip },
        ItemIsMenu: { sig: 'b', get: () => true },
        Menu: { sig: 'o', get: () => MENU_PATH },
        XAyatanaLabel: { sig: 's', get: () => this.label },   // text beside the icon in hosts that draw it (GNOME's AppIndicator extension does)
        XAyatanaLabelGuide: { sig: 's', get: () => this.label },
      },
      signals: { NewTitle: '', NewIcon: '', NewAttentionIcon: '', NewOverlayIcon: '', NewToolTip: '', NewStatus: 's', XAyatanaNewLabel: 'ss' },
    };
  }

  /**
   * Shows new state. states: one state name per session in menu order. tooltipLines: plain text, one per session.
   * attention: true when a session needs the person (the host may bring the icon forward).
   * badge: a plan limit is over the threshold (a red mark on the icon, pulsing).
   * Signals go out only for what actually changed.
   */
  update(next) {
    const s = Object.assign({}, this.state, next);
    this.state = s;
    const status = s.attention ? 'NeedsAttention' : 'Active';
    if (status !== this.status) { this.status = status; this._emitNew('NewStatus', 's', [status]); }
    const tip = ['', [], this.title, s.tooltipLines.length ? s.tooltipLines.map(escapeMarkup).join('\n') : 'No agent sessions'];
    if (JSON.stringify(tip) !== JSON.stringify(this.tooltip)) { this.tooltip = tip; this._emitNew('NewToolTip'); }
    this.wantedLabel = s.label || '';
    this._setLabel(this.wantedLabel);
    this._draw();
    const pulses = s.badge || s.states.some((x) => icon.ATTENTION.has(x));
    if (pulses && !this._timer) {
      this._timer = setInterval(() => { this.phase ^= 1; this._draw(); }, PULSE_MS);
      this._timer.unref();
    } else if (!pulses && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      this.phase = 0;
      this._draw();
    }
  }

  _draw() {
    const s = this.state;
    // with a text label the row is drawn by the host as text, as big as its other items; the icon is then one full-size dot for the most urgent state
    const states = s.label && s.states.length ? [icon.mostUrgent(s.states)] : s.states;
    const pm = icon.pixmaps(states, { shapes: s.shapes, colors: s.colors, badge: s.badge, phase: this.phase });
    if (pm.every((p, i) => p[2].equals(this.pixmap[i][2]))) return;
    this.pixmap = pm;
    this._emitNew('NewIcon');
    this._emitNew('NewAttentionIcon');   // while a session needs the person the host draws the attention icon, so it must follow too (GNOME froze it otherwise)
  }

  stop() {
    this.started = false;
    if (this._onOwner) this.conn.off('signal:org.freedesktop.DBus.NameOwnerChanged', this._onOwner);
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    try { this.conn.unexportObject(ITEM_PATH); this.conn.unexportObject(MENU_PATH); } catch (e) { /* closed */ }
  }
}

module.exports = { Tray, SNI, WATCHER, ITEM_PATH, MENU_PATH };
