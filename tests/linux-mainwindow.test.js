'use strict';
//
// The Linux main window's host (linux/mainwindow.js): what the helper may send back, and that it starts the right script. The drawing is checked by rendering the real
// helper under a virtual display (Scripts/test-linux-ui.sh).
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const M = require('../linux/mainwindow');

const fakeChild = () => {
  const c = new EventEmitter();
  c.written = [];
  c.stdin = new EventEmitter(); c.stdin.destroyed = false; c.stdin.write = (t) => { c.written.push(JSON.parse(t)); return true; };
  c.stdout = new EventEmitter();
  c.kill = () => setImmediate(() => c.emit('exit'));
  return c;
};

test('parseMainAction: focus, pin, move, set, keepawake, report and closed pass; everything else is dropped', () => {
  assert.deepEqual(M.parseMainAction('{"t":"focus","key":"a:1"}'), { t: 'focus', key: 'a:1' });
  assert.deepEqual(M.parseMainAction('{"t":"move","key":"a:1","delta":-2}'), { t: 'move', key: 'a:1', delta: -2 });
  assert.deepEqual(M.parseMainAction('{"t":"keepawake","junk":1}'), { t: 'keepawake' });
  for (const bad of ['{"t":"move","key":"a","delta":0}', '{"t":"move","key":"a","delta":21}', '{"t":"move","key":"a","delta":1.5}', '{"t":"move","delta":1}', '{"t":"run","cmd":"x"}', 'nope', '[]', '{"t":"focus"}']) {
    assert.equal(M.parseMainAction(bad), null, bad);
  }
  assert.equal(M.parseMainAction('{"t":"report","x":"' + 'y'.repeat(5000) + '"}'), null, 'a line that long is refused');
});

test('parseMainAction: a setting must be one the window shows, and its value must fit', () => {
  const ok = (o) => M.parseMainAction(JSON.stringify(Object.assign({ t: 'set' }, o)));
  assert.deepEqual(ok({ name: 'colorblindShapes', value: true }), { t: 'set', name: 'colorblindShapes', value: true });
  assert.deepEqual(ok({ name: 'cpuHeatWarningAt', value: 100 }), { t: 'set', name: 'cpuHeatWarningAt', value: 100 });
  assert.deepEqual(ok({ name: 'soundDone', value: 'Hero' }), { t: 'set', name: 'soundDone', value: 'Hero' });
  assert.deepEqual(ok({ name: 'portToolsOn', value: true }), { t: 'set', name: 'portToolsOn', value: true });
  for (const bad of [{ name: 'colorblindShapes', value: 'yes' }, { name: 'cpuHeatWarningAt', value: 69 }, { name: 'cpuHeatWarningAt', value: 111 }, { name: 'cpuHeatWarningAt', value: 95.5 },
    { name: 'soundDone', value: '/etc/passwd' }, { name: 'soundDone', value: 5 }, { name: 'stuckThresholdMinutes', value: -1 }, { name: 'notASetting', value: true }, { name: '__proto__', value: true }, { value: true }]) {
    assert.equal(ok(bad), null, JSON.stringify(bad));
  }
});

test('the host starts the main window script, sends the state, then a page, and passes only checked actions on', async () => {
  const children = [], got = [];
  const h = new M.MainWindowHost({
    env: { DISPLAY: ':0', HOME: '/home/u' }, ex: (p) => p === '/usr/bin/python3', execFn: (b, a, o, cb) => cb(null),
    spawnFn: (bin, args) => { const c = fakeChild(); c.args = args; children.push(c); return c; }, onAction: (a) => got.push(a),
  });
  const r = await h.openPage({ title: 'Votive Dots', sessions: [] }, 'forecast');
  assert.equal(r.ok, true);
  assert.equal(children[0].args[0], M.SCRIPT);
  assert.match(M.SCRIPT, /votive-main\.py$/);
  assert.deepEqual(children[0].written.map((m) => m.t), ['state', 'page']);
  assert.deepEqual(children[0].written[1], { t: 'page', id: 'forecast' });
  children[0].stdout.emit('data', Buffer.from('{"t":"set","name":"sounds","value":false}\n{"t":"set","name":"evil","value":1}\n{"t":"move","key":"a","delta":1}\n{"t":"closed"}\n'));
  assert.deepEqual(got, [{ t: 'set', name: 'sounds', value: false }, { t: 'move', key: 'a', delta: 1 }]);
  const r2 = await h.openPage({ title: 'x' }, 'not-a-page');
  assert.equal(r2.ok, true);
  assert.equal(children.length, 1, 'a second open reuses the window');
  assert.equal(children[0].written.filter((m) => m.t === 'page').length, 1, 'an unknown page is not sent');
});

test('the helper draws only what it is sent: no network, no subprocess, no file writes, no markup parsing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'linux', 'ui', 'votive-main.py'), 'utf8').replace(/#.*$/gm, '');
  for (const bad of [/\bsocket\b/, /\burllib\b/, /\bhttp\b/, /\bsubprocess\b/, /os\.system/, /os\.popen/, /\bopen\(/, /set_markup/, /\bcairo\b/, /\bexec\(/, /\beval\(/]) {
    assert.doesNotMatch(src, bad, String(bad));
  }
});
