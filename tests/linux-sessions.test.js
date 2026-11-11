'use strict';
//
// The Linux session model (linux/sessions.js): the same states and rules as the Mac app's StatusResolver.resolveEvent and the
// event-only part of AgentScanner. The process is injected, so these run on any machine; one test reads the real /proc.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const S = require('../linux/sessions');

const MIN = 60000;
const NOW = 1_800_000_000_000;
const ev = (over) => Object.assign({ agent: 'claude-code', sessionId: 's1', lastEvent: 'working', lastEventAt: NOW - 1000, cwd: '/home/u/proj', pid: 100, prompt: 'fix it', notifyMessage: null, notifyAt: null }, over);
const alive = (pids, starts = {}) => ({ alive: (p) => pids.includes(p), startMs: (p) => starts[p] ?? null });
const tracker = (events, probe, extra) => new S.SessionTracker(Object.assign({ eventsDir: '/x', read: () => events, probe }, extra));

test('resolveEvent: the last event decides, work with no news is stuck, a dead process is stopped', () => {
  const r = (e, o) => S.resolveEvent(ev(e), Object.assign({ alive: true, now: NOW, firstSeenDeadAt: null }, o));
  assert.equal(r({ lastEvent: 'waiting' }), 'needsInput');
  assert.equal(r({ lastEvent: 'error' }), 'warning');
  assert.equal(r({ lastEvent: 'starting' }), 'starting');
  assert.equal(r({ lastEvent: 'done' }), 'done');
  assert.equal(r({ lastEvent: 'working' }), 'working');
  assert.equal(r({ lastEvent: 'working', lastEventAt: NOW - 9 * MIN }), 'stuck');
  assert.equal(r({ lastEvent: 'working', lastEventAt: NOW - 9 * MIN }, { stuckMs: 0 }), 'working');           // 0 turns stuck detection off
  assert.equal(r({ lastEvent: 'working', lastEventAt: NOW - 9 * MIN }, { activityFloor: NOW - MIN }), 'working');   // a machine that slept was not working
  assert.equal(r({ lastEvent: 'waiting', lastEventAt: NOW - 99 * MIN }), 'needsInput');                       // waiting never ages into stuck
  assert.equal(r({ lastEvent: 'surprise' }), null);
  assert.equal(r({}, { alive: false }), 'stopped');
  assert.equal(r({}, { alive: false, firstSeenDeadAt: NOW - 59_000 }), 'stopped');
  assert.equal(r({}, { alive: false, firstSeenDeadAt: NOW - 61_000 }), null);                                  // red for a minute, then gone
});

test('scan: states, names, order and the most urgent overall state', () => {
  const events = [
    ev({ sessionId: 'a', pid: 1, lastEvent: 'working', lastEventAt: NOW - 5000 }),
    ev({ sessionId: 'b', pid: 2, lastEvent: 'waiting', agent: 'codex', cwd: '/srv/api/', lastEventAt: NOW - 4000 }),
    ev({ sessionId: 'c', pid: 3, lastEvent: 'done', cwd: '' }),
  ];
  const t = tracker(events, alive([1, 2, 3]));
  const got = t.scan(NOW);
  assert.deepEqual(got.map((s) => [s.sessionId, s.state, s.name, s.agentName]), [
    ['a', 'working', 'proj', 'Claude Code'], ['b', 'needsInput', 'api', 'Codex'], ['c', 'done', 'session', 'Claude Code']]);
  assert.equal(S.overallState(got), 'needsInput');
  assert.equal(S.overallState([]), null);
  assert.equal(S.overallState(got.filter((s) => s.state !== 'needsInput')), 'working');
});

test('scan: a session that dies while we watch gets a minute of red, then goes; one that was already dead is never shown', () => {
  const e = ev({ pid: 7, lastEventAt: NOW - 10_000 });
  const probe = alive([7]);
  const t = tracker([e], probe);
  assert.equal(t.scan(NOW)[0].state, 'working');
  probe.alive = () => false;                                  // it dies now
  assert.equal(t.scan(NOW + 1000)[0].state, 'stopped');
  assert.equal(t.scan(NOW + 30_000)[0].state, 'stopped');
  assert.deepEqual(t.scan(NOW + 62_000), []);
  const old = tracker([ev({ pid: 8, lastEventAt: NOW - 10 * MIN })], alive([]));
  assert.deepEqual(old.scan(NOW), []);                       // history, not an alarm
  const recent = tracker([ev({ pid: 8, lastEventAt: NOW - 20_000 })], alive([]));
  assert.equal(recent.scan(NOW)[0].state, 'stopped');        // it died moments ago: show it
});

test('scan: the pid-reuse guard, and the 30 minute limit for a session with no pid', () => {
  // the process now at that pid started well after the last event: it is not the agent that wrote the file
  assert.equal(tracker([ev({ pid: 9, lastEventAt: NOW - 20_000 })], alive([9], { 9: NOW })).scan(NOW)[0].state, 'stopped');
  assert.equal(tracker([ev({ pid: 9 })], alive([9], { 9: NOW - 3_600_000 })).scan(NOW)[0].state, 'working');   // started long before: ours
  assert.equal(tracker([ev({ pid: 9 })], alive([9], { 9: NOW - 500 })).scan(NOW)[0].state, 'working');         // within the 5 s slack
  assert.equal(tracker([ev({ pid: 9 })], alive([9])).scan(NOW)[0].state, 'working');                            // start time unknown: trust the pid
  assert.equal(tracker([ev({ pid: 0, lastEventAt: NOW - 29 * MIN, lastEvent: 'done' })], alive([])).scan(NOW).length, 1);
  assert.equal(tracker([ev({ pid: 0, lastEventAt: NOW - 31 * MIN, lastEvent: 'done' })], alive([])).scan(NOW).length, 0);
});

test('scan: wake from suspend, the stuck threshold, and forgetting sessions whose file is gone', () => {
  const old = ev({ pid: 1, lastEventAt: NOW - 20 * MIN });
  const t = tracker([old], alive([1]));
  assert.equal(t.scan(NOW)[0].state, 'stuck');
  t.noteWake(NOW);
  assert.equal(t.scan(NOW + MIN)[0].state, 'working');
  assert.equal(tracker([ev({ pid: 1, lastEventAt: NOW - 3 * MIN })], alive([1]), { stuckMinutes: 2 }).scan(NOW)[0].state, 'stuck');
  let events = [ev({ pid: 1 })];
  const u = tracker(null, alive([1]));
  u.read = () => events;
  u.scan(NOW);
  assert.equal(u.firstSeenAt.size, 1);
  events = [];
  u.scan(NOW + 1000);
  assert.equal(u.firstSeenAt.size, 0);
});

test('parseEvent: accepts our files and refuses foreign or hostile ones', () => {
  const good = S.parseEvent(JSON.stringify({ agent: 'codex', sessionId: 'x', lastEvent: 'done', lastEventAt: NOW, pid: 55, cwd: '/a/b', prompt: 'hi\u202e there', notifyMessage: 'ping', notifyAt: NOW }));
  assert.equal(good.agent, 'codex'); assert.equal(good.pid, 55); assert.equal(good.prompt, 'hi there'); assert.equal(good.notifyMessage, 'ping');
  assert.equal(S.parseEvent(JSON.stringify({ sessionId: 'x', lastEvent: 'done', lastEventAt: NOW })).agent, 'claude-code');   // a missing agent is Claude Code
  for (const bad of ['', 'not json', '[]', '"x"', 'null', '{}', JSON.stringify({ sessionId: 'x', lastEvent: 'done' }),
    JSON.stringify({ sessionId: 'x', lastEvent: 'done', lastEventAt: -1 }), JSON.stringify({ sessionId: 'x', lastEvent: 'done', lastEventAt: 1e15 }),
    JSON.stringify({ sessionId: 'x', lastEvent: 'done', lastEventAt: 'now' }), JSON.stringify({ sessionId: 5, lastEvent: 'done', lastEventAt: NOW })]) {
    assert.equal(S.parseEvent(bad), null, bad);
  }
  assert.equal(S.parseEvent(JSON.stringify({ sessionId: 'x', lastEvent: 'done', lastEventAt: NOW, pid: 1 })).pid, 0);        // pid 1 is never a host
  assert.equal(S.parseEvent(JSON.stringify({ sessionId: 'x', lastEvent: 'done', lastEventAt: NOW, prompt: 'p'.repeat(1000) })).prompt.length, 160);
});

test('readEvents: a missing folder, junk, oversize and half-written files are skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-ev-'));
  try {
    assert.deepEqual(S.readEvents(path.join(dir, 'nope')), []);
    fs.writeFileSync(path.join(dir, 'a--1.json'), JSON.stringify({ agent: 'a', sessionId: '1', lastEvent: 'done', lastEventAt: NOW }));
    fs.writeFileSync(path.join(dir, 'half.json'), '{"agent":"a","sessi');
    fs.writeFileSync(path.join(dir, 'big.json'), JSON.stringify({ sessionId: '2', lastEvent: 'done', lastEventAt: NOW, prompt: 'x'.repeat(70 * 1024) }));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(dir, '.hidden.json'), JSON.stringify({ sessionId: '3', lastEvent: 'done', lastEventAt: NOW }));
    fs.mkdirSync(path.join(dir, 'dir.json'));
    assert.deepEqual(S.readEvents(dir).map((e) => e.sessionId), ['1']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ago: short forms', () => {
  assert.deepEqual([0, 9_000, 30_000, 90_000, 3 * 3600_000, 2 * 86400_000].map(S.ago), ['just now', 'just now', '30 s', '2 min', '3 h', '2 d']);
});

test('the real /proc: a live child is alive, its start time is near now, a dead pid is not', { skip: process.platform !== 'linux' && 'needs /proc (Linux)' }, async () => {
  const child = spawn('sleep', ['30']);
  try {
    assert.ok(S.pidAlive(child.pid));
    const started = S.processStartMs(child.pid);
    assert.ok(Math.abs(Date.now() - started) < 10_000, 'start time ' + started + ' vs now ' + Date.now());
    assert.equal(S.hostAlive({ pid: child.pid, lastEventAt: Date.now() }, { alive: S.pidAlive, startMs: S.processStartMs }), true);
    assert.equal(S.hostAlive({ pid: child.pid, lastEventAt: Date.now() - 3_600_000 }, { alive: S.pidAlive, startMs: S.processStartMs }), false);   // started after that event: pid reuse
  } finally { child.kill(); }
  await new Promise((r) => child.on('exit', r));
  assert.equal(S.pidAlive(child.pid), false);
  assert.equal(S.processStartMs(child.pid), null);
});
