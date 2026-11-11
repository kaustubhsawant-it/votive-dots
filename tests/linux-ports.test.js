'use strict';
//
// The read-only Ports list on Linux (linux/ports.js and its rows in linux/votive-tray.js): the watch list file, the facts read from a /proc-shaped folder,
// the wording, and the menu rows. Reading what listens is in linux-ports-proc.test.js. No real /proc and no signals are involved.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../linux/ports');
const app = require('../linux/votive-tray');

test('watch list: whole numbers in range, no repeats, sorted, at most 24; a missing, broken or huge file is an empty list', () => {
  assert.deepEqual(P.cleanList([8000, 3000, 3000, 0, 70000, -1, '80', 1.5, null, 22]), [22, 3000, 8000]);
  assert.deepEqual(P.cleanList({ a: 1 }), []);
  assert.equal(P.cleanList(Array.from({ length: 40 }, (_, i) => i + 1)).length, 24);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-ports-'));
  assert.deepEqual(P.loadWatch(root), []);
  fs.writeFileSync(P.fileOf(root), '[8000, 5173,]');
  assert.deepEqual(P.loadWatch(root), []);
  fs.writeFileSync(P.fileOf(root), '[8000, 5173, 8000]');
  assert.deepEqual(P.loadWatch(root), [5173, 8000]);
  fs.writeFileSync(P.fileOf(root), '[' + '1,'.repeat(3000) + '2]');
  assert.deepEqual(P.loadWatch(root), []);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-ports-'));
  P.ensureFile(fresh);
  assert.equal(fs.readFileSync(P.fileOf(fresh), 'utf8').trim(), '[]');
  fs.writeFileSync(P.fileOf(fresh), '[22]');
  P.ensureFile(fresh);
  assert.deepEqual(P.loadWatch(fresh), [22]);
});

test('inspect: program file, start folder and frozen state come from a /proc-shaped folder; only own processes show a folder', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-proc-'));
  const mk = (pid, state) => {
    fs.mkdirSync(path.join(proc, String(pid)));
    fs.symlinkSync('/usr/bin/node', path.join(proc, String(pid), 'exe'));
    fs.symlinkSync('/home/me/dev/app', path.join(proc, String(pid), 'cwd'));
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), pid + ' (no de) ' + state + ' 1 1 1 0 -1');
  };
  mk(4123, 'S'); mk(77, 'T');
  const L = (port, pid) => ({ port, pid, command: 'node', localOnly: true });
  const rows = P.inspect([L(3000, 4123), L(5173, 77), L(53, 0), L(9, 424242)], { proc });
  assert.deepEqual(rows.map((r) => [r.path, r.folder, r.paused, r.mine]), [
    ['/usr/bin/node', '/home/me/dev/app', false, true],
    ['/usr/bin/node', '/home/me/dev/app', true, true],      // state T: frozen (SIGSTOP or Ctrl-Z), even with a space in the program name
    [null, null, false, false],
    [null, null, false, false],                              // a process that ended
  ]);
  const other = P.inspect([L(3000, 4123)], { proc, uid: (process.getuid ? process.getuid() : 0) + 1 });
  assert.equal(other[0].mine, false);
  assert.equal(other[0].folder, null);                       // never read another user's working folder
});

test('wording: titles, details, the home folder as ~, and a hint that is never a claim', () => {
  const l = { port: 3000, pid: 4123, command: 'node', localOnly: false };
  assert.equal(P.rowTitle(3000, [l]), '3000  ·  node (pid 4123)');
  assert.equal(P.rowTitle(3000, [l, { port: 3000, pid: 5, command: 'node', localOnly: false }], true), '3000  ·  node (pid 4123) +1  ·  paused');
  assert.equal(P.rowTitle(5173, []), '5173  ·  free');
  assert.match(P.rowTitle(53, [{ port: 53, pid: 0, command: '', localOnly: true }]), /another user's program/);
  assert.equal(P.allPortsTitle({ listener: l, paused: false }), '3000  ·  node  ·  all interfaces');
  assert.equal(P.tildePath('/home/me/dev/app', '/home/me'), '~/dev/app');
  assert.equal(P.tildePath('/home/mellow/x', '/home/me'), '/home/mellow/x');
  const d = P.details({ listener: l, path: '/usr/bin/node', folder: '/home/me/dev/app', paused: true }, '/home/me');
  assert.deepEqual(d, ['Program: /usr/bin/node', 'Started in: ~/dev/app', 'Reachable from: other devices on your network too', 'Port 3000 is usually: dev server (Node, React, Rails)', 'Status: paused (frozen, still holding the port)']);
});

const row = (port, pid, command, o = {}) => Object.assign({ listener: { port, pid, command, localOnly: true }, path: null, folder: null, paused: false, mine: true }, o);

test('buildMenu: the Ports item shows watched ports with what uses them, all listening ports, and the edit row; nothing when it is off', () => {
  const log = [];
  const rows = [row(5173, 99, 'web-dashboard', { folder: '/home/me/dev/web' }), row(8000, 98, 'shop-api'), row(6379, 5, 'redis')];
  rows[2].listener.localOnly = false;
  const item = app.buildMenu([], { ports: { watched: [5173, 8000, 9999], rows, home: '/home/me' }, onEditPorts: () => log.push('edit'), onQuit() {} }).find((r) => r.key === 'ports');
  assert.equal(item.label, 'Ports');
  const labels = item.children.filter((c) => !c.separator).map((c) => c.label);
  assert.equal(labels[0], 'Watched ports');
  assert.match(labels[1], /^🟠  5173  ·  web-dashboard \(pid 99\)\n.*~\/dev\/web  ·  this computer only$/);
  assert.match(labels[2], /^🟠  8000  ·  shop-api \(pid 98\)/);
  assert.equal(labels[3], '⚪  9999  ·  free');
  const all = item.children.find((c) => c.key === 'all-ports');
  assert.equal(all.label, 'All listening ports (3)');
  assert.deepEqual(all.children.map((c) => c.label), ['5173  ·  web-dashboard  ·  this computer only', '8000  ·  shop-api  ·  this computer only', '6379  ·  redis  ·  all interfaces']);
  item.children.find((c) => c.key === 'ports-edit').onClick();
  assert.deepEqual(log, ['edit']);
  const keys = item.children.flatMap(function walk(n) { return [n.key, ...(n.children || []).flatMap(walk)]; });
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(app.buildMenu([], { onQuit() {} }).some((r) => r.key === 'ports'), false);
});

test('buildMenu: Ports before the first scan, when ss cannot be read, with nothing listening, and with a very long list', () => {
  const only = (rows, watched = []) => app.buildMenu([], { ports: { watched, rows, home: '/h' }, onQuit() {} }).find((r) => r.key === 'ports').children;
  assert.equal(only(undefined)[0].label, 'Reading the listening ports…');
  assert.equal(only(null)[0].label, "Couldn't read the listening ports");
  assert.equal(only([]).find((c) => c.key === 'all-ports').children[0].label, 'Nothing is listening');
  assert.equal(only([]).find((c) => c.key === 'ports-head').label, 'No watched ports yet');
  const many = Array.from({ length: 55 }, (_, i) => row(1000 + i, 100 + i, 'p' + i));
  const all = only(many).find((c) => c.key === 'all-ports');
  assert.equal(all.label, 'All listening ports (55)');
  assert.equal(all.children.length, 41);
  assert.equal(all.children.at(-1).label, '… and 15 more');
});

test('prefs: only the known switch, only a true boolean counts, a broken or huge file is "all off", and a flip is written privately', () => {
  const { PrefsStore } = require('../linux/prefs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-prefs-'));
  const p = new PrefsStore(root);
  assert.deepEqual(p.read(), {});
  assert.equal(p.toggle('portToolsOn'), true);
  assert.deepEqual(new PrefsStore(root).read(), { portToolsOn: true });
  assert.equal(fs.statSync(path.join(root, 'linux-prefs.json')).mode & 0o777, 0o600);
  assert.equal(p.toggle('portToolsOn'), false);
  assert.deepEqual(p.read(), {});
  assert.throws(() => p.toggle('sounds'), /unknown switch/);
  fs.writeFileSync(path.join(root, 'linux-prefs.json'), JSON.stringify({ portToolsOn: 'yes', other: true }));
  assert.deepEqual(new PrefsStore(root).read(), {});
  fs.writeFileSync(path.join(root, 'linux-prefs.json'), '{ nope');
  assert.deepEqual(new PrefsStore(root).read(), {});
  fs.writeFileSync(path.join(root, 'linux-prefs.json'), JSON.stringify({ portToolsOn: true, pad: 'x'.repeat(5000) }));
  assert.deepEqual(new PrefsStore(root).read(), {});
});
