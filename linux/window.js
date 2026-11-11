'use strict';
//
// The Votive Dots window on Linux: a popup like the Mac's menu-bar dropdown (shapes, usage bars, a list of sessions you can click). The tray menu cannot be drawn freely, so this is a
// small optional helper, linux/ui/votive-window.py, that needs only what Ubuntu's desktop already has (python3 and GTK 3: python3-gi, gir1.2-gtk-3.0). The tray starts it when you
// ask, pushes the current state to it as JSON lines on its standard input, and reads back what you clicked, as JSON lines on its standard output. The helper has no network code,
// reads nothing else and writes nothing to disk; what it sends back is checked here before anything acts on it.
//
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'ui', 'votive-window.py');
const PYTHONS = ['/usr/bin/python3', '/bin/python3', '/usr/local/bin/python3'];
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const ENV_PASS = ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_DATA_DIRS', 'XDG_CONFIG_HOME', 'HOME', 'LANG', 'LC_ALL'];
const MAX_LINE = 4096;
const ACTIONS = new Set(['focus', 'pin', 'report', 'keepawake', 'closed']);
const NEEDS = 'Votive Dots needs python3 with GTK 3 for its window: sudo apt install python3-gi gir1.2-gtk-3.0';

/** One message from the helper, or null when it is not one we know. Only the listed actions pass, and a key must be a short string. */
function parseAction(line) {
  if (typeof line !== 'string' || line.length > MAX_LINE) return null;
  let o;
  try { o = JSON.parse(line); } catch (e) { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !ACTIONS.has(o.t)) return null;
  if ((o.t === 'focus' || o.t === 'pin') && !(typeof o.key === 'string' && o.key.length > 0 && o.key.length <= 300)) return null;
  return o.t === 'focus' || o.t === 'pin' ? { t: o.t, key: o.key } : { t: o.t };
}

class WindowHost {
  /** opts: { env, onAction(action), spawnFn, execFn, ex, script } (the last four are for tests) */
  constructor(opts = {}) {
    this.env = opts.env || process.env;
    this.onAction = opts.onAction || (() => {});
    this.spawnFn = opts.spawnFn || spawn;
    this.execFn = opts.execFn || execFile;
    this.ex = opts.ex || exists;
    this.script = opts.script || SCRIPT;
    this.parse = opts.parse || parseAction;
    this.child = null;
    this.buf = '';
    this.checked = null;     // null: not checked yet; true or an error text once known
    this.pending = null;     // the last state, sent as soon as the helper is up
  }

  get isOpen() { return !!this.child; }

  python() { return PYTHONS.find(this.ex) || null; }

  /** Is the helper's toolkit there? Asked once, answered { ok, why }. */
  check() {
    if (this.checked === true) return Promise.resolve({ ok: true, why: '' });
    if (typeof this.checked === 'string') return Promise.resolve({ ok: false, why: this.checked });
    const py = this.python();
    if (!py) { this.checked = NEEDS; return Promise.resolve({ ok: false, why: this.checked }); }
    if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) return Promise.resolve({ ok: false, why: 'no display' });
    return new Promise((resolve) => {
      let called = false;
      const done = (err) => { if (called) return; called = true; this.checked = err ? NEEDS : true; resolve(err ? { ok: false, why: NEEDS } : { ok: true, why: '' }); };
      try {
        this.execFn(py, ['-c', "import gi; gi.require_version('Gtk','3.0'); gi.require_version('Gdk','3.0'); from gi.repository import Gtk"], { timeout: 8000, env: { PATH: '/usr/bin:/bin' } }, (err) => done(err));
      } catch (e) { done(e); }
    });
  }

  /** Shows the window (or brings it forward) with this state. Resolves { ok, why }. */
  async open(state) {
    if (this.child) { this.update(state); this.send({ t: 'present' }); return { ok: true, why: '' }; }
    const c = await this.check();
    if (!c.ok) return c;
    if (this.child) { this.update(state); return { ok: true, why: '' }; }
    const childEnv = {};
    for (const k of ENV_PASS) if (this.env[k]) childEnv[k] = this.env[k];
    childEnv.PATH = '/usr/bin:/bin';
    let child;
    try { child = this.spawnFn(this.python(), [this.script], { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) { return { ok: false, why: 'could not start the window' }; }
    this.child = child;
    this.buf = '';
    child.on('error', () => this._ended());
    child.on('exit', () => this._ended());
    if (child.stdin) child.stdin.on('error', () => { /* it went away: exit reports it */ });
    if (child.stdout) child.stdout.on('data', (d) => this._data(d));
    this.update(state);
    return { ok: true, why: '' };
  }

  /** Sends the current state to an open window. A window that is not open ignores it. */
  update(state) { if (this.child) this.send(Object.assign({ t: 'state' }, state)); }

  send(obj) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return;
    try { this.child.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { /* it is going away */ }
  }

  close() {
    if (!this.child) return;
    this.send({ t: 'close' });
    const c = this.child;
    setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } }, 1000).unref();
  }

  _data(d) {
    this.buf += d.toString('utf8');
    if (this.buf.length > 4 * MAX_LINE && this.buf.indexOf('\n') < 0) { this.buf = ''; return; }
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const a = this.parse(line);
      if (a) { if (a.t === 'closed') continue; try { this.onAction(a); } catch (e) { /* an action that fails is not the window's problem */ } }
    }
  }

  _ended() { this.child = null; this.buf = ''; }
}

module.exports = { WindowHost, parseAction, SCRIPT, NEEDS };
