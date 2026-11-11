'use strict';
//
// Prompt snippets on Linux: the file rules (linux/snippets.js, the same as the Mac's SnippetStore), the clipboard read and the file opener
// (linux/actions.js, with stand-in programs), and the menu rows (linux/votive-tray.js buildMenu).
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const S = require('../linux/snippets');
const A = require('../linux/actions');
const app = require('../linux/votive-tray');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'votive-snip-'));
const have = (...names) => (p) => names.some((n) => p === '/usr/bin/' + n);

test('snippets: a missing file is an empty list; a broken one is reported (null), not wiped', () => {
  const root = scratch();
  assert.deepEqual(S.loadStrict(root), []);
  fs.writeFileSync(S.fileOf(root), '["one", "two",]');            // a trailing comma, as after a hand edit
  assert.equal(S.loadStrict(root), null);
  assert.deepEqual(S.load(root), []);
  assert.equal(S.add(root, 'three'), 'unreadable');
  assert.equal(fs.readFileSync(S.fileOf(root), 'utf8'), '["one", "two",]');   // left exactly as it was
  fs.writeFileSync(S.fileOf(root), '[1, 2]');
  assert.equal(S.loadStrict(root), null);                           // not strings
  fs.writeFileSync(S.fileOf(root), '{"a": "b"}');
  assert.equal(S.loadStrict(root), null);                           // not an array
});

test('snippets: add trims, refuses empty and duplicates, and writes a private file', () => {
  const root = scratch();
  assert.equal(S.add(root, '  Run the tests  \n'), 'added');
  assert.equal(S.add(root, 'Run the tests'), 'duplicate');
  assert.equal(S.add(root, '   '), 'empty');
  assert.equal(S.add(root, null), 'empty');
  assert.deepEqual(S.load(root), ['Run the tests']);
  assert.equal(fs.statSync(S.fileOf(root)).mode & 0o777, 0o600);
  fs.writeFileSync(S.fileOf(root), JSON.stringify(['keep', '  ', '']));
  assert.deepEqual(S.load(root), ['keep']);                         // blank entries are dropped when reading
});

test('snippets: a file over 1 MB is not read; ensureFile creates examples once and never overwrites', () => {
  const root = scratch();
  fs.writeFileSync(S.fileOf(root), JSON.stringify(['x'.repeat(1100 * 1024)]));
  assert.equal(S.loadStrict(root), null);
  const fresh = scratch();
  S.ensureFile(fresh);
  assert.deepEqual(S.load(fresh), S.EXAMPLES);
  fs.writeFileSync(S.fileOf(fresh), '["mine"]');
  S.ensureFile(fresh);
  assert.deepEqual(S.load(fresh), ['mine']);
});

test('snippets: the menu text is one line, 48 characters at most', () => {
  assert.equal(S.shown('short'), 'short');
  assert.equal(S.shown('line one\n  line two'), 'line one line two');
  const long = S.shown('a'.repeat(60));
  assert.equal(long, 'a'.repeat(48) + '…');
});

const fakeSpawn = ({ code = 0, out = '', fail = false } = {}) => {
  const calls = [];
  const fn = (bin, args, opts) => {
    if (fail) throw new Error('EACCES');
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.kill = () => {};
    c.unref = () => {};
    calls.push({ bin, args, opts });
    setImmediate(() => { if (out) c.stdout.emit('data', Buffer.from(out)); c.emit('close', code); });
    return c;
  };
  fn.calls = calls;
  return fn;
};

test('clipboard read: wl-paste on Wayland, xclip then xsel on X11, and a reason when there is none', async () => {
  assert.deepEqual(A.pasteTool({ WAYLAND_DISPLAY: 'w' }, have('wl-paste', 'xclip')), { bin: '/usr/bin/wl-paste', args: ['--no-newline'] });
  assert.deepEqual(A.pasteTool({ DISPLAY: ':0' }, have('xclip', 'xsel')), { bin: '/usr/bin/xclip', args: ['-selection', 'clipboard', '-out'] });
  assert.deepEqual(A.pasteTool({ DISPLAY: ':0' }, have('xsel')), { bin: '/usr/bin/xsel', args: ['--clipboard', '--output'] });
  assert.equal(A.pasteTool({ DISPLAY: ':0' }, have()), null);
  assert.match((await A.readText({ env: { DISPLAY: ':0' }, ex: have(), spawnFn: fakeSpawn() })).why, /install xclip/);
});

test('clipboard read: returns the text, caps it, and reports a failing or missing tool; only the display variables reach the tool', async () => {
  const sp = fakeSpawn({ out: 'Explain this error' });
  const env = { DISPLAY: ':0', XAUTHORITY: '/run/x', SECRET: 'no', LD_PRELOAD: '/evil.so' };
  assert.deepEqual(await A.readText({ env, ex: have('xclip'), spawnFn: sp }), { ok: true, text: 'Explain this error', why: '' });
  assert.deepEqual(sp.calls[0].opts.env, { DISPLAY: ':0', XAUTHORITY: '/run/x' });
  assert.equal(sp.calls[0].opts.shell, undefined);
  const big = await A.readText({ env, ex: have('xclip'), spawnFn: fakeSpawn({ out: 'a'.repeat(9000) }) });
  assert.equal(big.text.length, 4096);
  assert.deepEqual(await A.readText({ env, ex: have('xclip'), spawnFn: fakeSpawn({ code: 1 }) }), { ok: false, text: '', why: 'the clipboard has no text' });
  assert.deepEqual(await A.readText({ env, ex: have('xclip'), spawnFn: fakeSpawn({ fail: true }) }), { ok: false, text: '', why: 'could not start xclip' });
});

test('open file: xdg-open with the path as one argument (no shell), and honest when it cannot', async () => {
  const sp = fakeSpawn();
  const r = await A.openFile('/home/u/.votive/snippets.json', { env: { DISPLAY: ':0', SECRET: 'no' }, ex: have('xdg-open'), spawnFn: sp });
  assert.deepEqual(r, { ok: true, why: '' });
  assert.deepEqual(sp.calls[0].args, ['/home/u/.votive/snippets.json']);
  assert.equal(sp.calls[0].opts.shell, undefined);
  assert.deepEqual(sp.calls[0].opts.env, { DISPLAY: ':0', PATH: '/usr/bin:/bin' });
  assert.match((await A.openFile('/x', { env: { DISPLAY: ':0' }, ex: have(), spawnFn: sp })).why, /xdg-utils/);
  assert.equal((await A.openFile('/x', { env: {}, ex: have('xdg-open'), spawnFn: sp })).why, 'no display');
  assert.equal((await A.openFile('/x', { env: { DISPLAY: ':0' }, ex: have('xdg-open'), spawnFn: fakeSpawn({ fail: true }) })).why, 'could not start xdg-open');
});

test('buildMenu: Prompt snippets lists them, copies the full text on click, and always offers Add and Edit', () => {
  const log = [];
  const long = 'Write a commit message for the staged changes, in the imperative mood, under 72 characters';
  const rows = app.buildMenu([], { snippets: ['Run the tests', long], onCopySnippet: (t) => log.push(['copy', t]), onAddSnippet: () => log.push('add'), onEditSnippets: () => log.push('edit'), onQuit() {} });
  const root = rows.find((r) => r.key === 'snippets');
  assert.equal(root.label, 'Prompt snippets');
  assert.deepEqual(root.children.filter((c) => !c.separator).map((c) => c.label), ['Run the tests', long.slice(0, 48) + '…', 'Add from clipboard', 'Edit snippets…']);
  assert.equal(root.children.filter((c) => c.separator).length, 1);
  root.children[1].onClick(); root.children.find((c) => c.key === 'snip-add').onClick(); root.children.find((c) => c.key === 'snip-edit').onClick();
  assert.deepEqual(log, [['copy', long], 'add', 'edit']);

  const empty = app.buildMenu([], { snippets: [], onQuit() {} }).find((r) => r.key === 'snippets');
  assert.equal(empty.children[0].label, 'No snippets yet');
  assert.equal(empty.children[0].enabled, false);
  assert.equal(app.buildMenu([], { onQuit() {} }).find((r) => r.key === 'snippets'), undefined);   // callers that pass nothing see no new row
});
