'use strict';
//
// The optional Ports list (developer tool, off by default), read-only on Linux: which programs listen on which TCP ports, and which ports you watch.
// The same ideas and wording as the Mac's PortScan.swift. It runs no program at all: it reads /proc/net/tcp and /proc/net/tcp6 (what listens), and the file
// descriptor links of processes of the same user (who owns each socket), so it works inside the service's sandbox (which allows unix sockets only: `ss` needs
// a netlink socket to name the owner). It opens no socket and sends no signal itself: Stop, Pause and Resume are in portactions.js and ask first. Stopping or pausing a program is not built on Linux: that needs a

//
const fs = require('fs');
const path = require('path');

const VALID = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const MAX_WATCHED = 24;     // a menu, not an inventory
const MAX_PIDS = 8192;      // processes looked at per scan
const MAX_FDS = 4096;       // descriptors looked at per process
const SCAN_BUDGET_MS = 1500;

const fileOf = (root) => path.join(root, 'ports.json');

/** Control and direction-changing characters removed: text from another program must not be able to reorder or hide what the menu shows. */
function clean(s) {
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩‎‏؜]/g, '');
}
const safeText = (s) => clean(s).trim().slice(0, 40);
const safePath = (s) => { if (s == null) return null; const c = clean(s).slice(0, 160); return c ? c : null; };

/** Whether a listening address of /proc/net/tcp (IPv4, 8 hex digits) or /proc/net/tcp6 (32 hex digits) can only be reached from this machine. */
function hexLoopback(hex) {
  const h = String(hex).toUpperCase();
  if (h.length === 8) return h.endsWith('7F');                                                            // 0100007F is 127.0.0.1 (stored byte-swapped)
  if (h.length !== 32) return false;
  if (h === '00000000000000000000000001000000') return true;                                              // ::1
  return h.startsWith('0000000000000000FFFF0000') && h.endsWith('7F');                                    // ::ffff:127.x.x.x
}

/**
 * Parses the text of /proc/net/tcp (or tcp6): one line per socket, `sl local rem st tx:rx tr:when retrnsmt uid timeout inode ...`.
 * Only sockets in state 0A (LISTEN) count. Returns [{ port, inode, uid, localOnly }]; lines it does not understand are skipped.
 */
function parseProcNet(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;
    const m = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/.exec(f[1]);
    if (!m) continue;
    const port = parseInt(m[2], 16);
    const inode = Number(f[9]);
    const uid = Number(f[7]);
    if (!VALID(port) || !Number.isInteger(inode) || inode < 0 || !Number.isInteger(uid)) continue;
    out.push({ port, inode, uid, localOnly: hexLoopback(m[1]) });
  }
  return out;
}

/**
 * Builds the listeners from the sockets and a map inode -> { pid, command } (the processes whose descriptor links could be read, i.e. the user's own).
 * A socket nobody was found for is listed with pid 0 ("another user's program"). The same program on the same port (IPv4 and IPv6) is reported once.
 */
function listenersFrom(sockets, owners) {
  const out = [];
  const index = new Map();
  for (const sk of sockets) {
    const o = owners.get(sk.inode) || { pid: 0, command: '' };
    const key = o.pid + ':' + sk.port;
    if (index.has(key)) { const i = index.get(key); out[i].localOnly = out[i].localOnly && sk.localOnly; continue; }
    index.set(key, out.length);
    out.push({ port: sk.port, pid: o.pid, command: safeText(o.command), localOnly: sk.localOnly });
  }
  return out.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** inode -> { pid, command } for the sockets in `wanted`, found by reading the descriptor links of every process we are allowed to look at. */
function findOwners(wanted, { proc = '/proc', readdir = fs.readdirSync, readlink = fs.readlinkSync, read = (p) => fs.readFileSync(p, 'utf8'), now = Date.now } = {}) {
  const owners = new Map();
  if (!wanted.size) return owners;
  const deadline = now() + SCAN_BUDGET_MS;
  let pids = [];
  try { pids = readdir(proc).filter((n) => /^\d+$/.test(n)).slice(0, MAX_PIDS); } catch (e) { return owners; }
  for (const pid of pids) {
    if (owners.size >= wanted.size || now() > deadline) break;
    let fds;
    try { fds = readdir(proc + '/' + pid + '/fd'); } catch (e) { continue; }   // not ours to read, or gone
    for (const fd of fds.slice(0, MAX_FDS)) {
      let target;
      try { target = readlink(proc + '/' + pid + '/fd/' + fd); } catch (e) { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (!m) continue;
      const inode = Number(m[1]);
      if (!wanted.has(inode) || owners.has(inode)) continue;
      let command = '';
      try { command = read(proc + '/' + pid + '/comm').trim(); } catch (e) { /* gone */ }
      owners.set(inode, { pid: Number(pid), command: command || 'unknown' });
    }
  }
  return owners;
}

/** Everything listening on TCP now. Resolves the listeners, or null when /proc/net/tcp could not be read. */
function scan({ proc = '/proc', read = (p) => fs.readFileSync(p, 'utf8'), ...rest } = {}) {
  let sockets = [];
  let any = false;
  for (const f of ['/net/tcp', '/net/tcp6']) {
    try { sockets = sockets.concat(parseProcNet(read(proc + f))); any = true; } catch (e) { /* IPv6 may be off */ }
  }
  if (!any) return Promise.resolve(null);
  const owners = findOwners(new Set(sockets.map((x) => x.inode)), Object.assign({ proc, read }, rest));
  return Promise.resolve(listenersFrom(sockets, owners));
}

/** The watch list as stored: whole numbers in range, no repeats, sorted, at most 24. Anything else in the file is ignored. */
function cleanList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const v of raw) if (VALID(v) && !seen.has(v)) { seen.add(v); out.push(v); }
  return out.sort((a, b) => a - b).slice(0, MAX_WATCHED);
}

function loadWatch(root) {
  try {
    const file = fileOf(root);
    if (fs.statSync(file).size > 4096) return [];
    return cleanList(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) { return []; }
}

/** Creates `[]` when there is no file, so "Edit ports file" always opens something. */
function ensureFile(root) {
  const file = fileOf(root);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, '[]\n', { mode: 0o600 });
}

/** What the system says about each program (one lookup per distinct pid): its file, the folder it started in, whether it is frozen. Own processes only. */
function inspect(listeners, { proc = '/proc', uid = process.getuid ? process.getuid() : -1, readlink = fs.readlinkSync, read = (p) => fs.readFileSync(p, 'utf8'), stat = fs.statSync } = {}) {
  const cache = new Map();
  const facts = (pid) => {
    if (cache.has(pid)) return cache.get(pid);
    let f = { path: null, folder: null, paused: false, mine: false };
    if (pid > 0) {
      try {
        const own = stat(proc + '/' + pid).uid === uid;
        f.mine = own;
        try { f.path = safePath(readlink(proc + '/' + pid + '/exe').replace(/ \(deleted\)$/, '')); } catch (e) { /* not ours to read */ }
        if (own) { try { f.folder = safePath(readlink(proc + '/' + pid + '/cwd')); } catch (e) { /* gone */ } }
        try { const st = read(proc + '/' + pid + '/stat'); const m = /\) ([A-Za-z]) /.exec(st); f.paused = !!m && (m[1] === 'T' || m[1] === 't'); } catch (e) { /* gone */ }
      } catch (e) { /* the process ended */ }
    }
    cache.set(pid, f);
    return f;
  };
  return listeners.map((l) => Object.assign({ listener: l }, facts(l.pid)));
}

/** `/home/me/dev/app` -> `~/dev/app`. */
function tildePath(p, home) {
  if (!home || home === '/') return p;
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/** Well-known ports a developer meets, as a hint ("usually ..."), never as a claim about the program. */
const KNOWN = {
  80: 'HTTP web server', 443: 'HTTPS web server', 631: 'CUPS printing', 1313: 'Hugo dev server', 3000: 'dev server (Node, React, Rails)', 3306: 'MySQL',
  4000: 'dev server (Phoenix, Jekyll)', 4200: 'Angular dev server', 4321: 'Astro dev server', 5000: 'Flask dev server', 5173: 'Vite dev server', 5432: 'PostgreSQL',
  5500: 'Live Server (VS Code)', 6379: 'Redis', 8000: 'dev server (Django, python -m http.server)', 8080: 'common web or proxy port',
  8081: 'Metro (React Native) or a web port', 8888: 'Jupyter', 9000: 'common dev port (PHP-FPM, SonarQube)', 9200: 'Elasticsearch', 11434: 'Ollama', 27017: 'MongoDB',
};
const knownNote = (port) => KNOWN[port] || null;

/** The detail lines under a row: what is using the port, from where, and who can reach it. */
function details(row, home) {
  const l = row.listener;
  const lines = [];
  if (row.path) lines.push('Program: ' + tildePath(row.path, home));
  if (row.folder) lines.push('Started in: ' + tildePath(row.folder, home));
  lines.push(l.localOnly ? 'Reachable from: this computer only' : 'Reachable from: other devices on your network too');
  const note = knownNote(l.port);
  if (note) lines.push('Port ' + l.port + ' is usually: ' + note);
  if (row.paused) lines.push('Status: paused (frozen, still holding the port)');
  return lines;
}

/** `3000  ·  node (pid 4123)`, `3000  ·  node (pid 4123) +1  ·  paused`, `5173  ·  free`, `5432  ·  in use (another user's program)`. */
function rowTitle(port, listeners, paused = false) {
  const first = listeners[0];
  if (!first) return port + '  ·  free';
  if (first.pid === 0) return port + "  ·  in use (another user's program)";
  const extra = listeners.length > 1 ? ' +' + (listeners.length - 1) : '';
  return port + '  ·  ' + (first.command || 'unknown') + ' (pid ' + first.pid + ')' + extra + (paused ? '  ·  paused' : '');
}

/** A row of the all-ports list: `3000  ·  node  ·  this computer only`. */
function allPortsTitle(row) {
  const l = row.listener;
  const who = l.pid === 0 ? "another user's program" : (l.command || 'unknown');
  return l.port + '  ·  ' + who + '  ·  ' + (l.localOnly ? 'this computer only' : 'all interfaces') + (row.paused ? '  ·  paused' : '');
}

module.exports = { parseProcNet, hexLoopback, listenersFrom, findOwners, cleanList, loadWatch, ensureFile, fileOf, scan, inspect, tildePath, knownNote, details, rowTitle, allPortsTitle, MAX_WATCHED, safeText };
