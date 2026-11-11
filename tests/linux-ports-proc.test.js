'use strict';
//
// What listens on which port, read from /proc (linux/ports.js): /proc/net/tcp and tcp6 for the sockets, the descriptor links of processes we may look at for their
// owners. No program is run and no socket is opened, so it works inside the service's sandbox (unix sockets only). Tested on a /proc-shaped folder.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../linux/ports');

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const line = (n, local, st, uid, inode) => `   ${n}: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
const TCP = HEAD
  + line(0, '0100007F:1538', '0A', 1000, 5432)        // 127.0.0.1:5432
  + line(1, '00000000:0BB8', '0A', 1000, 3000)        // *:3000
  + line(2, '0100007F:1F90', '01', 1000, 9999)        // ESTABLISHED: not listening
  + line(3, '3500007F:0035', '0A', 101, 53)           // 127.0.0.53:53, another user's
  + line(4, '00000000:1F90', '0A', 1000, 8080)        // *:8080
  + line(5, '0100007F:1435', '0A', 1000, 5173)        // 127.0.0.1:5173
  + 'garbage line\n' + line(6, '0100007F:0000', '0A', 1000, 1);   // port 0: not valid
const TCP6 = HEAD
  + line(0, '00000000000000000000000001000000:0277', '0A', 0, 631)     // [::1]:631
  + line(1, '00000000000000000000000000000000:1F90', '0A', 1000, 8081)  // [::]:8080, the same program as the IPv4 one
  + line(2, '0000000000000000FFFF00000100007F:2710', '0A', 1000, 7000); // ::ffff:127.0.0.1:10000

test('parseProcNet: only listening sockets, loopback told from wildcard (IPv4, IPv6 and v4-mapped), junk and port 0 skipped', () => {
  assert.deepEqual(P.parseProcNet(TCP).map((x) => [x.port, x.inode, x.uid, x.localOnly]), [[5432, 5432, 1000, true], [3000, 3000, 1000, false], [53, 53, 101, true], [8080, 8080, 1000, false], [5173, 5173, 1000, true]]);
  assert.deepEqual(P.parseProcNet(TCP6).map((x) => [x.port, x.localOnly]), [[631, true], [8080, false], [10000, true]]);
  assert.deepEqual(P.parseProcNet(''), []);
  assert.equal(P.hexLoopback('7F000001'), false, 'the stored byte order is little-endian: this is 1.0.0.127');
  assert.equal(P.hexLoopback('0100007F'), true);
  assert.equal(P.hexLoopback('0101A8C0'), false);
});

test('listenersFrom: one row per program and port; a socket with no readable owner is "another user\'s program"; text from another program is cleaned and cut', () => {
  const sockets = [
    { port: 8080, inode: 1, uid: 1000, localOnly: false }, { port: 8080, inode: 2, uid: 1000, localOnly: true },   // IPv4 and IPv6 of the same program
    { port: 53, inode: 3, uid: 101, localOnly: true },
    { port: 4000, inode: 4, uid: 1000, localOnly: false },
  ];
  const owners = new Map([[1, { pid: 10, command: 'nginx' }], [2, { pid: 10, command: 'nginx' }], [4, { pid: 7, command: 'a‮b\u0007c' + 'x'.repeat(80) }]]);
  const rows = P.listenersFrom(sockets, owners);
  assert.deepEqual(rows.map((r) => [r.port, r.pid, r.command.slice(0, 5), r.localOnly]), [[53, 0, '', true], [4000, 7, 'abcxx', false], [8080, 10, 'nginx', false]]);
  assert.ok(rows[1].command.length === 40 && !/[‮\u0007]/.test(rows[1].command));
});

/** A /proc-shaped folder: net/tcp, net/tcp6 and processes with socket links in fd/ (dangling links, as the real ones are). */
function fakeProc() {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-procnet-'));
  fs.mkdirSync(path.join(proc, 'net'));
  fs.writeFileSync(path.join(proc, 'net', 'tcp'), TCP);
  fs.writeFileSync(path.join(proc, 'net', 'tcp6'), TCP6);
  const mk = (pid, comm, inodes) => {
    fs.mkdirSync(path.join(proc, String(pid), 'fd'), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), 'comm'), comm + '\n');
    inodes.forEach((n, i) => fs.symlinkSync('socket:[' + n + ']', path.join(proc, String(pid), 'fd', String(3 + i))));
    fs.symlinkSync('/dev/null', path.join(proc, String(pid), 'fd', '0'));
  };
  mk(4123, 'node', [3000, 12345]);
  mk(77, 'vite', [5173]);
  mk(812, 'postgres', [5432]);
  mk(10, 'nginx', [8080, 8081]);
  fs.mkdirSync(path.join(proc, '1'));                    // a process whose fd folder cannot be read (not ours)
  fs.mkdirSync(path.join(proc, 'self'));                 // not a number: never looked at
  return proc;
}

test('scan: reads /proc/net/tcp and tcp6, finds the owner of each socket from the descriptor links, and runs no program', async () => {
  const proc = fakeProc();
  const rows = await P.scan({ proc });
  assert.deepEqual(rows.map((r) => [r.port, r.pid, r.command, r.localOnly]), [
    [53, 0, '', true],
    [631, 0, '', true],            // [::1]:631 belongs to uid 0 here: nobody we may look at
    [3000, 4123, 'node', false],
    [5173, 77, 'vite', true],
    [5432, 812, 'postgres', true],
    [8080, 10, 'nginx', false],    // IPv4 *:8080 and IPv6 [::]:8080 are one program
    [10000, 0, '', true],          // ::ffff:127.0.0.1, no readable owner
  ]);
  assert.equal(await P.scan({ proc: path.join(proc, 'nope') }), null);
  fs.rmSync(path.join(proc, 'net', 'tcp6'));                                    // IPv6 switched off: IPv4 still works
  assert.ok((await P.scan({ proc })).length >= 5);
  assert.ok(!/child_process/.test(fs.readFileSync(path.join(__dirname, '..', 'linux', 'ports.js'), 'utf8')), 'ports.js starts no program');
});

test('scan: bounded: gives up at its time budget, and never looks at a folder that is not a process number', async () => {
  const proc = fakeProc();
  let reads = 0, t = 0;
  const rows = await P.scan({ proc, readlink: (p) => { reads++; return fs.readlinkSync(p); }, now: () => (t += 1000) });   // every look costs a second: out of budget at once
  assert.ok(reads < 6, 'it gave up early (' + reads + ' links read)');
  assert.ok(rows.length >= 1);
  const seen = [];
  await P.scan({ proc, readlink: (p) => { seen.push(p); return fs.readlinkSync(p); } });
  assert.ok(seen.length > 0 && seen.every((p) => !p.includes('/self/')));
});
