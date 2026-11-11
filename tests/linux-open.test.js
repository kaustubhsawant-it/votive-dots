'use strict';
//
// "Open" on Linux: showing a session's folder or ~/.votive in the file manager (linux/actions.js openFolder) and the About row. The path of a session comes from a file an
// agent wrote, so only an absolute path that resolves to a real directory may reach xdg-open; nothing else is ever handed to it.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const A = require('../linux/actions');
const app = require('../linux/votive-tray');

const have = (...names) => (p) => names.some((n) => p === '/usr/bin/' + n);
const fakeSpawn = () => {
  const calls = [];
  const fn = (bin, args, opts) => { const c = new EventEmitter(); c.unref = () => {}; calls.push({ bin, args, opts }); return c; };
  fn.calls = calls;
  return fn;
};

test('openFolder: a real directory goes to xdg-open (after resolving links); everything else is refused before any program starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-open-'));
  const dir = path.join(root, 'proj'); fs.mkdirSync(dir);
  const file = path.join(root, 'run-me.sh'); fs.writeFileSync(file, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const link = path.join(root, 'link'); fs.symlinkSync(dir, link);
  const fileLink = path.join(root, 'flink'); fs.symlinkSync(file, fileLink);
  const sp = fakeSpawn();
  const opts = { env: { DISPLAY: ':0' }, ex: have('xdg-open'), spawnFn: sp };
  assert.deepEqual(await A.openFolder(dir, opts), { ok: true, why: '' });
  assert.deepEqual(await A.openFolder(link, opts), { ok: true, why: '' });
  assert.deepEqual(sp.calls.map((c) => c.args), [[fs.realpathSync(dir)], [fs.realpathSync(dir)]]);
  const before = sp.calls.length;
  assert.equal((await A.openFolder(file, opts)).why, 'not a folder');              // a script is never opened
  assert.equal((await A.openFolder(fileLink, opts)).why, 'not a folder');
  assert.equal((await A.openFolder('relative/dir', opts)).why, 'not an absolute path');
  assert.equal((await A.openFolder('/definitely/not/here', opts)).why, 'that folder is gone');
  assert.equal((await A.openFolder(dir + '\0/x', opts)).why, 'not an absolute path');
  assert.equal((await A.openFolder(null, opts)).why, 'not an absolute path');
  assert.equal(sp.calls.length, before);
  assert.match((await A.openFolder(dir, { env: { DISPLAY: ':0' }, ex: have(), spawnFn: sp })).why, /xdg-utils/);
});

test('buildMenu: Open lists the folder of each session with an absolute path and the data folder; About is a row; nothing is shown unless it is wired', () => {
  const log = [];
  const sess = [{ key: 'a', name: 'shop', agentName: 'Claude Code', cwd: '/p/shop', state: 'done', label: 'done', lastActivityAt: 1, prompt: null },
                { key: 'b', name: 'shop', agentName: 'Codex', cwd: '/p/shop2', state: 'done', label: 'done', lastActivityAt: 1, prompt: null },
                { key: 'c', name: 'rel', agentName: 'Codex', cwd: 'relative', state: 'done', label: 'done', lastActivityAt: 1, prompt: null }];
  const rows = app.buildMenu(sess, { onOpenFolder: (d) => log.push(d), onOpenData: () => log.push('data'), onAbout: () => log.push('about'), onQuit() {} });
  const open = rows.find((r) => r.key === 'open');
  assert.deepEqual(open.children.filter((c) => !c.separator).map((c) => c.label), ['Folder · shop (Claude Code)', 'Folder · shop (Codex)', 'Votive Dots data folder (~/.votive)']);
  for (const c of open.children.filter((c) => c.onClick)) c.onClick();
  rows.find((r) => r.key === 'about').onClick();
  assert.deepEqual(log, ['/p/shop', '/p/shop2', 'data', 'about']);
  const keys = rows.flatMap(function walk(n) { return [n.key, ...(n.children || []).flatMap(walk)]; });
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(rows.findIndex((r) => r.key === 'about') < rows.findIndex((r) => r.key === 'quit'), true);
  const bare = app.buildMenu(sess, { onQuit() {} });
  assert.equal(bare.some((r) => r.key === 'open' || r.key === 'about'), false);
});

test('openTranscript: only a small regular text-like, non-executable file reaches xdg-open; everything else is refused with a reason', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-tr-'));
  const mk = (name, body = '{"a":1}\n', mode = 0o644) => { const f = path.join(root, name); fs.writeFileSync(f, body, { mode }); fs.chmodSync(f, mode); return f; };
  const good = mk('session.jsonl'), exe = mk('run.jsonl', 'x', 0o755), script = mk('evil.sh', '#!/bin/sh\n'), desktop = mk('x.desktop', '[Desktop Entry]\n'), noext = mk('transcript');
  const dir = path.join(root, 'folder.jsonl'); fs.mkdirSync(dir);
  const linkToScript = path.join(root, 'looks-fine.jsonl'); fs.symlinkSync(script, linkToScript);
  const linkToGood = path.join(root, 'link.md'); fs.symlinkSync(good, linkToGood);
  const sp = fakeSpawn();
  const opts = { env: { DISPLAY: ':0' }, ex: have('xdg-open'), spawnFn: sp };
  assert.deepEqual(await A.openTranscript(good, opts), { ok: true, why: '' });
  assert.deepEqual(await A.openTranscript(linkToGood, opts), { ok: true, why: '' });
  assert.deepEqual(sp.calls.map((c) => c.args), [[fs.realpathSync(good)], [fs.realpathSync(good)]]);
  const before = sp.calls.length;
  assert.match((await A.openTranscript(exe, opts)).why, /executable/);
  assert.match((await A.openTranscript(script, opts)).why, /not a text transcript/);
  assert.match((await A.openTranscript(linkToScript, opts)).why, /not a text transcript/, 'a link is judged by what it points to');
  assert.match((await A.openTranscript(desktop, opts)).why, /not a text transcript/);
  assert.match((await A.openTranscript(noext, opts)).why, /not a text transcript/);
  assert.equal((await A.openTranscript(dir, opts)).why, 'not a file');
  assert.equal((await A.openTranscript('relative.jsonl', opts)).why, 'not an absolute path');
  assert.equal((await A.openTranscript(good + '\0.sh', opts)).why, 'not an absolute path');
  assert.equal((await A.openTranscript(path.join(root, 'gone.jsonl'), opts)).why, 'that file is gone');
  assert.match((await A.openTranscript(good, Object.assign({}, opts, { stat: () => ({ isFile: () => true, mode: 0o644, size: 60 * 1024 * 1024 }) }))).why, /bigger than 50 MB/);
  assert.equal(sp.calls.length, before, 'nothing refused ever started a program');
});

test('sessions carry the transcript path from the event file (absolute paths only), and Open lists a Transcript row for each', () => {
  const S = require('../linux/sessions');
  const base = { sessionId: 'x', lastEvent: 'done', lastEventAt: 1000 };
  assert.equal(S.parseEvent(JSON.stringify(Object.assign({ transcriptPath: '/home/u/.claude/projects/p/s.jsonl' }, base))).transcriptPath, '/home/u/.claude/projects/p/s.jsonl');
  assert.equal(S.parseEvent(JSON.stringify(Object.assign({ transcriptPath: 'relative/s.jsonl' }, base))).transcriptPath, '');
  assert.equal(S.parseEvent(JSON.stringify(base)).transcriptPath, '');
  const log = [];
  const sess = [{ key: 'a', name: 'shop', agentName: 'Claude Code', cwd: '/p/shop', transcriptPath: '/p/t/a.jsonl', state: 'done', label: 'done', lastActivityAt: 1, prompt: null },
                { key: 'b', name: 'web', agentName: 'Codex', cwd: '/p/web', transcriptPath: '', state: 'done', label: 'done', lastActivityAt: 1, prompt: null }];
  const rows = app.buildMenu(sess, { onOpenFolder() {}, onOpenTranscript: (f) => log.push(f), onOpenData() {}, onQuit() {} }).find((r) => r.key === 'open');
  const labels = rows.children.filter((c) => !c.separator).map((c) => c.label);
  assert.deepEqual(labels, ['Folder · shop', 'Folder · web', 'Transcript · shop', 'Votive Dots data folder (~/.votive)']);
  rows.children.find((c) => c.label === 'Transcript · shop').onClick();
  assert.deepEqual(log, ['/p/t/a.jsonl']);
});
