'use strict';
//
// The Linux "Votive Dots window" (linux/report.js): one self-contained page written to ~/.votive/report.html. Tested for what it shows, that every piece of text from another
// program is escaped, that it can load nothing and run nothing, and the menu row that opens it.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../linux/report');
const app = require('../linux/votive-tray');

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const sess = (o) => Object.assign({ key: 'a', name: 'api', agentName: 'Claude Code', cwd: '/home/u/api', state: 'working', label: 'working', prompt: 'fix the login bug', lastActivityAt: NOW - 90000 }, o);
const usage = [{ agent: 'claude-code', agentName: 'Claude Code', windows: [{ label: 'Session', usedPercentage: 43, resetsAtMs: NOW + 3 * 3600e3 }, { label: 'Weekly', usedPercentage: 93.4, resetsAtMs: NOW + 4 * 86400e3 }] }];

test('report: shows sessions (needs-you first, high priority starred), usage bars, and the habits advice', () => {
  const html = R.buildReport({
    now: NOW, usage,
    sessions: [sess({ key: 'd', name: 'docs', state: 'done', label: 'done' }), sess({ key: 'w', name: 'web', state: 'needsInput', label: 'needs you', agentName: 'Codex' }), sess({ key: 'a' })],
    highPriority: (s) => s.key === 'a',
    habits: { insights: ['Most of your use (60%) falls between 09:00 and 12:00.', 'Forecast at the reset: 71% of the weekly limit.'], samples: 120, daysSeen: 9 },
    pacing: 'Weekly limit: 93% used.\nSession window: 43% used.',
  });
  assert.ok(html.startsWith('<!doctype html>'));
  const order = ['api', 'web', 'docs'].map((n) => html.indexOf('<strong>' + n + '</strong>'));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], 'high priority first, then needs-you, then done');
  assert.match(html, /class="star"[^>]*>★<\/span><strong>api/);
  assert.match(html, /43% used/); assert.match(html, /93% used/);
  assert.match(html, /<i class="hot" style="width:93%">/, '90% and over is drawn as hot');
  assert.match(html, /<i class="" style="width:43%">/);
  assert.match(html, /Forecast at the reset: 71%/);
  assert.match(html, /Based on 120 samples over 9 whole days/);
  assert.match(html, /<pre>Weekly limit: 93% used\.\nSession window/);
  assert.match(html, /1 min ago|2 min ago/);
});

test('report: empty states say what is missing instead of showing an empty box', () => {
  const html = R.buildReport({ now: NOW });
  assert.match(html, /No agent sessions are running/);
  assert.match(html, /No plan usage has been recorded yet/);
  assert.match(html, /No usage history yet/);
  assert.doesNotMatch(html, /Pacing advice/);
});

test('report: text from another program cannot become markup, and the page can load and run nothing', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const html = R.buildReport({ now: NOW, sessions: [sess({ name: evil, prompt: evil, cwd: evil, agentName: evil, label: evil })], usage: [{ agent: 'x', agentName: evil, windows: [{ label: evil, usedPercentage: 5, resetsAtMs: NOW + 1000 }] }], habits: { insights: [evil], samples: evil, daysSeen: evil }, pacing: evil });
  assert.ok(!html.includes('<img'), 'no tag from outside survives');
  assert.ok(!/onerror=alert/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'only its escaped form is present');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/);
  const plain = R.buildReport({ now: NOW, sessions: [sess()], usage, habits: { insights: ['x'], samples: 1, daysSeen: 1 }, pacing: 'p' });
  assert.ok(!/<script|<link|<iframe|<object|<embed|<form|<a |https?:\/\/|src=|href=|url\(|@import/i.test(plain), 'no script, no outside resource, no link');
  assert.equal(R.esc(null), ''); assert.equal(R.esc(5), '5');
});

test('report: written as a private file, atomically; gather survives a missing history and missing usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-report-'));
  const file = R.write(root, '<p>x</p>');
  assert.equal(file, path.join(root, 'report.html'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(root).length, 1, 'no temporary file is left behind');
  const g = R.gather({ eventsSessions: [sess()], usageDir: path.join(root, 'nope'), priority: { pins: { a: 1 }, folders: {} }, now: NOW, habitsFn: () => { throw new Error('x'); } });
  assert.deepEqual(g.usage, []);
  assert.equal(g.highPriority({ key: 'a', cwd: '/' }), true);
  assert.equal(g.highPriority({ key: 'zzz', cwd: '/' }), false);
  assert.ok(R.buildReport(g).includes('api'));
  const failing = R.gather({ usageDir: root, habitsFn: () => { throw new Error('broken'); }, pacingFn: () => { throw new Error('broken'); } });
  assert.ok(failing.habits === null && failing.pacing === null);
});

test('buildMenu: Open Votive Dots report is a row only when it is wired', () => {
  let n = 0;
  const rows = app.buildMenu([], { onOpenReport: () => n++, onQuit() {} });
  const r = rows.find((x) => x.key === 'report');
  assert.equal(r.label, 'Open Votive Dots report…');
  r.onClick();
  assert.equal(n, 1);
  assert.equal(rows.findIndex((x) => x.key === 'report') < rows.findIndex((x) => x.key === 'quit'), true);
  assert.equal(app.buildMenu([], { onQuit() {} }).some((x) => x.key === 'report'), false);
});

test('where the report goes and how it opens: a visible folder (a snap browser cannot read a hidden one) and a real browser, with the file as one file:// argument', async () => {
  const { EventEmitter } = require('events');
  const A = require('../linux/actions');
  assert.equal(R.reportDir({ VOTIVE_REPORT_DIR: '/x/y' }), '/x/y');
  assert.equal(R.reportDir({}), path.join(os.homedir(), 'Votive'));
  assert.ok(!path.basename(path.dirname(R.reportDir({}) + '/x')).startsWith('.'));
  const calls = [];
  const spawnFn = (bin, args, opts) => { const c = new EventEmitter(); c.unref = () => {}; calls.push({ bin, args, opts }); return c; };
  const have = (...names) => (p) => names.some((n) => p === '/usr/bin/' + n || p === '/snap/bin/' + n);
  const env = { DISPLAY: ':0', SECRET: 'no', HOME: '/home/u' };
  assert.deepEqual(await A.openInBrowser('/home/u/Votive/my report.html', { env, ex: have('firefox', 'x-www-browser'), spawnFn }), { ok: true, why: '' });
  assert.equal(calls[0].bin, '/usr/bin/x-www-browser', "the system's choice first");
  assert.deepEqual(calls[0].args, ['file:///home/u/Votive/my%20report.html']);
  assert.equal(calls[0].opts.shell, undefined);
  assert.equal(calls[0].opts.env.SECRET, undefined);
  await A.openInBrowser('/home/u/Votive/report.html', { env, ex: (p) => p === '/snap/bin/firefox', spawnFn });
  assert.equal(calls[1].bin, '/snap/bin/firefox');
  await A.openInBrowser('/home/u/Votive/report.html', { env, ex: have('xdg-open'), spawnFn });          // no browser found: the desktop's own opener
  assert.equal(calls[2].bin, '/usr/bin/xdg-open');
  assert.equal((await A.openInBrowser('/x.html', { env: {}, ex: have('firefox'), spawnFn })).why, 'no display');
});

test('launcher: programs are started through the user manager (a NoNewPrivileges process cannot start a snap app) when systemd-run exists, and directly when it does not', async () => {
  const { EventEmitter } = require('events');
  const A = require('../linux/actions');
  const have = (...names) => (p) => names.some((n) => p === '/usr/bin/' + n);
  const env = { DISPLAY: ':0', XAUTHORITY: '/run/x', WAYLAND_DISPLAY: 'wayland-0', SECRET: 'no' };
  assert.deepEqual(A.launcher('/usr/bin/firefox', ['file:///x.html'], { env, ex: have('systemd-run') }),
    { bin: '/usr/bin/systemd-run', args: ['--user', '--quiet', '--collect', '--no-block', '-E', 'DISPLAY=:0', '-E', 'XAUTHORITY=/run/x', '-E', 'WAYLAND_DISPLAY=wayland-0', '--', '/usr/bin/firefox', 'file:///x.html'] }, 'only the desktop variables are passed on');
  assert.deepEqual(A.launcher('/usr/bin/firefox', ['u'], { env, ex: have() }), { bin: '/usr/bin/firefox', args: ['u'] });
  const calls = [];
  const spawnFn = (bin, args) => { const c = new EventEmitter(); c.unref = () => {}; calls.push({ bin, args }); return c; };
  await A.openInBrowser('/home/u/Votive/report.html', { env, ex: have('firefox', 'systemd-run'), spawnFn });
  assert.equal(calls[0].bin, '/usr/bin/systemd-run');
  assert.deepEqual(calls[0].args.slice(-2), ['/usr/bin/firefox', 'file:///home/u/Votive/report.html']);
  await A.openFile('/home/u/Votive/notes.md', { env, ex: have('xdg-open', 'systemd-run'), spawnFn });
  assert.deepEqual(calls[1].args.slice(-2), ['/usr/bin/xdg-open', '/home/u/Votive/notes.md']);
});

test('the openers work with their real default lookups too (no injected `ex`): they resolve a result and never throw', async () => {
  const { EventEmitter } = require('events');
  const A = require('../linux/actions');
  const spawnFn = () => { const c = new EventEmitter(); c.unref = () => {}; return c; };
  const env = { DISPLAY: ':0' };
  for (const r of [await A.openInBrowser('/tmp/x.html', { env, spawnFn }), await A.openFile('/tmp/x.html', { env, spawnFn }), await A.openFolder(os.tmpdir(), { env, spawnFn }), await A.openTranscript('/tmp/none.jsonl', { env, spawnFn })]) {
    assert.equal(typeof r.ok, 'boolean');
    assert.equal(typeof r.why, 'string');
  }
});

test('gather with the real readers: a real usage file becomes bars, a real history file becomes habits and pacing, and the whole page builds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-gather-'));
  const usageDir = path.join(root, 'usage');
  fs.mkdirSync(usageDir);
  fs.writeFileSync(path.join(usageDir, 'claude-code.json'), JSON.stringify({ agent: 'claude-code', windows: [{ label: 'Session', usedPercentage: 43, resetsAt: Math.floor(NOW / 1000) + 3 * 3600 }, { label: 'Weekly', usedPercentage: 92, resetsAt: Math.floor(NOW / 1000) + 3 * 86400 }] }));
  const g = R.gather({ eventsSessions: [sess()], usageDir, now: NOW, habitsFn: () => ({ insights: ['an insight'], samples: 3, daysSeen: 1 }), pacingFn: () => 'pace' });
  assert.equal(g.usage.length, 1);
  assert.equal(g.usage[0].windows.length, 2);
  const html = R.buildReport(g);
  assert.match(html, /Claude Code<\/strong> · Weekly/);
  assert.match(html, /92% used/);
  assert.equal(R.gather({ usageDir: path.join(root, 'missing'), now: NOW }).usage.length, 0, 'no usage folder: no bars, no crash');
});
