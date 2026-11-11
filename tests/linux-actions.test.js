'use strict';
//
// The clipboard action (linux/actions.js): which tool, how it is started, and what the person is told when there is none. With stand-in programs, nothing real is run.
//
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const A = require('../linux/actions');

const have = (...names) => (p) => names.some((n) => p === '/usr/bin/' + n);
const fakeSpawn = (code = 0) => {
  const calls = [];
  const fn = (bin, args, opts) => {
    const c = new EventEmitter();
    c.stdin = new EventEmitter();
    c.stdin.end = (t) => { calls.at(-1).text = t; setImmediate(() => c.emit('close', code)); };
    c.kill = () => {};
    calls.push({ bin, args, opts });
    return c;
  };
  fn.calls = calls;
  return fn;
};

test('tool choice: wl-copy on Wayland, xclip then xsel on X11, nothing when none is installed', () => {
  assert.deepEqual(A.clipboardTool({ WAYLAND_DISPLAY: 'wayland-0' }, have('wl-copy', 'xclip')), { bin: '/usr/bin/wl-copy', args: [] });
  assert.deepEqual(A.clipboardTool({ DISPLAY: ':0' }, have('wl-copy', 'xclip', 'xsel')), { bin: '/usr/bin/xclip', args: ['-selection', 'clipboard'] });
  assert.deepEqual(A.clipboardTool({ DISPLAY: ':0' }, have('xsel')), { bin: '/usr/bin/xsel', args: ['--clipboard', '--input'] });
  assert.deepEqual(A.clipboardTool({ WAYLAND_DISPLAY: 'w', DISPLAY: ':0' }, have('xclip')), { bin: '/usr/bin/xclip', args: ['-selection', 'clipboard'] });   // XWayland: the X tool still works
  assert.equal(A.clipboardTool({ DISPLAY: ':0' }, have()), null);
  assert.equal(A.clipboardTool({}, have('wl-copy')), null);
});

test('the reason is in words the person can act on', () => {
  assert.equal(A.whyNoClipboard({}, have()), 'no display');
  assert.match(A.whyNoClipboard({ WAYLAND_DISPLAY: 'w' }, have()), /wl-clipboard/);
  assert.match(A.whyNoClipboard({ DISPLAY: ':0' }, have()), /xclip/);
});

test('copyText: the text goes in on standard input, never as an argument, and only the display variables reach the tool', async () => {
  const spawnFn = fakeSpawn(0);
  const env = { DISPLAY: ':0', XAUTHORITY: '/run/x', SECRET: 'no', LD_PRELOAD: '/evil.so', XDG_RUNTIME_DIR: '/run/user/1000' };
  const r = await A.copyText('/home/u/my project; rm -rf /', { env, ex: have('xclip'), spawnFn });
  assert.deepEqual(r, { ok: true, why: '' });
  assert.deepEqual(spawnFn.calls[0].args, ['-selection', 'clipboard']);
  assert.equal(spawnFn.calls[0].text, '/home/u/my project; rm -rf /');
  assert.deepEqual(spawnFn.calls[0].opts.env, { DISPLAY: ':0', XAUTHORITY: '/run/x', XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.equal(spawnFn.calls[0].opts.shell, undefined);
});

test('copyText: a failing tool, a missing tool and a huge text are all handled', async () => {
  assert.deepEqual(await A.copyText('x', { env: { DISPLAY: ':0' }, ex: have('xclip'), spawnFn: fakeSpawn(1) }), { ok: false, why: 'xclip failed' });
  assert.match((await A.copyText('x', { env: { DISPLAY: ':0' }, ex: have(), spawnFn: fakeSpawn() })).why, /install xclip/);
  const spawnFn = fakeSpawn(0);
  await A.copyText('a'.repeat(10000), { env: { DISPLAY: ':0' }, ex: have('xclip'), spawnFn });
  assert.equal(spawnFn.calls[0].text.length, 4096);
  const boom = () => { throw new Error('EACCES'); };
  assert.deepEqual(await A.copyText('x', { env: { DISPLAY: ':0' }, ex: have('xclip'), spawnFn: boom }), { ok: false, why: 'could not start xclip' });
});
