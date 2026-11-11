'use strict';
//
// Stop, Force stop, Pause and Resume for a program that holds a port: the same rules as the Mac's PortTools.swift (optional developer tool, off by default).
// It never acts without a confirmation window (zenity, or kdialog), and it signals exactly one process: the one the person confirmed, looked up again
// right before the signal, so a pid that was reused since the menu opened is never hit. No shell is involved and no privilege is needed: Linux itself
// refuses a signal to anyone else's process.
//
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ports = require('./ports');

const BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'];
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const SYSTEM_PREFIXES = ['/usr/lib/systemd/', '/lib/systemd/', '/usr/sbin/', '/sbin/', '/usr/libexec/', '/usr/lib/xorg/', '/usr/lib/gnome-shell/'];
const DATABASE_PORTS = [3306, 5432, 6379, 9200, 11211, 27017];

const isSystemPath = (p) => !!p && SYSTEM_PREFIXES.some((x) => p.startsWith(x));
const isDatabasePort = (port) => DATABASE_PORTS.includes(port);
const databaseNote = (port) => (isDatabasePort(port) ? '\n\nPort ' + port + ' is usually a database. Stopping or freezing one in the middle of work can leave connections hanging or lose changes that are not saved yet.' : '');

/** Why this program must not be stopped or paused from the menu, or null when it may be offered. `agentPids` are the sessions Votive Dots is showing. */
function refusal(row, { ownPid = process.pid, agentPids = new Set() } = {}) {
  const l = row.listener;
  if (!l.pid) return "That program belongs to another user (or to the system), so Linux would not allow it.";
  if (l.pid <= 1) return 'That is a core system process.';
  if (l.pid === ownPid) return 'That is Votive Dots itself.';
  if (!row.mine) return 'Another user owns that program, so Linux would not allow it.';
  if (agentPids.has(l.pid)) return 'That port belongs to a running agent session. Close the session from its terminal instead.';
  if (isSystemPath(row.path)) return 'That is part of the system.';
  return null;
}

/** Resuming is gentle, so it is allowed for any program of the user's, an agent session included (something else may have frozen it). */
function resumeRefusal(row, { ownPid = process.pid } = {}) {
  const l = row.listener;
  if (!l.pid) return 'That program belongs to another user (or to the system), so Linux would not allow it.';
  if (l.pid <= 1) return 'That is a core system process.';
  if (l.pid === ownPid) return 'That is Votive Dots itself.';
  if (!row.mine) return 'Another user owns that program, so Linux would not allow it.';
  return null;
}

/** Which actions to offer for a row: [{ action, label }]. Stop and Force stop only where allowed; Resume for a frozen program, Pause otherwise. */
function offers(row, opts) {
  const out = [];
  const why = refusal(row, opts);
  if (row.paused) { if (!resumeRefusal(row, opts)) out.push({ action: 'resume', label: 'Resume (continue it)…' }); }
  if (!why) {
    if (!row.paused) out.push({ action: 'pause', label: 'Pause (freeze it, keeps the port)…' });
    out.push({ action: 'stop', label: 'Stop (ask it to quit)…' }, { action: 'kill', label: 'Force stop (cannot be caught)…' });
  }
  return out;
}

const PAST = { stop: 'quit', kill: 'been force stopped', pause: 'paused', resume: 'resumed' };

/** The question the confirmation window asks. */
function question(action, row) {
  const l = row.listener;
  const who = (l.command || 'that program') + ' (pid ' + l.pid + ') on port ' + l.port;
  const lead = {
    stop: 'Ask ' + who + ' to quit? It gets a few seconds to finish what it is doing.',
    kill: 'Force stop ' + who + '? It cannot save anything or clean up. Use this only if Stop did not work.',
    pause: 'Pause ' + who + '? It freezes but keeps the port, so anything that connects waits until you resume it.',
    resume: 'Let ' + who + ' carry on?',
  }[action];
  const ok = { stop: 'Stop', kill: 'Force stop', pause: 'Pause', resume: 'Resume' }[action];
  return { title: { stop: 'Stop this program?', kill: 'Force stop this program?', pause: 'Pause this program?', resume: 'Resume this program?' }[action], text: lead + (action === 'resume' ? '' : databaseNote(l.port)), ok };
}

/** The confirmation window: resolves true (yes), false (no) or null when no dialog program is installed. Started with an argument list; the text is data, never markup. */
function confirmDialog({ title, text, ok }, { env = process.env, ex = isFile, spawnFn = spawn } = {}) {
  const find = (n) => BIN_DIRS.map((d) => path.join(d, n)).find(ex);
  const zenity = find('zenity');
  const kdialog = zenity ? null : find('kdialog');
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return Promise.resolve(null);
  let bin, args;
  if (zenity) { bin = zenity; args = ['--question', '--no-markup', '--title', title, '--text', text, '--ok-label', ok, '--cancel-label', 'Cancel', '--width', '420']; }
  else if (kdialog) { bin = kdialog; args = ['--title', title, '--yesno', text, '--yes-label', ok, '--no-label', 'Cancel']; }
  else return Promise.resolve(null);
  const childEnv = {};
  for (const k of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP']) if (env[k]) childEnv[k] = env[k];
  childEnv.PATH = '/usr/bin:/bin';
  return new Promise((resolve) => {
    let child;
    try { child = spawnFn(bin, args, { env: childEnv, stdio: 'ignore' }); } catch (e) { return resolve(null); }
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0));
  });
}

const SIGNALS = { stop: 'SIGTERM', kill: 'SIGKILL', pause: 'SIGSTOP', resume: 'SIGCONT' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Does one action on one listener after the person confirmed it. Resolves { ok, message } in words for a notification.
 * deps: scan() -> listeners, inspect(listeners) -> rows, kill(pid, signal), alive(pid), state(pid) -> 'T' | other, sleep(ms).
 */
async function perform(action, row, { agentPids = new Set(), ownPid = process.pid, scan = () => ports.scan(), inspect = (l) => ports.inspect(l), kill = (pid, sig) => process.kill(pid, sig),
  alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }, frozen = (pid) => { try { return /\) ([A-Za-z]) /.exec(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'))[1] === 'T'; } catch (e) { return false; } },
  wait = sleep, graceMs = 2000 } = {}) {
  const target = row.listener;
  const now = await scan();
  if (now === null) return { ok: false, message: "Couldn't read the listening ports." };
  const live = now.find((l) => l.port === target.port && l.pid === target.pid);
  if (!live) return { ok: true, message: 'Nothing is listening on port ' + target.port + ' from that program any more.' };
  const liveRow = inspect([live])[0];
  const why = action === 'resume' ? resumeRefusal(liveRow, { ownPid }) : refusal(liveRow, { ownPid, agentPids });
  if (why) return { ok: false, message: why };
  const name = (live.command || 'The program') + ' (pid ' + live.pid + ')';
  const send = (sig) => { try { kill(live.pid, sig); return null; } catch (e) { return e.code === 'ESRCH' ? 'gone' : 'Linux did not allow it (' + (e.code || 'error') + ').'; } };
  const settle = async (ms, done) => { const end = Date.now() + ms; do { if (await done()) return true; await wait(150); } while (Date.now() < end); return done(); };

  if (action === 'pause') {
    if (liveRow.paused) return { ok: true, message: name + ' is already paused.' };
    const e = send(SIGNALS.pause);
    if (e === 'gone') return { ok: true, message: name + ' is gone.' };
    if (e) return { ok: false, message: e };
    return (await settle(1500, () => frozen(live.pid))) ? { ok: true, message: name + ' is paused. It keeps port ' + live.port + '.' } : { ok: false, message: "It didn't pause." };
  }
  if (action === 'resume') {
    if (!liveRow.paused) return { ok: true, message: name + ' is already running.' };
    const e = send(SIGNALS.resume);
    if (e === 'gone') return { ok: true, message: name + ' is gone.' };
    if (e) return { ok: false, message: e };
    return (await settle(1500, () => !frozen(live.pid))) ? { ok: true, message: name + ' is running again.' } : { ok: false, message: "It didn't resume." };
  }
  // stop / kill: a frozen program cannot act on SIGTERM until it is continued
  if (liveRow.paused) send(SIGNALS.resume);
  const e = send(SIGNALS[action]);
  if (e === 'gone') return { ok: true, message: name + ' is gone.' };
  if (e) return { ok: false, message: e };
  const ended = await settle(action === 'kill' ? 1000 : graceMs, async () => {
    if (!alive(live.pid)) return true;
    const again = await scan();
    return !!again && !again.some((l) => l.port === live.port && l.pid === live.pid);       // quit but not yet collected by its parent: it no longer holds the port
  });
  if (ended) return { ok: true, message: name + ' has ' + PAST[action] + '. Port ' + live.port + ' is free.' };
  return { ok: false, message: name + ' is still running' + (action === 'stop' ? '. Use Force stop if you are sure.' : '.') };
}

/** Confirm, then perform. Resolves { ok, message } or { cancelled: true }. `confirm` is injectable for tests. */
async function run(action, row, deps = {}) {
  const early = action === 'resume' ? resumeRefusal(row, deps) : refusal(row, deps);
  if (early) return { ok: false, message: early };
  const yes = await (deps.confirm || ((q) => confirmDialog(q, deps)))(question(action, row));
  if (yes === null) return { ok: false, message: 'Votive Dots asks before it stops or pauses anything, and no dialog program is installed (sudo apt install zenity).' };
  if (!yes) return { cancelled: true };
  return perform(action, row, deps);
}

module.exports = { refusal, resumeRefusal, offers, question, confirmDialog, perform, run, isSystemPath, isDatabasePort, databaseNote, SIGNALS };
