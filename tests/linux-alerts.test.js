'use strict';
//
// Desktop alerts and sounds for the Linux tray (linux/alerts.js, linux/sound.js). The rules are the Mac app's; the logic is tested with
// stand-ins for the notification service and the sound player, and one test sends a real Notify call over a private bus (Linux only).
//
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const { Alerter, clip } = require('../linux/alerts');
const sound = require('../linux/sound');

const NOW = 1_800_000_000_000;
const sess = (over) => Object.assign({ key: 'claude-code:a', agentName: 'Claude Code', name: 'api', state: 'working', prompt: 'fix login', notifyMessage: null, notifyAt: null }, over);
const harness = (cfg, extra) => {
  const sent = [], played = [];
  const a = new Alerter(Object.assign({ settings: () => cfg, play: (s) => { played.push(s); return true; }, now: () => NOW, notify: (n) => sent.push(n) }, extra));
  return { a, sent, played };
};
const ON = { notifyOnRequest: true, bannerOnEveryChange: false, popupOnEveryChange: false, sounds: true, soundNotify: 'Glass', soundNeedsYou: 'none', soundError: 'none', soundStuck: 'none', soundStopped: 'none', soundDone: 'none' };

test('the first look is a baseline: nothing fires for sessions that were already there', () => {
  const { a, sent, played } = harness(Object.assign({}, ON, { bannerOnEveryChange: true }));
  assert.deepEqual(a.observe([sess({ state: 'needsInput' }), sess({ key: 'x:b', state: 'done' })]), []);
  assert.equal(sent.length + played.length, 0);
});

test('banners: only when switched on, only for finished / needs you / error / stopped, one per change', () => {
  const off = harness(ON);
  off.a.observe([sess()]);
  assert.deepEqual(off.a.observe([sess({ state: 'needsInput' })]), []);                    // banners are off by default
  const { a, sent } = harness(Object.assign({}, ON, { bannerOnEveryChange: true }));
  a.observe([sess()]);
  a.observe([sess({ state: 'needsInput' })]);
  a.observe([sess({ state: 'needsInput' })]);                                              // same state again: nothing
  a.observe([sess({ state: 'working' })]);                                                 // back to work: no banner
  a.observe([sess({ state: 'done' })]);
  a.observe([sess({ state: 'stuck' })]);                                                   // stuck is not a banner state
  a.observe([sess({ state: 'warning' })]);
  a.observe([sess({ state: 'stopped' })]);
  assert.deepEqual(sent.map((n) => [n.kind, n.title, n.urgency]), [
    ['needsInput', 'Claude Code needs you', 2], ['done', 'Claude Code finished', 1], ['warning', 'Claude Code hit an error', 2], ['stopped', 'Claude Code stopped', 2]]);
  assert.equal(sent[0].body, 'api: fix login');
  assert.equal(new Alerter({ settings: () => ({ popupOnEveryChange: true }), notify: () => {}, now: () => NOW }).observe([sess()]).length, 0);
  const popup = harness({ popupOnEveryChange: true });                                       // the Mac's pop-up setting also means a notification here
  popup.a.observe([sess()]); popup.a.observe([sess({ state: 'done' })]);
  assert.equal(popup.sent.length, 1);
});

test('a new session that starts is not an alert; one that first appears needing you is', () => {
  const { a, sent } = harness({ bannerOnEveryChange: true });
  a.observe([]);
  a.observe([sess({ state: 'starting' })]);
  assert.equal(sent.length, 0);
  a.observe([sess({ state: 'starting' }), sess({ key: 'codex:z', agentName: 'Codex', state: 'needsInput' })]);
  assert.deepEqual(sent.map((n) => n.title), ['Codex needs you']);
});

test('notify messages: shown once, only when fresh, only when switched on, with the Notify sound', () => {
  const { a, sent, played } = harness(ON);
  a.observe([sess()]);
  const m = sess({ notifyMessage: 'tests passed', notifyAt: NOW - 1000 });
  a.observe([m]);
  a.observe([m]);                                                                         // the file sticks around: no repeat
  assert.deepEqual(sent.map((n) => [n.title, n.body, n.kind]), [['Claude Code · api', 'tests passed', 'notify']]);
  assert.deepEqual(played, ['Glass']);
  a.observe([sess({ notifyMessage: 'again', notifyAt: NOW - 500 })]);
  assert.equal(sent.length, 2);
  const quiet = harness(Object.assign({}, ON, { notifyOnRequest: false }));
  quiet.a.observe([sess()]);
  quiet.a.observe([m]);
  assert.equal(quiet.sent.length, 0);
});

test('a notify message from before the tray started is history, not an alert', () => {
  const { a, sent } = harness(ON);
  a.observe([sess({ notifyMessage: 'old news', notifyAt: NOW - 60 * 60 * 1000 })]);       // already in the file at the first look, an hour old
  a.observe([sess({ notifyMessage: 'old news', notifyAt: NOW - 60 * 60 * 1000 })]);
  assert.equal(sent.length, 0);
  const fresh = harness(ON);
  fresh.a.observe([sess({ notifyMessage: 'just sent', notifyAt: NOW - 2000 })]);           // sent moments before the tray looked
  assert.equal(fresh.sent.length, 1);
});

test('sounds: follow the per-event setting, play with banners off, and stop with the master switch', () => {
  const cfg = Object.assign({}, ON, { soundNeedsYou: 'Hero', soundDone: 'Ping' });
  const { a, sent, played } = harness(cfg);
  a.observe([sess()]);
  a.observe([sess({ state: 'needsInput' })]);
  a.observe([sess({ state: 'done' })]);
  assert.deepEqual(played, ['Hero', 'Ping']);
  assert.equal(sent.length, 0);                                                           // sounds play even though banners are off
  const mute = harness(Object.assign({}, cfg, { sounds: false, bannerOnEveryChange: true }));
  mute.a.observe([sess()]); mute.a.observe([sess({ state: 'needsInput' })]);
  assert.deepEqual(mute.played, []);
  assert.equal(mute.sent.length, 1);
});

test('state that goes away is forgotten, and text is clipped', () => {
  const { a } = harness(ON);
  a.observe([sess({ notifyMessage: 'x', notifyAt: NOW - 1 })]);
  a.ids.set('claude-code:a', 7);
  a.observe([]);
  assert.equal(a.lastNotifyAt.size, 0);
  assert.equal(a.ids.size, 0);
  assert.equal(clip('x'.repeat(500), 300).length, 300);
  assert.equal(clip('héllo', 10), 'héllo');
  const { a: b, sent } = harness({ bannerOnEveryChange: true });
  b.observe([sess()]); b.observe([sess({ state: 'done', prompt: 'p'.repeat(1000) })]);
  assert.equal(Array.from(sent[0].body).length, 300);
});

// ---------- sound commands ----------

const fsOf = (...files) => ({ exists: (p) => files.includes(p) });

test('soundCommand: none, theme sounds, the player order, and files in the sounds folder', () => {
  const dir = '/home/u/.votive/sounds';
  assert.equal(sound.soundCommand('none', { soundsDir: dir }), null);
  assert.equal(sound.soundCommand('', { soundsDir: dir }), null);
  assert.deepEqual(sound.soundCommand('Glass', { fsx: fsOf('/usr/bin/canberra-gtk-play') }), { bin: '/usr/bin/canberra-gtk-play', args: ['-i', 'complete'] });
  assert.deepEqual(sound.soundCommand('Glass', { fsx: fsOf('/usr/bin/paplay', '/usr/share/sounds/freedesktop/stereo/complete.oga') }), { bin: '/usr/bin/paplay', args: ['/usr/share/sounds/freedesktop/stereo/complete.oga'] });
  assert.equal(sound.soundCommand('Glass', { fsx: fsOf('/usr/bin/paplay') }), null);       // a player but no sound file
  assert.equal(sound.soundCommand('Glass', { fsx: fsOf() }), null);                         // nothing installed: silence, not an error
  assert.deepEqual(sound.soundCommand('ding.wav', { soundsDir: dir, fsx: fsOf('/usr/bin/pw-play', dir + '/ding.wav') }), { bin: '/usr/bin/pw-play', args: [dir + '/ding.wav'] });
  assert.equal(sound.soundCommand('ding.mp3', { soundsDir: dir, fsx: fsOf('/usr/bin/paplay', dir + '/ding.mp3') }), null);   // paplay cannot play mp3
  for (const evil of ['../../etc/passwd.wav', '/etc/x.wav', 'a/b.wav', '.hidden.wav', 'a\\b.wav']) {
    assert.equal(sound.soundCommand(evil, { soundsDir: dir, fsx: { exists: () => true } }), null, evil);                  // a name, never a path
  }
  assert.ok(Object.keys(sound.THEME).length >= 14, 'every macOS system sound has a theme name');
});

test('the player: starts one process, not twice within the gap, and survives a missing program', () => {
  const calls = [];
  let t = 1000;
  const fake = (bin, args) => { calls.push([bin, args]); return { on() {}, unref() {} }; };
  const play = sound.makePlayer({ soundsDir: '/s', spawnFn: fake, now: () => t, fsx: fsOf('/usr/bin/canberra-gtk-play') });
  assert.equal(play('Glass'), true);
  assert.equal(play('Glass'), false);                                                       // too soon
  t += 500;
  assert.equal(play('Ping'), true);
  assert.equal(play('none'), false);
  assert.deepEqual(calls.map((c) => c[1]), [['-i', 'complete'], ['-i', 'message-new-instant']]);
  const boom = sound.makePlayer({ soundsDir: '/s', spawnFn: () => { throw new Error('nope'); }, now: () => 9e9, fsx: fsOf('/usr/bin/canberra-gtk-play') });
  assert.equal(boom('Glass'), false);
});

// ---------- the real Notify call ----------

const HAVE_DAEMON = process.platform === 'linux' && !spawnSync('dbus-daemon', ['--version']).error;
const skip = HAVE_DAEMON ? false : 'needs dbus-daemon (Linux; run ./Scripts/test-linux.sh)';
let daemon, address;
before(async () => {
  if (!HAVE_DAEMON) return;
  daemon = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  address = await new Promise((resolve) => { let b = ''; daemon.stdout.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) resolve(b.slice(0, i).trim()); }); });
});
after(() => { if (daemon) daemon.kill(); });

test('Notify goes to the notification service with the right arguments, and the next one replaces the first', { skip }, async () => {
  const { Connection } = require('../linux/dbus/bus');
  const { NOTIFY } = require('../linux/alerts');
  const server = await new Connection(address).connect();
  const calls = [];
  let nextId = 41;
  server.exportObject(NOTIFY.path, { [NOTIFY.interface]: { methods: { Notify: { in: 'susssasa{sv}i', out: 'u', fn: (...args) => { calls.push(args); return [nextId++]; } } } } });
  assert.equal(await server.requestName(NOTIFY.destination), true);
  const client = await new Connection(address).connect();
  const a = new Alerter({ conn: client, settings: () => ({ bannerOnEveryChange: true }), now: () => NOW });
  a.observe([sess()]);
  a.observe([sess({ state: 'needsInput', prompt: 'a < b & c' })]);
  for (let i = 0; i < 100 && !calls.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  const [app, replaces, icon, summary, body, actions, hints, timeout] = calls[0];
  assert.equal(app, 'Votive Dots'); assert.equal(replaces, 0); assert.equal(icon, '');
  assert.equal(summary, 'Claude Code needs you');
  assert.equal(body, 'api: fix login'.replace('fix login', 'a &lt; b &amp; c'));          // markup characters are escaped
  assert.deepEqual(actions, []);
  assert.equal(hints.get('urgency').value, 2);
  assert.equal(timeout, 0);                                                                 // a critical one stays until dismissed
  for (let i = 0; i < 100 && a.ids.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.ids.get('claude-code:a'), 41);
  a.observe([sess({ state: 'done' })]);
  for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls[1][1], 41);                                                            // replaces the earlier notification
  client.close(); server.close();
  const lonely = await new Connection(address).connect();                                   // no service any more: must not throw
  new Alerter({ conn: lonely, settings: () => ({ bannerOnEveryChange: true }), now: () => NOW }).observe([sess()]);
  lonely.close();
});
