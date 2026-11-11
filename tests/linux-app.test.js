'use strict';
//
// The whole Linux tray program (linux/votive-tray.js) on a private session bus: real event files, a real live process, and a stub
// StatusNotifierWatcher playing the desktop's tray host. Needs `dbus-daemon` (skipped on a Mac; ./Scripts/test-linux.sh runs it).
// buildMenu is pure and is tested everywhere.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Connection } = require('../linux/dbus/bus');
const { Variant } = require('../linux/dbus/wire');
const { WATCHER, SNI } = require('../linux/tray');
const app = require('../linux/votive-tray');

const HAVE_DAEMON = process.platform === 'linux' && !spawnSync('dbus-daemon', ['--version']).error;
const skip = HAVE_DAEMON ? false : 'needs dbus-daemon (Linux; run ./Scripts/test-linux.sh)';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(15); } throw new Error('timed out waiting for ' + what); };

const sess = (over) => Object.assign({ key: 'claude-code:a', agent: 'claude-code', agentName: 'Claude Code', sessionId: 'abc', name: 'api', cwd: '/home/u/api', state: 'working', label: 'working', startedAt: 1, lastActivityAt: 1000, prompt: 'fix login' }, over);

test('buildMenu: like the Mac: a Sessions heading, two-line rows with a dot, a summary line, then the controls', () => {
  const rows = app.buildMenu([sess(), sess({ key: 'codex:b', sessionId: 'b', agentName: 'Codex', name: 'web', state: 'needsInput', label: 'needs you', prompt: null })], { now: 1000 + 125_000, keepAwake: false, onToggle: () => {}, onQuit: () => {} });
  assert.equal(rows[0].label, 'Sessions');
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[1].label, '🟡  api   Claude Code, working\n\u2003\u2002 “fix login”  ·  2 min');   // dot, name, agent and state; then what it was asked, and how long ago
  assert.equal(rows[2].label, '🟣  web   Codex, needs you\n\u2003\u2002 2 min');                         // no prompt: just the age
  assert.ok(rows[1].children === undefined && rows[2].children === undefined);            // flat rows: clicking one goes to its terminal, nothing opens under it
  assert.equal(rows[3].label, '1 needs you, 1 working');                                  // the summary, most urgent first
  assert.equal(rows[3].enabled, false);
  assert.deepEqual(rows.slice(4).map((r) => r.separator ? '-' : r.label), ['-', 'Keep awake', 'Settings', 'Quit Votive Dots']);
  const copied = [];
  const withCopy = app.buildMenu([sess(), sess({ key: 'codex:b', sessionId: 'b', agentName: 'Codex', name: 'api' })], { now: 1000, onCopy: (t) => copied.push(t) });
  const copy = withCopy.find((r) => r.key === 'copy');
  assert.deepEqual(copy.children.map((c) => c.label), ['Folder path · api (Claude Code)', 'Session ID · api (Claude Code)', 'Folder path · api (Codex)', 'Session ID · api (Codex)']);   // two sessions with one name are told apart
  copy.children[1].onClick(); copy.children[0].onClick();
  assert.deepEqual(copied, ['abc', '/home/u/api']);
  assert.equal(app.buildMenu([sess()], { now: 1000 }).some((r) => r.key === 'copy'), false);        // no clipboard wired: no Copy entry
  assert.equal(app.buildMenu([sess()], { now: 1000, shapes: true })[1].label.startsWith('●'), true);   // colourblind shapes replace the emoji
  assert.equal(app.buildMenu([], {})[0].label, 'No agent sessions');
  assert.equal(app.buildMenu([sess({ prompt: 'x'.repeat(200) })], { now: 1000 })[1].label.split('\n')[1].length < 75, true);   // a long prompt is clipped
  const keys = app.buildMenu([sess(), sess({ key: 'x:y' })], {}).flatMap(function walk(n) { return [n.key, ...(n.children || []).flatMap(walk)]; });
  assert.equal(new Set(keys).size, keys.length, 'every menu key is unique');
});

test('parseEnvironment: only the desktop variables, nothing quoted or odd', () => {
  const v = app.parseEnvironment(['DISPLAY=:0', 'WAYLAND_DISPLAY=wayland-0', 'XDG_SESSION_TYPE=wayland', "XAUTHORITY=$'/run/user/1000/a b'", 'PATH=/usr/bin', 'XDG_CURRENT_DESKTOP=ubuntu:GNOME', 'LD_PRELOAD=/evil.so', 'garbage'].join('\n'));
  assert.deepEqual(v, { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' });
  assert.deepEqual(app.parseEnvironment(''), {});
});

let daemon, address, home, eventsDir, child;
const open = [];
const connect = async () => { const c = await new Connection(address).connect(); open.push(c); return c; };
const writeEvent = (name, o) => fs.writeFileSync(path.join(eventsDir, name + '.json'), JSON.stringify(Object.assign({ agent: 'claude-code', cwd: '/home/u/api', pid: child.pid, lastEventAt: Date.now() }, o)));

before(async () => {
  if (!HAVE_DAEMON) return;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-app-'));
  eventsDir = path.join(home, '.votive', 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
  child = spawn('sleep', ['120']);
  daemon = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  address = await new Promise((resolve, reject) => {
    let buf = '';
    daemon.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i).trim()); });
    daemon.on('error', reject);
  });
});
after(() => { for (const c of open) c.close(); if (daemon) daemon.kill(); if (child) child.kill(); if (home) fs.rmSync(home, { recursive: true, force: true }); });

const getProps = async (host, name) => (await host.call({ destination: name, path: '/StatusNotifierItem', interface: 'org.freedesktop.DBus.Properties', member: 'GetAll', signature: 's', body: [SNI] }))[0];
const noSettings = () => ({ colorblindShapes: { value: false }, stuckThresholdMinutes: { value: 8 } });

test('the tray shows the sessions in the event files, follows changes, and shows a dead process in red', { skip }, async () => {
  const w = await connect();
  const registered = [];
  w.exportObject('/StatusNotifierWatcher', { [WATCHER]: { methods: { RegisterStatusNotifierItem: { in: 's', out: '', fn: (n) => { registered.push(n); return []; } } } } });
  await w.requestName(WATCHER);

  writeEvent('claude-code--s1', { sessionId: 's1', lastEvent: 'working', prompt: 'fix the login bug' });
  writeEvent('codex--s2', { agent: 'codex', sessionId: 's2', lastEvent: 'waiting', cwd: '/srv/web' });
  fs.writeFileSync(path.join(eventsDir, 'junk.json'), '{not json');
  const t = await app.start({ address, eventsDir, readSettings: noSettings, play: () => false, env: Object.assign({}, process.env, { VOTIVE_HOME: path.join(home, '.votive') }) });
  await until(() => registered.length === 1, 'registration');
  assert.equal(t.sessions().length, 2);

  const host = await connect();
  const props = await getProps(host, registered[0]);
  assert.equal(props.get('Status').value, 'NeedsAttention');                  // the Codex session waits for the person
  const tip = props.get('ToolTip').value[3];
  assert.match(tip, /Claude Code · api: working \(just now\)/);
  assert.match(tip, /Codex · web: needs you \(just now\)/);

  const [, layout] = await host.call({ destination: registered[0], path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'GetLayout', signature: 'iias', body: [0, -1, ['label']] });
  const labels = layout[2].map((k) => k.value[1].get('label') && k.value[1].get('label').value);
  assert.equal(labels[0], 'Sessions');
  assert.ok(labels.some((l) => /^web {3}Codex, needs you\n/.test(l)), labels.join(' | '));            // the state is a drawn picture on the row now, not an emoji in the text
  assert.equal(labels.at(-1), 'Quit Votive Dots');

  // a new event file appears: the tray notices without waiting for the poll
  await host.addMatch(`type='signal',sender='${registered[0]}'`);
  const got = [];
  host.on('signal', (m) => got.push(m.member));
  writeEvent('claude-code--s3', { sessionId: 's3', lastEvent: 'done', cwd: '/home/u/docs' });
  await until(() => t.sessions().length === 3, 'the new session', 2000);
  await until(() => got.includes('NewToolTip') && got.includes('LayoutUpdated'), 'tooltip and layout signals');
  assert.match((await getProps(host, registered[0])).get('ToolTip').value[3], /Claude Code · docs: done/);

  // the agent process dies: red
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  t.refresh();
  assert.ok(t.sessions().every((s) => s.state === 'stopped'), t.sessions().map((s) => s.state).join());
  child = spawn('sleep', ['120']);

  // a second copy refuses to start; the first keeps running
  await assert.rejects(app.start({ address, eventsDir, readSettings: noSettings, play: () => false, env: Object.assign({}, process.env, { VOTIVE_HOME: path.join(home, '.votive') }) }), (e) => e.alreadyRunning === true);

  // Quit
  const quitId = t.tray.menu.ids.get('quit');
  await host.call({ destination: registered[0], path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [quitId, 'clicked', new Variant('i', 0), 0] });
  await until(() => t.conn.closed, 'the connection closing after Quit');
  w.close();
});

test('Go to terminal: when the jump fails the person is told why, and a display that shows up late is picked up', { skip }, async () => {
  const w = await connect();
  w.exportObject('/StatusNotifierWatcher', { [WATCHER]: { methods: { RegisterStatusNotifierItem: { in: 's', out: '', fn: () => [] } } } });
  await w.requestName(WATCHER);
  const notes = [];
  const n = await connect();
  n.exportObject('/org/freedesktop/Notifications', { 'org.freedesktop.Notifications': { methods: { Notify: { in: 'susssasa{sv}i', out: 'u', fn: (app_, rep, icon, title, body) => { notes.push({ title, body }); return [7]; } } } } });
  await n.requestName('org.freedesktop.Notifications');
  writeEvent('claude-code--g1', { sessionId: 'g1', lastEvent: 'working' });
  let loaded = 0, asked = null;
  const t = await app.start({
    address, eventsDir, readSettings: noSettings, play: () => false, env: { VOTIVE_HOME: path.join(home, '.votive') },
    readEnv: (cb) => { loaded++; cb({ DISPLAY: ':7' }); },
    focusSession: async (s) => { asked = s; return { ok: false, why: 'no window of this session was found' }; },
  });
  assert.ok(loaded >= 1, 'the tray asked the user manager for the desktop environment');
  try {
    const slot = t.sessions().findIndex((x) => x.sessionId === 'g1');                        // rows are keyed by their place in the list
    assert.ok(slot >= 0);
    const go = [...t.tray.menu.byId.values()].find((x) => x.key === 's:' + slot);
    assert.ok(go && go.enabled !== false, 'the session row is clickable');
    const host = await connect();
    await host.call({ destination: t.tray.serviceName, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [go.id, 'clicked', new Variant('i', 0), 0] });
    await until(() => notes.length === 1, 'the failure notification');
    assert.equal(asked.sessionId, 'g1');
    assert.match(notes[0].title, /could not go to that terminal/);
    assert.equal(notes[0].body, 'no window of this session was found');
  } finally {
    t.stop();                      // always: a leftover tray would hold the single-instance name for the tests after this one
    w.close(); n.close();
  }
});

test('--print lists the sessions as JSON and exits, with no bus needed', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-print-'));
  try {
    fs.mkdirSync(path.join(h, '.votive', 'events'), { recursive: true });
    fs.writeFileSync(path.join(h, '.votive', 'events', 'codex--x.json'), JSON.stringify({ agent: 'codex', sessionId: 'x', lastEvent: 'done', lastEventAt: Date.now(), cwd: '/a/b' }));
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'linux', 'votive-tray.js'), '--print'], { env: { PATH: process.env.PATH, HOME: h, DBUS_SESSION_BUS_ADDRESS: '' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.overall, 'done');
    assert.deepEqual(out.sessions.map((s) => [s.agent, s.name, s.state]), [['codex', 'b', 'done']]);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('without a session bus it says so and exits non-zero instead of hanging', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'linux', 'votive-tray.js')], { env: { PATH: process.env.PATH, HOME: os.tmpdir() }, encoding: 'utf8', timeout: 8000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not start: no session bus/);
});

test('the real process: registers with the tray host, a second copy exits quietly, SIGTERM stops it cleanly', { skip }, async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-proc-'));
  const childEnv = { PATH: process.env.PATH, HOME: h, DBUS_SESSION_BUS_ADDRESS: address };
  const script = path.join(__dirname, '..', 'linux', 'votive-tray.js');
  const exits = (p) => new Promise((r) => p.on('exit', (code, sig) => r({ code, sig })));
  try {
    fs.mkdirSync(path.join(h, '.votive', 'events'), { recursive: true });
    fs.writeFileSync(path.join(h, '.votive', 'events', 'codex--p.json'), JSON.stringify({ agent: 'codex', sessionId: 'p', lastEvent: 'waiting', lastEventAt: Date.now(), cwd: '/srv/web' }));
    const w = await connect();
    const registered = [];
    w.exportObject('/StatusNotifierWatcher', { [WATCHER]: { methods: { RegisterStatusNotifierItem: { in: 's', out: '', fn: (n) => { registered.push(n); return []; } } } } });
    await w.requestName(WATCHER);

    const first = spawn(process.execPath, [script], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let err1 = ''; first.stderr.on('data', (d) => { err1 += d; });
    await until(() => registered.length === 1, 'the process to register: ' + err1);
    const host = await connect();
    assert.match((await getProps(host, registered[0])).get('ToolTip').value[3], /Codex · web: needs you/);

    const second = spawn(process.execPath, [script], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let err2 = ''; second.stderr.on('data', (d) => { err2 += d; });
    assert.deepEqual(await exits(second), { code: 0, sig: null });
    assert.match(err2, /already running/);
    assert.equal(registered.length, 1);

    const done = exits(first);
    first.kill('SIGTERM');
    assert.deepEqual(await done, { code: 0, sig: null });
    await until(async () => { try { await host.call({ destination: registered[0], path: '/StatusNotifierItem', interface: 'org.freedesktop.DBus.Peer', member: 'Ping' }); return false; } catch (e) { return true; } }, 'the bus name to be released');
    w.close();
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});
