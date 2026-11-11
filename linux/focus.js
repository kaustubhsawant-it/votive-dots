'use strict';
//
// "Go to terminal": brings the window that hosts an agent session to the front. The same idea as the Mac's TerminalFocus.swift: walk up the
// process tree from the agent to the first ancestor that owns a window, then raise that window.
//
// What it can and cannot do, said plainly:
//   - X11 only. It asks `wmctrl -lp` (or `xdotool search`) which windows exist and which process owns each, and raises one with `wmctrl -ia`
//     (or `xdotool windowactivate`). Under Wayland another program's window cannot be raised by an outside program at all; the GNOME
//     extension planned for a later phase is the only route there.
//   - It picks a window, not a tab. A terminal with several windows in one process (gnome-terminal) is resolved by the folder name in the window
//     title when it can be, and otherwise the first window of that process is raised.
//   - It raises a window. It never types into one, never reads one and never sends a key to anything.
//
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'];
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const find = (name, ex = exists) => { for (const d of BIN_DIRS) if (ex(path.join(d, name))) return path.join(d, name); return null; };
const WINDOW_ID = /^0x[0-9a-fA-F]{1,16}$/;

/** `wmctrl -lp` output to [{ id, pid, title }]. Lines that do not look right are skipped. */
function parseWmctrl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+\S+\s?(.*)$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[3], 10);
    if (pid > 0) out.push({ id: m[1], pid, title: m[4] });
  }
  return out;
}

/** Picks the window for a session: the nearest ancestor that owns a window; among several, the one whose title names the folder. */
function pickWindow(chainPids, windows, cwd) {
  const folder = cwd ? path.basename(String(cwd).replace(/\/+$/, '')).toLowerCase() : '';
  for (const pid of chainPids) {
    const mine = windows.filter((w) => w.pid === pid);
    if (!mine.length) continue;
    if (mine.length > 1 && folder) {
      const named = mine.find((w) => w.title.toLowerCase().includes(folder));
      if (named) return named;
    }
    return mine[0];
  }
  return null;
}

function run(bin, args, env = process.env) {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: 3000, env: { PATH: '/usr/bin:/bin', DISPLAY: env.DISPLAY || '', XAUTHORITY: env.XAUTHORITY || '', HOME: process.env.HOME || '' } },
      (err, stdout) => resolve({ ok: !err, out: stdout || '' }));
  });
}

/** What this desktop session allows: { ok, why }. */
function availability(env = process.env, ex = exists) {
  if (!env.DISPLAY) return { ok: false, why: env.WAYLAND_DISPLAY ? 'Wayland does not let one program raise another\'s window' : 'no display' };
  if (!find('wmctrl', ex) && !find('xdotool', ex)) return { ok: false, why: 'install wmctrl (sudo apt install wmctrl)' };
  return { ok: true, why: '' };
}

/**
 * Raises the window hosting `session` ({ pid, cwd }). deps (for tests): ancestry(pid) -> [{pid}], run(bin, args), ex, env.
 * Returns { ok, why, window }.
 */
async function focusSession(session, deps = {}) {
  const env = deps.env || process.env, ex = deps.ex || exists, runner = deps.run || ((bin, args) => run(bin, args, env));
  const avail = availability(env, ex);
  if (!avail.ok) return { ok: false, why: avail.why };
  if (!Number.isInteger(session.pid) || session.pid <= 1) return { ok: false, why: 'this session did not record which process it runs in' };
  const ancestry = deps.ancestry || ((pid) => require('../Scripts/proc-info').ancestry(pid, 16));
  const chain = ancestry(session.pid).map((n) => n.pid);
  if (!chain.length) return { ok: false, why: 'the session\'s process is gone' };
  const wmctrl = find('wmctrl', ex), xdotool = find('xdotool', ex);
  let windows = [];
  if (wmctrl) windows = parseWmctrl((await runner(wmctrl, ['-lp'])).out);
  else {
    for (const pid of chain) {
      const r = await runner(xdotool, ['search', '--pid', String(pid)]);
      for (const id of r.out.split('\n')) if (/^\d+$/.test(id.trim())) windows.push({ id: '0x' + Number(id.trim()).toString(16), pid, title: '' });
    }
  }
  const w = pickWindow(chain, windows, session.cwd);
  if (!w || !WINDOW_ID.test(w.id)) return { ok: false, why: 'no window of this session was found (a Wayland-native terminal cannot be seen from here)' };
  const r = wmctrl ? await runner(wmctrl, ['-i', '-a', w.id]) : await runner(xdotool, ['windowactivate', String(parseInt(w.id, 16))]);
  return r.ok ? { ok: true, why: '', window: w } : { ok: false, why: 'the window manager did not raise it' };
}

module.exports = { parseWmctrl, pickWindow, availability, focusSession, WINDOW_ID };
