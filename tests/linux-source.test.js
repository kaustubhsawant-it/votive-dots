'use strict';
//
// The Linux tray keeps the promises the Mac and Windows apps make: nothing in it goes online, it loads no packages, and it
// never sends input to another program. The only socket it opens is the unix socket of the user's own D-Bus session bus.
// Same idea as tests/no-network.test.js (JavaScript) and tests/windows-source.test.js (C#).
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'linux');
const files = () => fs.readdirSync(DIR, { recursive: true }).filter((f) => f.endsWith('.js') && !f.split(path.sep).includes('node_modules'));
const code = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');

test('linux tray: there is source to check', () => {
  assert.ok(files().includes(path.join('dbus', 'wire.js')));
  assert.ok(files().includes(path.join('dbus', 'bus.js')));
});

test('linux tray: it loads only Node built-ins without network access, and its own files', () => {
  const allowed = new Set(['fs', 'os', 'path', 'events', 'net', 'child_process', 'crypto', 'zlib']);
  const hits = [];
  for (const f of files()) {
    for (const m of code(f).matchAll(/require\(\s*([^)]*?)\s*\)/g)) {
      const lit = /^['"]([^'"]+)['"]$/.exec(m[1]);
      if (lit && (lit[1].startsWith('./') || lit[1].startsWith('../') || allowed.has(lit[1]))) continue;
      if (/^path\.join\(__dirname/.test(m[1])) continue;
      hits.push(f + ': require(' + m[1] + ')');
    }
  }
  assert.deepEqual(hits, []);
});

test('linux tray: no network APIs; `net` is used only to open a unix socket', () => {
  const banned = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bimport\s*\(/, /require\(\s*['"](?:node:)?(?:http|https|http2|dgram|tls|dns)['"]\s*\)/,
    /\bnet\.(?:createServer|Server|connect)\b/, /\.listen\s*\(/, /https?:\/\/(?!docs\.|github\.com|freedesktop\.org|www\.freedesktop\.org)/];
  const hits = [];
  for (const f of files()) {
    const src = code(f);
    for (const re of banned) if (re.test(src)) hits.push(f + ': ' + re);
    // every net.createConnection must take a path, never a port or host
    for (const m of src.matchAll(/net\.createConnection\(([^)]*)\)/g)) if (!/socketPath|\.path\b|path\s*[,)]|^\s*[A-Za-z_.]*[Pp]ath\s*$/.test(m[1])) hits.push(f + ': net.createConnection(' + m[1] + ')');
  }
  assert.deepEqual(hits, []);
});

test('linux tray: it never sends input to, or reads from, another program', () => {
  const banned = [/\bxdotool\s+(?:key|type)\b/, /\bydotool\b/, /\bwtype\b/, /\buinput\b/, /\/proc\/\d+\/(?:mem|maps|environ)\b/, /\bptrace\b/, /\bgdb\b/];
  const hits = [];
  for (const f of files()) for (const re of banned) if (re.test(code(f))) hits.push(f + ': ' + re);
  assert.deepEqual(hits, []);
});
