'use strict';
//
// The D-Bus client (linux/dbus/bus.js) against a real private session bus. Needs `dbus-daemon`, which a Mac does not have:
// these tests are skipped there and run in the Docker container (./Scripts/test-linux.sh installs the `dbus` package in it).
//
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const { Connection, parseAddress, sessionAddress } = require('../linux/dbus/bus');
const { Variant, DBusError } = require('../linux/dbus/wire');

const HAVE_DAEMON = process.platform === 'linux' && !spawnSync('dbus-daemon', ['--version']).error;
const skip = HAVE_DAEMON ? false : 'needs dbus-daemon (Linux; run ./Scripts/test-linux.sh)';

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
    daemon.on('exit', (c) => reject(new Error('dbus-daemon exited ' + c)));
  });
});
after(() => { for (const c of open) c.close(); if (daemon) { daemon.removeAllListeners('exit'); daemon.kill(); } });

test('addresses: path, abstract, escapes, several entries, and refusals', () => {
  assert.equal(parseAddress('unix:path=/run/user/1000/bus'), '/run/user/1000/bus');
  assert.equal(parseAddress('unix:path=/tmp/a%20b,guid=abc'), '/tmp/a b');
  assert.equal(parseAddress('unix:abstract=/tmp/dbus-x,guid=1'), '\0/tmp/dbus-x');
  assert.equal(parseAddress('tcp:host=1.2.3.4,port=1;unix:path=/x'), '/x');   // a TCP entry is skipped, never used
  assert.throws(() => parseAddress('tcp:host=1.2.3.4,port=1'), DBusError);
  assert.throws(() => parseAddress(''), DBusError);
  assert.equal(sessionAddress({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/a' }), 'unix:path=/a');
  assert.equal(sessionAddress({ XDG_RUNTIME_DIR: '/run/user/7' }), 'unix:path=/run/user/7/bus');
  assert.throws(() => sessionAddress({}), /no session bus/);
});

test('connects, gets a unique name and owns a well-known name', { skip }, async () => {
  const c = await connect();
  assert.match(c.uniqueName, /^:1\.\d+$/);
  assert.equal(await c.requestName('dev.votive.Test1'), true);
  const [owner] = await c.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetNameOwner', signature: 's', body: ['dev.votive.Test1'] });
  assert.equal(owner, c.uniqueName);
});

test('an exported object answers methods, properties, Introspect and errors', { skip }, async () => {
  const server = await connect();
  await server.requestName('dev.votive.Test2');
  let title = 'Votive';
  const seen = [];
  server.exportObject('/StatusNotifierItem', {
    'org.kde.StatusNotifierItem': {
      methods: {
        Activate: { in: 'ii', out: '', fn: (x, y) => { seen.push([x, y]); return []; } },
        Echo: { in: 'a(iiay)', out: 'a(iiay)', fn: (px) => [px] },
        Boom: { in: '', out: '', fn: () => { throw new DBusError('exploded', 'dev.votive.Error.Boom'); } },
      },
      properties: { Title: { sig: 's', get: () => title, set: (v) => { title = v; } }, Id: { sig: 's', get: () => 'votive' } },
      signals: { NewIcon: '' },
    },
  });
  const client = await connect();
  const to = { destination: 'dev.votive.Test2', path: '/StatusNotifierItem' };
  const SNI = 'org.kde.StatusNotifierItem';

  await client.call({ ...to, interface: SNI, member: 'Activate', signature: 'ii', body: [3, 4] });
  assert.deepEqual(seen, [[3, 4]]);

  const px = [[22, 22, Buffer.from([255, 1, 2, 3])]];
  assert.deepEqual((await client.call({ ...to, interface: SNI, member: 'Echo', signature: 'a(iiay)', body: [px] }))[0], px);

  const P = 'org.freedesktop.DBus.Properties';
  assert.equal((await client.call({ ...to, interface: P, member: 'Get', signature: 'ss', body: [SNI, 'Title'] }))[0].value, 'Votive');
  await client.call({ ...to, interface: P, member: 'Set', signature: 'ssv', body: [SNI, 'Title', new Variant('s', 'Votive: 2 sessions')] });
  assert.equal(title, 'Votive: 2 sessions');
  const all = (await client.call({ ...to, interface: P, member: 'GetAll', signature: 's', body: [SNI] }))[0];
  assert.equal(all.get('Id').value, 'votive');
  await assert.rejects(client.call({ ...to, interface: P, member: 'Set', signature: 'ssv', body: [SNI, 'Id', new Variant('s', 'x')] }), (e) => e.dbusName === 'org.freedesktop.DBus.Error.PropertyReadOnly');
  await assert.rejects(client.call({ ...to, interface: P, member: 'Set', signature: 'ssv', body: [SNI, 'Title', new Variant('i', 1)] }), (e) => e.dbusName === 'org.freedesktop.DBus.Error.InvalidArgs');

  const xml = (await client.call({ ...to, interface: 'org.freedesktop.DBus.Introspectable', member: 'Introspect' }))[0];
  assert.match(xml, /<interface name="org.kde.StatusNotifierItem">/);
  assert.match(xml, /<method name="Activate"><arg type="i" direction="in"\/><arg type="i" direction="in"\/><\/method>/);
  assert.match(xml, /<signal name="NewIcon">/);
  assert.match(xml, /<property name="Title" type="s" access="readwrite"\/>/);
  const rootXml = (await client.call({ destination: 'dev.votive.Test2', path: '/', interface: 'org.freedesktop.DBus.Introspectable', member: 'Introspect' }))[0];
  assert.match(rootXml, /<node name="StatusNotifierItem"\/>/);   // parents list their children, which is how tools find the item

  await assert.rejects(client.call({ ...to, interface: SNI, member: 'Boom' }), (e) => e.dbusName === 'dev.votive.Error.Boom' && /exploded/.test(e.message));
  await assert.rejects(client.call({ ...to, interface: SNI, member: 'Nope' }), (e) => e.dbusName === 'org.freedesktop.DBus.Error.UnknownMethod');
  await assert.rejects(client.call({ ...to, interface: 'dev.other.Thing', member: 'Activate' }), (e) => e.dbusName === 'org.freedesktop.DBus.Error.UnknownInterface');
  await assert.rejects(client.call({ ...to, path: '/nothing', interface: SNI, member: 'Activate', signature: 'ii', body: [1, 1] }), (e) => e.dbusName === 'org.freedesktop.DBus.Error.UnknownObject');
  await assert.rejects(client.call({ ...to, interface: SNI, member: 'Activate', signature: 's', body: ['wrong'] }), (e) => e.dbusName === 'org.freedesktop.DBus.Error.InvalidArgs');
  await assert.rejects(client.call({ destination: 'dev.votive.NoSuchName', path: '/', interface: 'a.b', member: 'C' }), (e) => e.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown');
});

test('signals reach a connection that subscribed, and PropertiesChanged carries the new value', { skip }, async () => {
  const server = await connect();
  await server.requestName('dev.votive.Test3');
  let status = 'Passive';
  server.exportObject('/StatusNotifierItem', { 'org.kde.StatusNotifierItem': { properties: { Status: { sig: 's', get: () => status } }, signals: { NewStatus: 's' } } });
  const listener = await connect();
  await listener.addMatch("type='signal',sender='dev.votive.Test3'");
  const got = [];
  listener.on('signal', (m) => got.push(m));
  server.emitSignal('/StatusNotifierItem', 'org.kde.StatusNotifierItem', 'NewStatus', 's', ['NeedsAttention']);
  status = 'NeedsAttention';
  server.emitPropertiesChanged('/StatusNotifierItem', 'org.kde.StatusNotifierItem', ['Status']);
  await new Promise((r) => { const t = setInterval(() => { if (got.length >= 2) { clearInterval(t); r(); } }, 10); });
  assert.equal(got[0].member, 'NewStatus');
  assert.deepEqual(got[0].body, ['NeedsAttention']);
  assert.equal(got[1].member, 'PropertiesChanged');
  assert.equal(got[1].body[1].get('Status').value, 'NeedsAttention');
});

test('a call that is never answered times out, and a closed connection rejects calls', { skip }, async () => {
  const server = await connect();
  await server.requestName('dev.votive.Test4');
  server.exportObject('/slow', { 'dev.votive.Slow': { methods: { Wait: { in: '', out: '', fn: () => new Promise(() => {}) } } } });
  const client = await connect();
  await assert.rejects(client.call({ destination: 'dev.votive.Test4', path: '/slow', interface: 'dev.votive.Slow', member: 'Wait' }, 150), (e) => /no reply/.test(e.message));
  client.close();
  await assert.rejects(client.call({ destination: 'dev.votive.Test4', path: '/slow', interface: 'dev.votive.Slow', member: 'Wait' }), /closed/);
});

test('a peer that speaks garbage closes the connection instead of crashing it', { skip }, async () => {
  const c = await connect();
  const closed = new Promise((r) => c.once('close', r));
  c.socket.emit('data', Buffer.from('this is definitely not a dbus message'));
  const err = await closed;
  assert.ok(err instanceof DBusError);
  assert.ok(c.closed);
});
