'use strict';
//
// Stop, Force stop, Pause and Resume for a port's program (linux/portactions.js): what is refused, what is offered, that nothing is signalled without a
// confirmation, that the program is looked up again right before the signal, and the wording. Every dependency is a stand-in: no process is ever signalled here.
//
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const PA = require('../linux/portactions');
const app = require('../linux/votive-tray');

const row = (port, pid, o = {}) => Object.assign({ listener: { port, pid, command: 'node', localOnly: true }, path: '/usr/bin/node', folder: '/home/u/app', paused: false, mine: true }, o);
const OWN = 9;

test('refusal: core, Votive Dots itself, other users, agent sessions and system programs are never offered; the user\'s own programs are', () => {
  const r = (x, extra) => PA.refusal(x, Object.assign({ ownPid: OWN, agentPids: new Set() }, extra));
  assert.equal(r(row(3000, 4123)), null);
  assert.match(r(row(53, 0, { mine: false })), /another user/);
  assert.match(r(row(80, 1)), /core system/);
  assert.match(r(row(3000, OWN)), /Votive Dots itself/);
  assert.match(r(row(631, 77, { mine: false })), /Another user/);
  assert.match(r(row(3000, 4123), { agentPids: new Set([4123]) }), /agent session/);
  assert.match(r(row(3000, 4123, { path: '/usr/lib/systemd/systemd-resolved' })), /part of the system/);
  assert.equal(PA.isSystemPath('/usr/bin/node'), false);
  assert.equal(PA.isSystemPath('/usr/sbin/sshd'), true);
});

test('resume is gentler: allowed for an agent session\'s program or a system path of the user\'s, refused for Votive, core and other users', () => {
  const o = { ownPid: OWN };
  assert.equal(PA.resumeRefusal(row(3000, 4123), o), null);
  assert.equal(PA.resumeRefusal(row(3000, 4123, { path: '/usr/sbin/x' }), o), null);
  assert.match(PA.resumeRefusal(row(3000, OWN), o), /Votive Dots itself/);
  assert.match(PA.resumeRefusal(row(3000, 1), o), /core/);
  assert.match(PA.resumeRefusal(row(3000, 5, { mine: false }), o), /Another user/);
});

test('offers: Pause, Stop and Force stop for a running program; Resume (and Stop) for a frozen one; nothing for what is refused', () => {
  const o = { ownPid: OWN, agentPids: new Set([42]) };
  assert.deepEqual(PA.offers(row(3000, 4123), o).map((x) => x.action), ['pause', 'stop', 'kill']);
  assert.deepEqual(PA.offers(row(3000, 4123, { paused: true }), o).map((x) => x.action), ['resume', 'stop', 'kill']);
  assert.deepEqual(PA.offers(row(3000, 42, { paused: true }), o).map((x) => x.action), ['resume'], 'an agent session can be resumed, never stopped from here');
  assert.deepEqual(PA.offers(row(3000, 42), o), []);
  assert.deepEqual(PA.offers(row(53, 0, { mine: false }), o), []);
});

test('question: says what will happen, and warns on a database port', () => {
  const q = PA.question('stop', row(5432, 812));
  assert.equal(q.ok, 'Stop');
  assert.match(q.text, /node \(pid 812\) on port 5432/);
  assert.match(q.text, /usually a database/);
  assert.doesNotMatch(PA.question('stop', row(3000, 1234)).text, /database/);
  assert.doesNotMatch(PA.question('resume', row(5432, 812)).text, /database/);
  assert.match(PA.question('kill', row(3000, 5)).text, /cannot save/);
});

const fakeSpawn = (code) => {
  const calls = [];
  const fn = (bin, args, opts) => { const c = new EventEmitter(); calls.push({ bin, args, opts }); setImmediate(() => c.emit('close', code)); return c; };
  fn.calls = calls;
  return fn;
};
const has = (...names) => (p) => names.some((n) => p === '/usr/bin/' + n);

test('confirmDialog: zenity first, then kdialog; the text is data (no markup, an argument list, a clean environment); null when there is nothing to ask with', async () => {
  const q = { title: 'Stop this program?', text: 'Ask <b>node</b> & co to quit?', ok: 'Stop' };
  const env = { DISPLAY: ':0', XAUTHORITY: '/x', SECRET: 'no', LD_PRELOAD: '/evil.so' };
  const yes = fakeSpawn(0), no = fakeSpawn(1);
  assert.equal(await PA.confirmDialog(q, { env, ex: has('zenity', 'kdialog'), spawnFn: yes }), true);
  assert.equal(await PA.confirmDialog(q, { env, ex: has('zenity'), spawnFn: no }), false);
  assert.equal(yes.calls[0].bin, '/usr/bin/zenity');
  assert.ok(yes.calls[0].args.includes('--no-markup') && yes.calls[0].args.includes(q.text));
  assert.deepEqual(yes.calls[0].opts.env, { DISPLAY: ':0', XAUTHORITY: '/x', PATH: '/usr/bin:/bin' });
  assert.equal(yes.calls[0].opts.shell, undefined);
  const kd = fakeSpawn(0);
  assert.equal(await PA.confirmDialog(q, { env, ex: has('kdialog'), spawnFn: kd }), true);
  assert.equal(kd.calls[0].bin, '/usr/bin/kdialog');
  assert.equal(await PA.confirmDialog(q, { env, ex: has(), spawnFn: kd }), null);
  assert.equal(await PA.confirmDialog(q, { env: {}, ex: has('zenity'), spawnFn: kd }), null, 'no display');
  assert.equal(await PA.confirmDialog(q, { env, ex: has('zenity'), spawnFn: () => { throw new Error('x'); } }), null);
});

/** A little world: listeners that exist, which ones are frozen, which signals arrive. */
function world({ listeners = [{ port: 3000, pid: 4123, command: 'node', localOnly: true }], paused = [], dies = 'on-TERM', refuseWith = null } = {}) {
  const w = { signals: [], listeners: listeners.slice(), paused: new Set(paused), alive: new Set(listeners.map((l) => l.pid)) };
  w.deps = {
    ownPid: OWN, agentPids: new Set(), graceMs: 30, wait: () => new Promise((r) => setTimeout(r, 5)),
    scan: async () => w.listeners.filter((l) => w.alive.has(l.pid)),
    inspect: (ls) => ls.map((l) => ({ listener: l, path: '/usr/bin/node', folder: null, paused: w.paused.has(l.pid), mine: true })),
    kill: (pid, sig) => {
      if (refuseWith) { const e = new Error('no'); e.code = refuseWith; throw e; }
      if (!w.alive.has(pid)) { const e = new Error('gone'); e.code = 'ESRCH'; throw e; }
      w.signals.push(sig + ' ' + pid);
      if (sig === 'SIGSTOP') w.paused.add(pid);
      if (sig === 'SIGCONT') w.paused.delete(pid);
      if (sig === 'SIGKILL' || (sig === 'SIGTERM' && dies === 'on-TERM')) w.alive.delete(pid);
    },
    alive: (pid) => w.alive.has(pid),
    frozen: (pid) => w.paused.has(pid),
  };
  return w;
}
const target = () => row(3000, 4123);

test('perform: Stop sends SIGTERM and reports the port free; a program that ignores it is reported as still running; Force stop ends it', async () => {
  let w = world();
  let r = await PA.perform('stop', target(), w.deps);
  assert.deepEqual(w.signals, ['SIGTERM 4123']);
  assert.equal(r.ok, true);
  assert.match(r.message, /node \(pid 4123\) has quit\. Port 3000 is free/);
  w = world({ dies: 'never' });
  r = await PA.perform('stop', target(), w.deps);
  assert.equal(r.ok, false);
  assert.match(r.message, /still running\. Use Force stop/);
  r = await PA.perform('kill', target(), w.deps);
  assert.deepEqual(w.signals, ['SIGTERM 4123', 'SIGKILL 4123']);
  assert.equal(r.ok, true);
  assert.match(r.message, /force stopped/);
});

test('perform: a frozen program is continued first so it can act on SIGTERM; Pause and Resume check the real state', async () => {
  let w = world({ paused: [4123] });
  await PA.perform('stop', { ...target(), paused: true }, w.deps);
  assert.deepEqual(w.signals, ['SIGCONT 4123', 'SIGTERM 4123']);
  w = world();
  let r = await PA.perform('pause', target(), w.deps);
  assert.deepEqual(w.signals, ['SIGSTOP 4123']);
  assert.match(r.message, /is paused\. It keeps port 3000/);
  r = await PA.perform('pause', target(), w.deps);                                   // already frozen: no second signal
  assert.match(r.message, /already paused/);
  assert.equal(w.signals.length, 1);
  r = await PA.perform('resume', target(), w.deps);
  assert.deepEqual(w.signals.slice(1), ['SIGCONT 4123']);
  assert.match(r.message, /running again/);
  r = await PA.perform('resume', target(), w.deps);
  assert.match(r.message, /already running/);
});

test('perform: the program is looked up again first: a pid that no longer holds the port is never signalled, and a refusal at that moment wins', async () => {
  let w = world({ listeners: [{ port: 3000, pid: 9999, command: 'other', localOnly: true }] });   // the pid was reused by something else
  let r = await PA.perform('stop', target(), w.deps);
  assert.deepEqual(w.signals, []);
  assert.match(r.message, /Nothing is listening on port 3000/);
  w = world();
  w.deps.agentPids = new Set([4123]);                                                // it became an agent session since the menu opened
  r = await PA.perform('stop', target(), w.deps);
  assert.deepEqual(w.signals, []);
  assert.match(r.message, /agent session/);
  w = world();
  w.deps.scan = async () => null;
  assert.match((await PA.perform('stop', target(), w.deps)).message, /Couldn't read/);
  w = world({ refuseWith: 'EPERM' });
  r = await PA.perform('stop', target(), w.deps);
  assert.equal(r.ok, false);
  assert.match(r.message, /did not allow it \(EPERM\)/);
});

test('run: nothing is signalled unless the person says yes; no dialog program means no action; refusals come before any question', async () => {
  let w = world(), asked = 0;
  let r = await PA.run('stop', target(), Object.assign({}, w.deps, { confirm: async () => { asked++; return false; } }));
  assert.deepEqual(r, { cancelled: true });
  assert.deepEqual(w.signals, []);
  r = await PA.run('stop', target(), Object.assign({}, w.deps, { confirm: async () => null }));
  assert.match(r.message, /no dialog program is installed/);
  assert.deepEqual(w.signals, []);
  r = await PA.run('stop', row(3000, OWN), Object.assign({}, w.deps, { confirm: async () => { asked++; return true; } }));
  assert.match(r.message, /Votive Dots itself/);
  assert.equal(asked, 1, 'a refused program is never even asked about');
  r = await PA.run('stop', target(), Object.assign({}, w.deps, { confirm: async (q) => { assert.match(q.text, /port 3000/); return true; } }));
  assert.equal(r.ok, true);
  assert.deepEqual(w.signals, ['SIGTERM 4123']);
});

test('buildMenu: a watched port with one of your programs opens to its details and the actions that may be done; others stay plain rows', () => {
  const log = [];
  const rows = [row(5173, 99, { folder: '/home/me/dev/web' }), row(22, 0, { mine: false, path: null, folder: null }), row(8000, 42)];
  const item = app.buildMenu([], { ports: { watched: [5173, 22, 8000, 9999], rows, home: '/home/me', agentPids: new Set([42]) }, onPortAction: (a, r) => log.push(a + ' ' + r.listener.port), onEditPorts() {}, onQuit() {} }).find((r) => r.key === 'ports');
  const byKey = Object.fromEntries(item.children.map((c) => [c.key, c]));
  const web = byKey['port:5173'];
  assert.ok(web.children, 'a program of yours: a submenu');
  assert.deepEqual(web.children.filter((c) => c.enabled === false).map((c) => c.label), ['Program: /usr/bin/node', 'Started in: ~/dev/web', 'Reachable from: this computer only', 'Port 5173 is usually: Vite dev server']);
  assert.deepEqual(web.children.filter((c) => c.onClick).map((c) => c.label), ['Pause (freeze it, keeps the port)…', 'Stop (ask it to quit)…', 'Force stop (cannot be caught)…']);
  web.children.find((c) => c.key === 'port:5173:stop').onClick();
  assert.deepEqual(log, ['stop 5173']);
  assert.equal(byKey['port:22'].children, undefined, "another user's program: a plain row");
  assert.equal(byKey['port:8000'].children, undefined, 'an agent session\'s program cannot be stopped or paused: a plain row');
  assert.equal(byKey['port:9999'].children, undefined);
  const keys = item.children.flatMap(function walk(n) { return [n.key, ...(n.children || []).flatMap(walk)]; });
  assert.equal(new Set(keys).size, keys.length);
  const noActions = app.buildMenu([], { ports: { watched: [5173], rows, home: '/h' }, onQuit() {} }).find((r) => r.key === 'ports');
  assert.equal(noActions.children.find((c) => c.key === 'port:5173').children, undefined, 'nothing wired: nothing offered');
});
