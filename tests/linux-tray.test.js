'use strict';
//
// The tray (linux/tray.js, linux/dbus/dbusmenu.js) on a real private session bus, with a stub StatusNotifierWatcher playing the
// desktop's tray host. Needs `dbus-daemon` (skipped on a Mac; ./Scripts/test-linux.sh installs it in the container).
// The dbusmenu layout tests are pure and run everywhere.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync, execFile } = require('child_process');
const { Connection } = require('../linux/dbus/bus');
const { Variant } = require('../linux/dbus/wire');
const { DbusMenu } = require('../linux/dbus/dbusmenu');
const { Tray, SNI, WATCHER } = require('../linux/tray');
const icon = require('../linux/icon');

const HAVE_DAEMON = process.platform === 'linux' && !spawnSync('dbus-daemon', ['--version']).error;
const skip = HAVE_DAEMON ? false : 'needs dbus-daemon (Linux; run ./Scripts/test-linux.sh)';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(10); } throw new Error('timed out waiting for ' + what); };

// ---------- the menu model, no bus needed ----------

const sample = (clicked = []) => [
  { key: 'head', label: 'Votive: 2 sessions', enabled: false },
  { key: 'sep', separator: true },
  { key: 's:a', label: 'Claude Code · api: needs you', children: [{ key: 's:a:p', label: 'fix the login bug', enabled: false }, { key: 's:a:f', label: '/home/u/api', enabled: false }] },
  { key: 'quit', label: 'Quit Votive Dots', onClick: () => clicked.push('quit') },
];

test('a text label: the row is text and the icon is one full-size dot for the most urgent session; without it the icon is the row', () => {
  const t = new Tray({}, {});
  t.update({ states: ['working', 'done', 'needsInput'], label: '🟡🟢🟣' });
  assert.equal(t.label, '🟡🟢🟣');
  assert.deepEqual(t.pixmap.map((p) => [p[0], p[1]]), [[22, 22], [32, 32], [48, 48]]);                 // square: one dot
  assert.deepEqual(t.pixmap[0][2], icon.render(['needsInput'], { size: 22 }));                             // and it is the urgent one
  t.update({ label: '' });
  assert.equal(t.label, '');
  assert.deepEqual(t.pixmap.map((p) => p[0]), [22, 32, 48].map((h) => icon.width(3, h)));              // back to the drawn row
  assert.equal(icon.mostUrgent(['done', 'working', 'stopped']), 'stopped');
  assert.equal(icon.mostUrgent(['done', 'working']), 'working');
  const { labelWanted } = require('../linux/votive-tray');
  assert.equal(labelWanted({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), true);
  assert.equal(labelWanted({ XDG_CURRENT_DESKTOP: 'KDE' }), false);
  assert.equal(labelWanted({ XDG_CURRENT_DESKTOP: 'KDE', VOTIVE_TRAY_LABEL: '1' }), true);
  assert.equal(labelWanted({ XDG_CURRENT_DESKTOP: 'GNOME', VOTIVE_TRAY_LABEL: '0' }), false);
});

test('menu: layout, properties and the protocol shape', () => {
  const m = new DbusMenu();
  assert.equal(m.setItems(sample()), true);
  const [rev, [rootId, rootProps, kids]] = m.getLayout(0, -1, []);
  assert.equal(rootId, 0);
  assert.equal(rootProps.get('children-display').value, 'submenu');
  assert.equal(kids.length, 4);
  assert.ok(kids.every((k) => k instanceof Variant && k.sig === '(ia{sv}av)'));
  const [headId, headProps] = kids[0].value;
  assert.equal(headProps.get('label').value, 'Votive: 2 sessions');
  assert.equal(headProps.get('enabled').value, false);
  assert.equal(kids[1].value[1].get('type').value, 'separator');
  assert.equal(kids[2].value[1].get('children-display').value, 'submenu');
  assert.equal(kids[2].value[2].length, 2);
  assert.equal(m.getLayout(0, 1, [])[1][2][2].value[2].length, 0);              // depth 1: no grandchildren
  assert.equal(m.getLayout(headId, 0, ['label'])[1][1].size, 1);                // asked-for properties only
  assert.equal(m.getLayout(9999, 0, []), null);
  assert.equal(typeof rev, 'number');
});

test('menu: ids stay the same across rebuilds, the revision moves only when something changed', () => {
  const m = new DbusMenu();
  const seen = [];
  m.onChange = (r) => seen.push(r);
  m.setItems(sample());
  const idOf = (key) => m.ids.get(key);
  const quit = idOf('quit'), a = idOf('s:a');
  assert.equal(m.setItems(sample()), false);                                     // identical: nothing to tell the host
  assert.equal(seen.length, 1);
  const changed = sample(); changed[2].label = 'Claude Code · api: working';
  assert.equal(m.setItems(changed), true);
  assert.equal(seen.length, 2);
  assert.equal(idOf('quit'), quit); assert.equal(idOf('s:a'), a);
  m.setItems(sample().slice(0, 2));                                              // rows go away and come back with the same id
  m.setItems(sample());
  assert.equal(idOf('quit'), quit);
});

test('menu: a changed label is a property change, a new or removed row is a layout change (GNOME re-reads only the shape on LayoutUpdated)', () => {
  const m = new DbusMenu();
  const seen = [];
  m.onChange = (r, what) => seen.push(what);
  m.setItems(sample());
  assert.equal(seen[0].layout, true);                                            // the first tree is a layout
  const a = m.ids.get('s:a');
  const relabel = sample(); relabel[2].label = 'Claude Code · api: working · 2 min';
  m.setItems(relabel);
  assert.equal(seen[1].layout, false);
  assert.deepEqual(seen[1].updated.map(([id]) => id), [a]);
  assert.equal(seen[1].updated[0][1].get('label').value, 'Claude Code · api: working · 2 min');
  assert.deepEqual([...seen[1].updated[0][1].keys()], ['label'], 'only the changed property travels, so a host does not rebuild the row and close its submenu');
  assert.deepEqual(seen[1].removed, []);
  const off = sample(); off[0].enabled = false; off[2].enabled = false;          // a property that goes away is named, so the host forgets it
  m.setItems(off);
  const on = sample();
  m.setItems(on);
  assert.ok(seen.at(-1).removed.some(([id, names]) => id === a && names.includes('enabled')) || seen.at(-1).updated.some(([id, p]) => id === a && p.get('enabled') === undefined), 'enabled=false is withdrawn');
  m.setItems(sample().slice(0, 3));                                              // a row goes away: the shape changed
  assert.equal(seen.at(-1).layout, true);
  m.setItems(sample());                                                          // and comes back
  assert.equal(seen.at(-1).layout, true);
  const tog = sample(); tog.push({ key: 'ka', label: 'Keep awake', toggle: 'checkmark', checked: false });
  m.setItems(tog);
  const tog2 = sample(); tog2.push({ key: 'ka', label: 'Keep awake', toggle: 'checkmark', checked: true });
  m.setItems(tog2);
  assert.equal(seen.at(-1).layout, false);                                       // ticking a checkmark is a property change
  assert.equal(seen.at(-1).updated[0][1].get('toggle-state').value, 1);
});

test('menu: toggles, hidden items, long labels, and refusal of a keyless or huge menu', () => {
  const m = new DbusMenu();
  m.setItems([{ key: 't', label: 'x'.repeat(1000), toggle: 'checkmark', checked: true, visible: false }]);
  const p = m.props(m.byId.get(m.ids.get('t')), []);
  assert.equal(p.get('label').value.length, 200);
  assert.equal(p.get('toggle-type').value, 'checkmark');
  assert.equal(p.get('toggle-state').value, 1);
  assert.equal(p.get('visible').value, false);
  assert.throws(() => m.setItems([{ label: 'no key' }]), /key/);
  assert.throws(() => m.setItems(Array.from({ length: 600 }, (_, i) => ({ key: 'k' + i, label: 'x' }))), /too large/);
});

test('icon colour table matches the state names the model uses', () => {
  assert.deepEqual(Object.keys(icon.COLORS).sort(), ['done', 'needsInput', 'starting', 'stopped', 'stuck', 'warning', 'working']);
});

// ---------- on a real bus ----------

let daemon, address;
const open = [];
const connect = async () => { const c = await new Connection(address).connect(); open.push(c); return c; };

before(async () => {
  if (!HAVE_DAEMON) return;
  daemon = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  address = await new Promise((resolve, reject) => {
    let buf = '';
    daemon.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i).trim()); });
    daemon.on('error', reject);
  });
});
after(() => { for (const c of open) c.close(); if (daemon) daemon.kill(); });

/** A pretend tray host: owns org.kde.StatusNotifierWatcher and remembers who registered. */
async function stubWatcher() {
  const w = await connect();
  const registered = [];
  w.exportObject('/StatusNotifierWatcher', { [WATCHER]: {
    methods: { RegisterStatusNotifierItem: { in: 's', out: '', fn: (name) => { registered.push(name); return []; } } },
    properties: { IsStatusNotifierHostRegistered: { sig: 'b', get: () => true }, ProtocolVersion: { sig: 'i', get: () => 0 } },
  } });
  assert.equal(await w.requestName(WATCHER), true);
  return { conn: w, registered };
}

const getAll = async (host, name, path, iface) => (await host.call({ destination: name, path, interface: 'org.freedesktop.DBus.Properties', member: 'GetAll', signature: 's', body: [iface] }))[0];

test('the tray registers with the watcher, and the host can read its icon, tooltip and menu', { skip }, async () => {
  const watcher = await stubWatcher();
  const conn = await connect();
  const clicked = [];
  const tray = new Tray(conn, { title: 'Votive' });
  tray.update({ states: ['working', 'needsInput'], tooltipLines: ['Claude Code · api: needs you', 'Codex · web & co: working'], attention: true });
  tray.menu.setItems(sample(clicked));
  await tray.start();
  await until(() => watcher.registered.length === 1, 'registration');
  assert.equal(watcher.registered[0], tray.serviceName);
  assert.match(tray.serviceName, /^org\.kde\.StatusNotifierItem-\d+-\d+$/);

  const host = await connect();
  const props = await getAll(host, tray.serviceName, '/StatusNotifierItem', SNI);
  assert.equal(props.get('Category').value, 'ApplicationStatus');
  assert.equal(props.get('Id').value, 'dev.votive.Votive');
  assert.equal(props.get('Status').value, 'NeedsAttention');
  assert.equal(props.get('ItemIsMenu').value, true);
  assert.equal(props.get('Menu').value, '/MenuBar');
  const pix = props.get('IconPixmap').value;
  assert.deepEqual(pix.map((p) => [p[0], p[1], p[2].length]), [22, 32, 48].map((h) => [icon.width(2, h), h, icon.width(2, h) * h * 4]));   // two dots: a row, wider than tall
  assert.ok(pix[0][2].some((b, i) => i % 4 === 0 && b > 0), 'the icon has pixels');
  const tip = props.get('ToolTip').value;
  assert.equal(tip[2], 'Votive');
  assert.equal(tip[3], 'Claude Code · api: needs you\nCodex · web &amp; co: working');   // markup characters are escaped

  const [rev, layout] = await host.call({ destination: tray.serviceName, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'GetLayout', signature: 'iias', body: [0, -1, []] });
  assert.ok(rev >= 1);
  assert.equal(layout[2].length, 4);
  assert.equal(layout[2][0].value[1].get('label').value, 'Votive: 2 sessions');

  const quitId = tray.menu.ids.get('quit');
  await host.call({ destination: tray.serviceName, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [quitId, 'clicked', new Variant('i', 0), 0] });
  assert.deepEqual(clicked, ['quit']);
  await host.call({ destination: tray.serviceName, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [quitId, 'opened', new Variant('i', 0), 0] });
  assert.deepEqual(clicked, ['quit']);                                           // only a click runs the action
  await assert.rejects(host.call({ destination: tray.serviceName, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'Event', signature: 'isvu', body: [424242, 'clicked', new Variant('i', 0), 0] }), (e) => e.dbusName === 'org.freedesktop.DBus.Error.InvalidArgs');
  const grp = (await host.call({ destination: tray.serviceName, path: '/MenuBar', interface: 'com.canonical.dbusmenu', member: 'GetGroupProperties', signature: 'aias', body: [[quitId], ['label']] }))[0];
  assert.equal(grp[0][1].get('label').value, 'Quit Votive Dots');
  tray.stop();
  watcher.conn.close();
});

test('changes reach the host as signals, and only real changes do', { skip }, async () => {
  const watcher = await stubWatcher();
  const conn = await connect();
  const tray = new Tray(conn);
  tray.menu.setItems(sample());
  await tray.start();
  const host = await connect();
  await host.addMatch(`type='signal',sender='${tray.serviceName}'`);
  const got = [];
  host.on('signal', (m) => got.push(m.member + (m.member === 'NewStatus' ? ':' + m.body[0] : '')));
  tray.update({ states: ['done'], tooltipLines: ['Claude Code · api: done'] });
  // NewAttentionIcon too: GNOME draws the attention icon while the status is NeedsAttention and refreshes it only on this signal
  await until(() => got.includes('NewIcon') && got.includes('NewAttentionIcon') && got.includes('NewToolTip'), 'icon, attention icon and tooltip signals');
  const att = (await host.call({ destination: tray.serviceName, path: '/StatusNotifierItem', interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', body: ['org.kde.StatusNotifierItem', 'AttentionIconPixmap'] }))[0].value;
  const normal = (await host.call({ destination: tray.serviceName, path: '/StatusNotifierItem', interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', body: ['org.kde.StatusNotifierItem', 'IconPixmap'] }))[0].value;
  assert.deepEqual(att.map((p) => [p[0], p[1], Buffer.from(p[2]).toString('hex')]), normal.map((p) => [p[0], p[1], Buffer.from(p[2]).toString('hex')]), 'the attention icon shows the same dots as the normal one');
  const before = got.length;
  tray.update({ states: ['done'], tooltipLines: ['Claude Code · api: done'] });   // nothing changed
  await wait(100);
  assert.equal(got.length, before);
  tray.update({ states: ['done'], tooltipLines: ['Claude Code · api: done'], attention: true });
  await until(() => got.includes('NewStatus:NeedsAttention'), 'status signal');
  const items = sample(); items[0].label = 'Votive: 1 session';
  tray.menu.setItems(items);
  await until(() => got.includes('ItemsPropertiesUpdated'), 'a changed label arrives as ItemsPropertiesUpdated');
  assert.ok(!got.includes('LayoutUpdated'), 'and does not make the host re-read the layout');
  tray.menu.setItems(items.slice(0, 3));
  await until(() => got.includes('LayoutUpdated'), 'a removed row arrives as LayoutUpdated');
  tray.stop();
  watcher.conn.close();
});

test('a tray started before any tray host registers when one appears, and again when it restarts', { skip }, async () => {
  const conn = await connect();
  const tray = new Tray(conn);
  await tray.start();                                            // no watcher: must not throw
  assert.equal(tray.registered, false);
  const w1 = await stubWatcher();
  await until(() => w1.registered.includes(tray.serviceName), 'registration with the late watcher');
  assert.equal(tray.registered, true);
  w1.conn.close();
  await until(() => tray.registered === false, 'noticing the host left');
  const w2 = await stubWatcher();
  await until(() => w2.registered.includes(tray.serviceName), 'registration with the restarted watcher');
  assert.deepEqual(w2.registered, [tray.serviceName]);                 // trays that were stopped do not sign up again
  tray.stop();
  w2.conn.close();
});

test('the pulse swaps two frames while a session needs attention, and stops when none does', { skip }, async () => {
  const conn = await connect();
  const tray = new Tray(conn);
  tray.update({ states: ['needsInput'], tooltipLines: ['x'] });
  const first = tray.pixmap[0][2];
  assert.ok(tray._timer, 'a pulse timer is running');
  await until(() => !tray.pixmap[0][2].equals(first), 'the second frame', 2500);
  tray.update({ states: ['done'], tooltipLines: ['x'] });
  assert.equal(tray._timer, null);
  assert.equal(tray.phase, 0);
});

// ---------- an independent client ----------
//
// Everything above talks to the tray with our own D-Bus client, so a mistake in the wire format that both sides share would pass. dbus-send
// is the reference implementation's tool (libdbus): if it can read our objects, the messages are valid by someone else's rules.

const HAVE_SEND = HAVE_DAEMON && !spawnSync('dbus-send', ['--version']).error;

test('an independent client (dbus-send, from libdbus) can read the tray icon, tooltip and menu', { skip: HAVE_SEND ? false : 'needs dbus-send (Linux; run ./Scripts/test-linux.sh)' }, async () => {
  const watcher = await stubWatcher();
  const conn = await connect();
  const tray = new Tray(conn);
  tray.update({ states: ['needsInput', 'done'], tooltipLines: ['Claude Code · api: needs you'], attention: true });
  tray.menu.setItems(sample());
  await tray.start();
  // asynchronous on purpose: the tray lives in this process, so a blocking call would stop it from answering
  const send = (path, method, ...args) => new Promise((resolve, reject) => {
    execFile('dbus-send', ['--session', '--print-reply', '--dest=' + tray.serviceName, path, method, ...args],
      { env: { PATH: process.env.PATH, DBUS_SESSION_BUS_ADDRESS: address }, encoding: 'utf8', timeout: 10000 },
      (err, stdout, stderr) => (err ? reject(new Error(method + ': ' + stderr)) : resolve(stdout)));
  });
  const all = await send('/StatusNotifierItem', 'org.freedesktop.DBus.Properties.GetAll', 'string:' + SNI);
  assert.match(all, /"Category"[\s\S]*"ApplicationStatus"/);
  assert.match(all, /"Status"[\s\S]*"NeedsAttention"/);
  assert.match(all, /"IconPixmap"/);
  assert.match(all, /"ToolTip"[\s\S]*"Votive Dots"[\s\S]*"Claude Code · api: needs you"/);
  assert.match(all, /"Menu"[\s\S]*object path "\/MenuBar"/);
  const xml = await send('/StatusNotifierItem', 'org.freedesktop.DBus.Introspectable.Introspect');
  assert.match(xml, /interface name=\\?"org\.kde\.StatusNotifierItem\\?"/);
  const layout = await send('/MenuBar', 'com.canonical.dbusmenu.GetLayout', 'int32:0', 'int32:-1', 'array:string:');
  assert.match(layout, /"Votive: 2 sessions"/);
  assert.match(layout, /"Quit Votive Dots"/);
  assert.match(layout, /"children-display"[\s\S]*"submenu"/);
  const grp = await send('/MenuBar', 'com.canonical.dbusmenu.GetGroupProperties', 'array:int32:', 'array:string:label');
  assert.match(grp, /"Claude Code · api: needs you"/);
  const ver = await send('/MenuBar', 'org.freedesktop.DBus.Properties.Get', 'string:com.canonical.dbusmenu', 'string:Version');
  assert.match(ver, /uint32 3/);
  tray.stop();
  watcher.conn.close();
});
