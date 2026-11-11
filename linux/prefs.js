'use strict';
//
// Switches of this tray that are not agent-settable. On the Mac these are plain preferences of the app (`portToolsOn`); the settings that agents can change
// (Scripts/overlay-settings.js, also the MCP tool) deliberately do not include them, so a program an agent runs cannot turn the Ports tool on.
// Here they live in ~/.votive/linux-prefs.json, written only by the tray.
//
const fs = require('fs');
const path = require('path');

const NAMES = ['portToolsOn'];
const palettes = require('./palettes');
const MAX_FILE_BYTES = 4096;

class PrefsStore {
  constructor(root) { this.root = root; this.file = path.join(root, 'linux-prefs.json'); this._key = null; this._value = {}; }

  /** { portToolsOn: bool } (only known names, only true booleans count); parsed again only when the file changed. A missing or broken file is "all off". */
  read() {
    let key = 'missing';
    try { const st = fs.statSync(this.file); key = st.size > MAX_FILE_BYTES ? 'big' : st.mtimeMs + ':' + st.size; } catch (e) { /* no file */ }
    if (key === this._key) return this._value;
    let v = {};
    if (key !== 'missing' && key !== 'big') {
      try { const o = JSON.parse(fs.readFileSync(this.file, 'utf8')); for (const n of NAMES) if (o && o[n] === true) v[n] = true; if (o && palettes.IDS.includes(o.palette) && o.palette !== 'default') v.palette = o.palette; } catch (e) { /* unreadable: all off */ }
    }
    this._key = key; this._value = v;
    return v;
  }

  isKnown(name) { return NAMES.includes(name); }

  /** The chosen dot colour set ("default" when none). */
  palette() { return this.read().palette || 'default'; }

  /** Chooses a dot colour set by id. Anything that is not one of ours is refused. */
  setPalette(id) {
    if (!palettes.IDS.includes(id)) throw new Error('unknown colour set ' + id);
    const next = Object.assign({}, this.read());
    if (id === 'default') delete next.palette; else next.palette = id;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this._key = null;
    return id;
  }

  /** Flips one switch. Returns its new value. */
  toggle(name) {
    if (!this.isKnown(name)) throw new Error('unknown switch ' + name);
    const next = Object.assign({}, this.read());
    if (next[name]) delete next[name]; else next[name] = true;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this._key = null;
    return next[name] === true;
  }
}

module.exports = { PrefsStore, NAMES };
