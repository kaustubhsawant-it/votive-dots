'use strict';
//
// "Go to terminal" on Linux (linux/focus.js): finding the window that hosts a session, and raising it, with stand-ins for wmctrl, xdotool and
// the process tree. Nothing here talks to a real display.
//
const { test } = require('node:test');
const assert = require('node:assert');
const F = require('../linux/focus');
const app = require('../linux/votive-tray');

const WMCTRL = [
  '0x03800003  0 1111   host Mozilla Firefox',
  '0x04600003  0 2222   host api — Terminal',
  '0x04600009  0 2222   host docs — Terminal',
  '0x05000001  1 3333   host Visual Studio Code',
  'garbage line',
  '0x0500000z  0 4444   host not hex',
  '0x06000001  0 0      host no pid',
].join('\n');

test('parseWmctrl: ids, pids and titles; bad lines are skipped', () => {
  const w = F.parseWmctrl(WMCTRL);
  assert.deepEqual(w.map((x) => [x.id, x.pid, x.title]), [
    ['0x03800003', 1111, 'Mozilla Firefox'], ['0x04600003', 2222, 'api — Terminal'], ['0x04600009', 2222, 'docs — Terminal'], ['0x05000001', 3333, 'Visual Studio Code']]);
  assert.deepEqual(F.parseWmctrl(''), []);
});

test('pickWindow: the nearest ancestor with a window, and the folder name settles several windows of one process', () => {
  const w = F.parseWmctrl(WMCTRL);
  assert.equal(F.pickWindow([9001, 9000, 2222, 1], w, '/home/u/docs').id, '0x04600009');       // two terminal windows: the one named docs
  assert.equal(F.pickWindow([9001, 2222], w, '/home/u/api/').id, '0x04600003');
  assert.equal(F.pickWindow([2222], w, '/home/u/other').id, '0x04600003');                      // no title match: the first
  assert.equal(F.pickWindow([2222], w, '').id, '0x04600003');
  assert.equal(F.pickWindow([3333, 2222], w, '').id, '0x05000001');                             // nearest first
  assert.equal(F.pickWindow([9001, 9000], w, '/x'), null);
});

const has = (...files) => (p) => files.includes(p);

test('availability: needs X11 and a tool, and says why not', () => {
  assert.deepEqual(F.availability({ DISPLAY: ':0' }, has('/usr/bin/wmctrl')), { ok: true, why: '' });
  assert.equal(F.availability({ DISPLAY: ':0' }, has('/usr/bin/xdotool')).ok, true);
  assert.match(F.availability({ DISPLAY: ':0' }, has()).why, /wmctrl/);
  assert.match(F.availability({ WAYLAND_DISPLAY: 'wayland-0' }, has('/usr/bin/wmctrl')).why, /Wayland/);
  assert.match(F.availability({}, has('/usr/bin/wmctrl')).why, /no display/);
});

function rig({ windows = WMCTRL, chain = [{ pid: 5000 }, { pid: 4000 }, { pid: 2222 }, { pid: 1 }], tools = ['/usr/bin/wmctrl'], activate = true, env = { DISPLAY: ':0' } } = {}) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === '-lp') return { ok: true, out: windows };
    if (args[0] === 'search') return { ok: true, out: '73400323\nnot-a-number\n' };
    return { ok: activate, out: '' };
  };
  return { calls, deps: { ancestry: () => chain, run, ex: has(...tools), env } };
}

test('focusSession: raises the window of the nearest ancestor with the right wmctrl call', async () => {
  const r = rig();
  const res = await F.focusSession({ pid: 5000, cwd: '/home/u/docs' }, r.deps);
  assert.equal(res.ok, true);
  assert.equal(res.window.id, '0x04600009');
  assert.deepEqual(r.calls, [['/usr/bin/wmctrl', '-lp'], ['/usr/bin/wmctrl', '-i', '-a', '0x04600009']]);
});

test('focusSession: xdotool when wmctrl is missing', async () => {
  const r = rig({ tools: ['/usr/bin/xdotool'] });
  const res = await F.focusSession({ pid: 5000, cwd: '' }, r.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(r.calls.at(-1), ['/usr/bin/xdotool', 'windowactivate', '73400323']);          // only digits from the tool's output are used
});

test('focusSession: says why when it cannot, and never calls a tool it should not', async () => {
  let r = rig({ env: { WAYLAND_DISPLAY: 'wayland-0' } });
  assert.match((await F.focusSession({ pid: 5000 }, r.deps)).why, /Wayland/);
  assert.equal(r.calls.length, 0);
  r = rig();
  assert.match((await F.focusSession({ pid: 0 }, r.deps)).why, /did not record/);
  assert.match((await F.focusSession({ pid: 1 }, r.deps)).why, /did not record/);
  r = rig({ chain: [] });
  assert.match((await F.focusSession({ pid: 5000 }, r.deps)).why, /gone/);
  r = rig({ windows: '0x03800003  0 1111   host Firefox' });
  assert.match((await F.focusSession({ pid: 5000 }, r.deps)).why, /no window of this session/);
  assert.equal(r.calls.length, 1);                                                                // listed windows, raised nothing
  r = rig({ activate: false });
  assert.match((await F.focusSession({ pid: 5000 }, r.deps)).why, /did not raise/);
});

test('the menu: a session row is flat and goes to its terminal when clicked (the reason a jump cannot work is told by the click, not by a greyed row)', () => {
  const s = { key: 'claude-code:a', agentName: 'Claude Code', sessionId: 'a', name: 'api', cwd: '/x/api', pid: 5000, state: 'working', label: 'working', lastActivityAt: 1000, prompt: 'p' };
  const clicked = [];
  const rows = (o) => app.buildMenu([s, Object.assign({}, s, { key: 'x:b', pid: 0 }), Object.assign({}, s, { key: 'x:c', state: 'stopped' })], Object.assign({ now: 2000, onFocus: (x) => clicked.push(x.key) }, o)).filter((x) => x.key.startsWith('s:'));
  const on = rows();
  assert.equal(on.length, 3);
  assert.ok(on.every((r) => !r.children && r.enabled !== false), 'flat and clickable, so GNOME does not open a sub-menu under it');
  on.forEach((r) => r.onClick());
  assert.deepEqual(clicked, ['claude-code:a', 'x:b', 'x:c']);   // every row asks; focusSession answers with the reason
  assert.ok(rows({ onFocus: undefined }).every((r) => r.onClick === undefined));                       // nothing wired: nothing to click
});
