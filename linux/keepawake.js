'use strict';
//
// Keep awake (the Mac app's Caffeinate): stops the machine going idle-asleep or locking itself while on, using a systemd inhibitor lock.
// The lock belongs to a small child process, so it is dropped when that process ends. The child also checks every 5 seconds that the tray
// is still alive and ends itself if not, so a crashed tray can never leave the machine awake for good. It starts off every time the tray starts,
// and the state is never saved, so the menu can never claim more than what is held.
//
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BIN_DIRS = ['/usr/bin', '/bin'];
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const find = (name, ex = exists) => { for (const d of BIN_DIRS) if (ex(path.join(d, name))) return path.join(d, name); return null; };

/** The command for the inhibitor, or null when systemd-inhibit or sh is missing. */
function command(ownerPid, ex = exists) {
  const inhibit = find('systemd-inhibit', ex), sh = find('sh', ex);
  if (!inhibit || !sh) return null;
  return {
    bin: inhibit,
    args: ['--what=idle:sleep', '--who=Votive Dots', '--why=Votive Dots: keep awake is on', '--mode=block',
      sh, '-c', 'while kill -0 "$1" 2>/dev/null; do sleep 5; done', 'votive-keepawake', String(ownerPid)],
  };
}

class KeepAwake {
  constructor({ spawnFn = spawn, ownerPid = process.pid, ex = exists, onChange } = {}) {
    this.spawnFn = spawnFn; this.ownerPid = ownerPid; this.ex = ex; this.onChange = onChange || (() => {});
    this.child = null;
  }

  get isOn() { return this.child !== null; }

  /** Returns whether the requested state was reached. */
  set(on) {
    if (on === this.isOn) return true;
    if (!on) { this._stop(); return true; }
    const cmd = command(this.ownerPid, this.ex);
    if (!cmd) return false;
    let child;
    try { child = this.spawnFn(cmd.bin, cmd.args, { stdio: 'ignore' }); } catch (e) { return false; }
    this.child = child;
    child.on('error', () => { if (this.child === child) { this.child = null; this.onChange(false); } });
    child.on('exit', () => { if (this.child === child) { this.child = null; this.onChange(false); } });   // the lock went with it
    this.onChange(true);
    return true;
  }

  toggle() { return this.set(!this.isOn); }

  _stop() {
    const c = this.child;
    this.child = null;
    if (c) { try { c.kill(); } catch (e) { /* already gone */ } }
    this.onChange(false);
  }

  stop() { if (this.child) this._stop(); }
}

module.exports = { KeepAwake, command };
