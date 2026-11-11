'use strict';
//
// Sounds for the Linux tray. A setting is "none", a macOS sound name (the settings are shared with the Mac app, so the names are
// mapped to the freedesktop sound theme), or a file name in ~/.votive/sounds. Playing starts a player the system already has
// (canberra-gtk-play, paplay or pw-play), found in fixed system folders and never through PATH. Nothing is sent to it but a sound.
//
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// macOS sound -> freedesktop sound naming specification id
const THEME = {
  Basso: 'dialog-error', Blow: 'bell', Bottle: 'message', Frog: 'message-new-instant', Funk: 'dialog-warning', Glass: 'complete', Hero: 'service-login',
  Morse: 'dialog-information', Ping: 'message-new-instant', Pop: 'message', Purr: 'message', Sosumi: 'dialog-error', Submarine: 'phone-incoming-call', Tink: 'dialog-information',
};
const BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'];
const THEME_DIRS = ['/usr/share/sounds/freedesktop/stereo', '/usr/share/sounds/ubuntu/stereo', '/usr/share/sounds/gnome/default/alerts'];
const FILE_EXT = /\.(wav|ogg|oga|flac|opus)$/i;   // what paplay and pw-play can open; mp3 and m4a cannot be played here
const MIN_GAP_MS = 400;
const MAX_PLAY_MS = 10000;

const defaultFs = { exists: (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } } };

function findBin(name, fsx = defaultFs) {
  for (const d of BIN_DIRS) { const p = path.join(d, name); if (fsx.exists(p)) return p; }
  return null;
}

/** The command that plays `setting`, as { bin, args }, or null when there is nothing to play or nothing to play it with. */
function soundCommand(setting, { soundsDir, fsx = defaultFs } = {}) {
  if (typeof setting !== 'string' || !setting || setting.toLowerCase() === 'none') return null;
  const theme = THEME[setting];
  if (theme) {
    const canberra = findBin('canberra-gtk-play', fsx);
    if (canberra) return { bin: canberra, args: ['-i', theme] };
    for (const d of THEME_DIRS) for (const ext of ['.oga', '.ogg', '.wav']) {
      const file = path.join(d, theme + ext);
      const player = findBin('paplay', fsx) || findBin('pw-play', fsx);
      if (player && fsx.exists(file)) return { bin: player, args: [file] };
    }
    return null;
  }
  // a file the person put in ~/.votive/sounds: a plain name, never a path
  if (!soundsDir || setting.includes('/') || setting.includes('\\') || setting.startsWith('.') || !FILE_EXT.test(setting)) return null;
  const file = path.join(soundsDir, setting);
  const player = findBin('paplay', fsx) || findBin('pw-play', fsx);
  return player && fsx.exists(file) ? { bin: player, args: [file] } : null;
}

/** Plays a setting, at most once per MIN_GAP_MS, for at most MAX_PLAY_MS. Returns true when a player was started. */
function makePlayer({ soundsDir, spawnFn = spawn, now = Date.now, fsx = defaultFs } = {}) {
  let last = 0;
  return function play(setting) {
    const cmd = soundCommand(setting, { soundsDir, fsx });
    if (!cmd) return false;
    const t = now();
    if (t - last < MIN_GAP_MS) return false;
    last = t;
    try {
      const child = spawnFn(cmd.bin, cmd.args, { stdio: 'ignore', timeout: MAX_PLAY_MS });
      child.on('error', () => { /* the player vanished: no sound, no crash */ });
      child.unref();
      return true;
    } catch (e) { return false; }
  };
}

module.exports = { THEME, soundCommand, makePlayer, findBin, FILE_EXT };
