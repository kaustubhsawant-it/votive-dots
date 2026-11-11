'use strict';
//
// The Linux popup window (linux/window.js, the helper linux/ui/votive-window.py, and their wiring in linux/votive-tray.js). The helper is replaced by a stand-in process here: what is
// tested is what the tray sends, what it accepts back, and what it refuses. The drawing itself is checked by rendering the real helper under a virtual display (Scripts/test-linux-ui.sh).
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const W = require('../linux/window');
const app = require('../linux/votive-tray');

const fakeChild = () => {
  const c = new EventEmitter();
  c.written = [];
  c.stdin = new EventEmitter(); c.stdin.destroyed = false; c.stdin.write = (t) => { c.written.push(JSON.parse(t)); return true; };
  c.stdout = new EventEmitter();
  c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit')); };
  return c;
};
const host = (over = {}) => {
  const children = [];
  const calls = [];
  const h = new W.WindowHost(Object.assign({
    env: { DISPLAY: ':0', SECRET: 'no', HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' },
    ex: (p) => p === '/usr/bin/python3',
    execFn: (bin, args, opts, cb) => { calls.push({ bin, args, opts }); cb(null); },
    spawnFn: (bin, args, opts) => { const c = fakeChild(); children.push(c); calls.push({ bin, args, opts, spawn: true }); return c; },
    onAction: (a) => { h.actions.push(a); },
  }, over));
  h.actions = []; h.children = children; h.calls = calls;
  return h;
};

test('parseAction: only the known actions, with a short string key where one is needed; anything else is dropped', () => {
  assert.deepEqual(W.parseAction('{"t":"focus","key":"claude-code:s1"}'), { t: 'focus', key: 'claude-code:s1' });
  assert.deepEqual(W.parseAction('{"t":"pin","key":"x"}'), { t: 'pin', key: 'x' });
  assert.deepEqual(W.parseAction('{"t":"report"}'), { t: 'report' });
  assert.deepEqual(W.parseAction('{"t":"keepawake"}'), { t: 'keepawake' });
  assert.deepEqual(W.parseAction('{"t":"closed"}'), { t: 'closed' });
  for (const bad of ['{"t":"focus"}', '{"t":"focus","key":""}', '{"t":"focus","key":5}', '{"t":"focus","key":"' + 'x'.repeat(301) + '"}', '{"t":"run","key":"rm -rf /"}', '{"t":"quit"}', '[1]', 'null', 'not json', '{"key":"a"}', 'x'.repeat(5000)])
    assert.equal(W.parseAction(bad), null, bad.slice(0, 40));
  assert.deepEqual(W.parseAction('{"t":"report","key":"ignored"}'), { t: 'report' }, 'a key where none belongs is dropped');
});

test('open: starts python3 with the helper as an argument list and a clean environment, then sends the state as one JSON line', async () => {
  const h = host();
  const r = await h.open({ title: 'Votive Dots', sessions: [{ key: 'a' }] });
  assert.deepEqual(r, { ok: true, why: '' });
  const sp = h.calls.find((c) => c.spawn);
  assert.equal(sp.bin, '/usr/bin/python3');
  assert.deepEqual(sp.args, [W.SCRIPT]);
  assert.equal(sp.opts.shell, undefined);
  assert.deepEqual(sp.opts.env, { DISPLAY: ':0', HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/usr/bin:/bin' }, 'only the desktop variables reach it');
  assert.deepEqual(h.children[0].written, [{ t: 'state', title: 'Votive Dots', sessions: [{ key: 'a' }] }]);
  assert.equal(h.isOpen, true);
  // a second open brings the same window forward and refreshes it; no second process
  await h.open({ title: 'Votive Dots', sessions: [] });
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.children[0].written.map((m) => m.t), ['state', 'state', 'present']);
});

test('update goes to an open window only; actions come back through the checks; a window that ends can be opened again', async () => {
  const h = host();
  h.update({ x: 1 });                                                                 // nothing open: nothing happens, nothing throws
  await h.open({});
  h.update({ n: 2 });
  assert.equal(h.children[0].written.at(-1).n, 2);
  h.children[0].stdout.emit('data', Buffer.from('{"t":"focus","key":"a"}\n{"t":"nope"}\n{"t":"pi'));   // a whole line, junk, and half a line
  h.children[0].stdout.emit('data', Buffer.from('n","key":"b"}\n{"t":"closed"}\n'));
  assert.deepEqual(h.actions, [{ t: 'focus', key: 'a' }, { t: 'pin', key: 'b' }], 'a split line is joined; unknown and closed are not actions');
  h.children[0].emit('exit');
  assert.equal(h.isOpen, false);
  await h.open({});
  assert.equal(h.children.length, 2, 'a new window after the old one ended');
  h.children[1].stdout.emit('data', Buffer.from('x'.repeat(20000)));                // no newline for far too long: dropped, not buffered forever
  h.children[1].stdout.emit('data', Buffer.from('{"t":"report"}\n'));
  assert.deepEqual(h.actions.at(-1), { t: 'report' });
});

test('open: says what is missing (no python, no GTK, no display) instead of failing silently; close asks the helper to end', async () => {
  const noPython = host({ ex: () => false });
  assert.match((await noPython.open({})).why, /python3-gi gir1\.2-gtk-3\.0/);
  const noGtk = host({ execFn: (b, a, o, cb) => cb(new Error('ImportError')) });
  assert.match((await noGtk.open({})).why, /python3-gi/);
  assert.equal(noGtk.isOpen, false);
  assert.match((await noGtk.open({})).why, /python3-gi/, 'the answer is remembered');
  assert.equal(host({ env: {} }).check !== undefined && (await host({ env: {} }).open({})).why, 'no display');
  const h = host();
  await h.open({});
  h.close();
  assert.deepEqual(h.children[0].written.at(-1), { t: 'close' });
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(h.children[0].killed, true, 'and it is stopped if it did not end by itself');
});

test('the helper file: compiles, uses only GTK and the standard library, has no network or program-running code, and needs no cairo', () => {
  const file = path.join(__dirname, '..', 'linux', 'ui', 'votive-window.py');
  const src = fs.readFileSync(file, 'utf8');
  const imports = [...src.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)].map((m) => m[1].split('.')[0]);
  assert.deepEqual([...new Set(imports)].sort(), ['base64', 'gi', 'json', 'os', 'sys', 'threading']);
  assert.match(src, /from gi\.repository import Gdk, GdkPixbuf, GLib, Gtk, Pango/, 'from GTK only');
  assert.doesNotMatch(src.replace(/#.*$/gm, ''), /cairo|\bcr\.|connect\('draw'/, 'no cairo: a stock Ubuntu desktop has python3-gi but not python3-gi-cairo, and the window failed on a real desktop for this reason');
  assert.doesNotMatch(src.replace(/#.*$/gm, ''), /\b(socket|urllib|http|requests|subprocess|ctypes|pickle|eval|exec|os\.system|os\.popen|__import__|open)\s*\(/, 'no network, no program, no dynamic code, no file access');
  assert.match(src, /set_use_markup\(False\)/, 'text from the tray is never parsed as markup');
  const py = spawnSync('python3', ['-c', 'import sys,ast; ast.parse(open(sys.argv[1]).read())', file]);
  if (!py.error) assert.equal(py.status, 0, String(py.stderr));
});

test('buildMenu: Open Votive Dots window is the first control row when wired, and only then', () => {
  let n = 0;
  const rows = app.buildMenu([], { onOpenWindow: () => n++, onOpenReport() {}, onQuit() {} });
  const i = rows.findIndex((r) => r.key === 'window');
  assert.ok(i >= 0 && i < rows.findIndex((r) => r.key === 'report'));
  rows[i].onClick();
  assert.equal(n, 1);
  assert.equal(app.buildMenu([], { onQuit() {} }).some((r) => r.key === 'window'), false);
});

// ---------- on a real bus: the tray program opens the window and routes what comes back ----------
const { test: busTest, before, after } = require('node:test');
const os = require('os');
const { spawn } = require('child_process');
const { Connection } = require('../linux/dbus/bus');
const { Variant } = require('../linux/dbus/wire');
const HAVE_DAEMON = process.platform === 'linux' && !spawnSync('dbus-daemon', ['--version']).error;
const skip = HAVE_DAEMON ? false : 'needs dbus-daemon (Linux; run ./Scripts/test-linux.sh)';
let daemon, address;
before(async () => {
  if (!HAVE_DAEMON) return;
  daemon = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  address = await new Promise((resolve) => { let b = ''; daemon.stdout.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) resolve(b.slice(0, i).trim()); }); });
});
after(() => { if (daemon) daemon.kill(); });

busTest('the tray opens the window with the real state, and routes focus, pin and report coming back from it', { skip }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-win-'));
  const events = path.join(home, 'events'); fs.mkdirSync(events);
  const child = spawn('sleep', ['120']);
  const now = Date.now();
  const ev = (name, o) => fs.writeFileSync(path.join(events, name + '.json'), JSON.stringify(Object.assign({ agent: 'claude-code', lastEventAt: now, cwd: '/home/u/api', pid: child.pid }, o)));
  ev('claude-code--s1', { sessionId: 's1', lastEvent: 'working', prompt: 'fix the login bug' });
  ev('codex--s2', { agent: 'codex', sessionId: 's2', lastEvent: 'waiting', cwd: '/srv/web' });
  fs.mkdirSync(path.join(home, 'usage'));
  fs.writeFileSync(path.join(home, 'usage', 'claude-code.json'), JSON.stringify({ agent: 'claude-code', windows: [{ label: 'Weekly', usedPercentage: 92, resetsAt: Math.floor(now / 1000) + 86400 }] }));
  const focused = [];
  const awake = { isOn: false, toggle() { this.isOn = !this.isOn; return true; }, stop() {} };
  const hostChildren = [];
  let t;
  try {
    t = await app.start({ address, eventsDir: events, usageDir: path.join(home, 'usage'), env: Object.assign({}, process.env, { VOTIVE_HOME: home, DISPLAY: ':9' }), readEnv: (cb) => cb({}), readSettings: () => ({}), play: () => false, keepAwake: awake,
      focusSession: async (s) => { focused.push(s.sessionId); return { ok: true, why: '' }; },
      windowHostOpts: { ex: (p) => p === '/usr/bin/python3', execFn: (b, a, o, cb) => cb(null), spawnFn: () => { const c = fakeChild(); hostChildren.push(c); return c; } } });
    const host = await new Connection(address).connect();
    const click = (id) => host.call({ destination: t.tray.serviceName, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [id, 'clicked', new Variant('i', 0), 0] });
    await click(t.tray.menu.ids.get('window'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hostChildren.length, 1, 'one window process');
    const st = hostChildren[0].written[0];
    assert.equal(st.t, 'state');
    assert.deepEqual(st.sessions.map((s) => [s.name, s.state, s.agent]).sort(), [['api', 'working', 'Claude Code'], ['web', 'needsInput', 'Codex']]);
    assert.equal(st.sessions.every((s) => typeof s.key === 'string' && typeof s.age === 'string'), true);
    assert.deepEqual(st.usage.map((u) => [u.name, u.pct]), [['Claude Code · Weekly', 92]]);
    assert.match(st.summary, /1 needs you, 1 working/);
    assert.deepEqual(Object.keys(st.icons).sort(), ['done', 'needsInput', 'starting', 'stopped', 'stuck', 'warning', 'working'], 'a picture for every state, drawn by the tray: one source of truth');
    for (const png of Object.values(st.icons)) assert.deepEqual([...Buffer.from(png, 'base64').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');
    // the person clicks a session row, then its star, in the window
    const web = st.sessions.find((s) => s.name === 'web');
    hostChildren[0].stdout.emit('data', Buffer.from(JSON.stringify({ t: 'focus', key: web.key }) + '\n'));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(focused, ['s2']);
    hostChildren[0].stdout.emit('data', Buffer.from(JSON.stringify({ t: 'pin', key: web.key }) + '\n'));
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(JSON.parse(fs.readFileSync(path.join(home, 'priority.json'), 'utf8')).pins[web.key] > 0, 'pinned in the priority file');
    const after = hostChildren[0].written.at(-1);
    assert.equal(after.t, 'state', 'the open window is refreshed');
    assert.equal(after.sessions.find((s) => s.name === 'web').high, true);
    assert.equal(after.sessions[0].name, 'web', 'and the pinned session is first');
    assert.equal(st.keepAwake, false, 'the window is told the keep-awake state');
    hostChildren[0].stdout.emit('data', Buffer.from('{"t":"keepawake"}\n'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(awake.isOn, true, 'the switch in the window toggles it');
    assert.equal(hostChildren[0].written.at(-1).keepAwake, true, 'and the window is told');
    hostChildren[0].stdout.emit('data', Buffer.from('{"t":"focus","key":"no-such-session"}\n{"t":"run","key":"x"}\n'));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(focused, ['s2'], 'an unknown session or action does nothing');
    host.close();
  } finally { if (t) t.stop(); child.kill(); fs.rmSync(home, { recursive: true, force: true }); }
});
