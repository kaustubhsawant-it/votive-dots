'use strict';
//
// The tray menu's own controls (linux/votive-tray.js buildMenu) and Keep awake (linux/keepawake.js): the Settings switches, and the systemd
// inhibitor that stops the machine sleeping. The inhibitor is tested with a stand-in for the child process; the menu with the real bus.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const app = require('../linux/votive-tray');
const { KeepAwake, command } = require('../linux/keepawake');
const { Variant } = require('../linux/dbus/wire');

const have = (...files) => (p) => files.includes(p);

test('keep awake: the command, and nothing when systemd-inhibit is missing', () => {
  const c = command(4242, have('/usr/bin/systemd-inhibit', '/bin/sh'));
  assert.equal(c.bin, '/usr/bin/systemd-inhibit');
  assert.ok(c.args.includes('--what=idle:sleep') && c.args.includes('--mode=block') && c.args.includes('--who=Votive Dots'));
  assert.deepEqual(c.args.slice(-4), ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 5; done', 'votive-keepawake', '4242']);   // ends itself if the tray dies
  assert.equal(command(1, have('/bin/sh')), null);
  assert.equal(command(1, have('/usr/bin/systemd-inhibit')), null);
});

function fakeSpawn() {
  const made = [];
  const fn = (bin, args) => { const c = new EventEmitter(); c.killed = false; c.kill = () => { c.killed = true; }; made.push({ bin, args, child: c }); return c; };
  return { fn, made };
}

test('keep awake: starts off, one inhibitor at a time, off kills it, and a child that ends turns it off', () => {
  const { fn, made } = fakeSpawn();
  const seen = [];
  const k = new KeepAwake({ spawnFn: fn, ex: have('/usr/bin/systemd-inhibit', '/bin/sh'), onChange: (on) => seen.push(on) });
  assert.equal(k.isOn, false);
  assert.equal(k.set(true), true);
  assert.equal(k.set(true), true);
  assert.equal(made.length, 1);
  assert.equal(k.isOn, true);
  assert.equal(k.toggle(), true);                                    // toggled off
  assert.equal(k.isOn, false);
  assert.equal(made[0].child.killed, true);
  k.set(true);
  made[1].child.emit('exit');                                        // the lock is gone with its process: the state follows
  assert.equal(k.isOn, false);
  k.set(true);
  made[2].child.emit('error', new Error('ENOENT'));
  assert.equal(k.isOn, false);
  assert.deepEqual(seen, [true, false, true, false, true, false]);
  k.set(true); k.stop();
  assert.equal(made[3].child.killed, true);
  assert.equal(new KeepAwake({ spawnFn: fn, ex: have() }).set(true), false);                           // no systemd-inhibit: refuses, stays off
  assert.equal(new KeepAwake({ spawnFn: () => { throw new Error('no'); }, ex: have('/usr/bin/systemd-inhibit', '/bin/sh') }).set(true), false);
});

test('buildMenu: the Settings switches show the real values and the defaults', () => {
  const clicked = [];
  const rows = app.buildMenu([], { settings: { colorblindShapes: true, usagePulse: false, sounds: undefined }, keepAwake: true, onToggle: (n) => clicked.push(n), onKeepAwake: () => clicked.push('awake'), onQuit() {} });
  const settings = rows.find((r) => r.key === 'settings');
  assert.deepEqual(settings.children.map((c) => [c.label, c.checked]), [
    ['Colorblind shapes', true], ['Flag the icon when a plan limit is over 70%', false], ['Notify me when a session was asked to', true],
    ['Notify me on every change (finished, needs you, error, stopped)', false], ['Sounds', true], ['Warn when the CPU is hot', false], ['Ports list (developer tool)', false]]);     // unset: the defaults (off for every-change, on for the rest)
  assert.ok(settings.children.every((c) => c.toggle === 'checkmark'));
  settings.children[1].onClick();
  rows.find((r) => r.key === 'keep-awake').onClick();
  assert.deepEqual(clicked, ['usagePulse', 'awake']);
  assert.equal(rows.find((r) => r.key === 'keep-awake').checked, true);
  assert.equal(app.buildMenu([], {}).some((r) => r.key === 'settings' || r.key === 'keep-awake'), false);   // nothing to wire: nothing shown
  assert.equal(rows.at(-1).label, 'Quit Votive Dots');
  const keys = rows.flatMap(function walk(n) { return [n.key, ...(n.children || []).flatMap(walk)]; });
  assert.equal(new Set(keys).size, keys.length);
});

// ---------- on the bus: clicking a switch changes the setting ----------

const HAVE_DAEMON = process.platform === 'linux' && !spawnSync('dbus-daemon', ['--version']).error;
const skip = HAVE_DAEMON ? false : 'needs dbus-daemon (Linux; run ./Scripts/test-linux.sh)';
let daemon, address;
before(async () => {
  if (!HAVE_DAEMON) return;
  daemon = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  address = await new Promise((resolve) => { let b = ''; daemon.stdout.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) resolve(b.slice(0, i).trim()); }); });
});
after(() => { if (daemon) daemon.kill(); });

test('a click on a Settings switch or Keep awake in the real menu does the right thing', { skip }, async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Connection } = require('../linux/dbus/bus');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-menu-'));
  const changes = [];
  const awake = { isOn: false, toggle() { this.isOn = !this.isOn; awake.calls = (awake.calls || 0) + 1; return true; }, stop() {} };
  let store = { colorblindShapes: false };
  try {
    const t = await app.start({ address, eventsDir: path.join(home, 'events'), usageDir: path.join(home, 'usage'), env: Object.assign({}, process.env, { VOTIVE_HOME: home }),
      readSettings: () => store, updateSettings: (c) => { changes.push(c); store = Object.assign({}, store, c); }, keepAwake: awake, play: () => false });
    const host = await new Connection(address).connect();
    const ev = (id) => host.call({ destination: 'dev.votive.Votive', path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [id, 'clicked', new Variant('i', 0), 0] });
    const shapesId = t.tray.menu.ids.get('set:colorblindShapes');
    assert.ok(shapesId > 0);
    // the tray owns two names (the app's and the item's); the menu lives on the item's
    const item = t.tray.serviceName;
    await host.call({ destination: item, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [shapesId, 'clicked', new Variant('i', 0), 0] });
    assert.deepEqual(changes, [{ colorblindShapes: true }]);
    await host.call({ destination: item, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [t.tray.menu.ids.get('set:usagePulse'), 'clicked', new Variant('i', 0), 0] });
    assert.deepEqual(changes[1], { usagePulse: false });                       // unset means on by default, so a click turns it off
    await host.call({ destination: item, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [t.tray.menu.ids.get('keep-awake'), 'clicked', new Variant('i', 0), 0] });
    assert.equal(awake.calls, 1);
    const [, layout] = await host.call({ destination: item, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'GetLayout', signature: 'iias', body: [0, -1, ['label', 'toggle-state', 'toggle-type']] });
    const find = (n, label) => { const l = n[1].get('label'); if (l && l.value === label) return n; for (const k of n[2]) { const r = find(k.value, label); if (r) return r; } return null; };
    assert.equal(find(layout, 'Colorblind shapes')[1].get('toggle-state').value, 1);        // the menu follows the changed setting
    assert.equal(find(layout, 'Keep awake')[1].get('toggle-state').value, 1);
    host.close();
    t.stop();
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the Ports switch is this tray\'s own preference: it is not an agent-settable setting, and a click writes linux-prefs.json and shows the Ports item', { skip }, async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Connection } = require('../linux/dbus/bus');
  const { getSettings, updateSettings } = require('../Scripts/overlay-settings');
  assert.throws(() => updateSettings({ portToolsOn: true }), /Unknown setting/, 'an agent (or the MCP tool) cannot turn the Ports tool on');
  assert.ok(!('portToolsOn' in getSettings()));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-prefs-'));
  const changes = [];
  try {
    const t = await app.start({ address, eventsDir: path.join(home, 'events'), usageDir: path.join(home, 'usage'), env: Object.assign({}, process.env, { VOTIVE_HOME: home }),
      readSettings: () => ({}), updateSettings: (c) => changes.push(c), keepAwake: { isOn: false, toggle() {}, stop() {} }, play: () => false, scanPorts: async () => [] });
    assert.equal(t.tray.menu.ids.has('ports'), false);
    const host = await new Connection(address).connect();
    await host.call({ destination: t.tray.serviceName, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [t.tray.menu.ids.get('set:portToolsOn'), 'clicked', new Variant('i', 0), 0] });
    assert.deepEqual(changes, [], 'it never goes through the agent-settable settings');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'linux-prefs.json'), 'utf8')), { portToolsOn: true });
    assert.equal(fs.statSync(path.join(home, 'linux-prefs.json')).mode & 0o777, 0o600);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(t.tray.menu.ids.has('ports'), true, 'the Ports item appears');
    host.close();
    t.stop();
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
