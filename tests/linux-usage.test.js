'use strict';
//
// Plan usage in the Linux tray (linux/usage.js and its use in menu, tooltip and icon): the Mac app's rules for which windows count,
// the 70% threshold, the text bar, and the red badge on the icon.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../linux/usage');
const I = require('../linux/icon');
const app = require('../linux/votive-tray');

const NOW = 1_800_000_000_000;
const win = (label, pct, inMs) => ({ label, usedPercentage: pct, resetsAt: Math.round((NOW + inMs) / 1000) });
const file = (agent, windows) => JSON.stringify({ agent, updatedAt: NOW, windows });

function dirWith(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-usage-'));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
  return d;
}

test('readUsage: live windows only, clamped, Claude Code first, junk and wrapped.json skipped', () => {
  const d = dirWith({
    'codex.json': file('codex', [win('Weekly', 40, 86400e3)]),
    'claude-code.json': file('claude-code', [win('Session', 20, 3600e3), win('Weekly', 150, 86400e3), win('Old', 99, -1000), { label: 'x', usedPercentage: 'many', resetsAt: 1 }, null]),
    'wrapped.json': file('wrapped', [win('Nope', 50, 3600e3)]),
    'broken.json': '{"agent":',
    'empty.json': file('empty', [win('Gone', 10, -5000)]),
    'notes.txt': 'hi',
  });
  try {
    const u = U.readUsage(d, NOW);
    assert.deepEqual(u.agents.map((a) => a.agent), ['claude-code', 'codex']);
    assert.deepEqual(u.agents[0].windows.map((w) => [w.label, w.usedPercentage]), [['Session', 20], ['Weekly', 100]]);   // 150 is clamped, the reset one is gone
    assert.equal(U.readUsage(path.join(d, 'nope'), NOW), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a reset time in milliseconds works as well as one in seconds, and a missing label becomes "Limit"', () => {
  const a = U.parseAgent({ agent: 'codex', windows: [{ usedPercentage: 10, resetsAt: NOW + 5000 }, { label: 'L'.repeat(50), usedPercentage: 1, resetsAt: Math.round((NOW + 5000) / 1000) }] }, 'x', NOW);
  assert.deepEqual(a.windows.map((w) => w.label.length), [5, 20]);
  assert.equal(a.windows[0].label, 'Limit');
  assert.equal(U.parseAgent({ windows: [{ usedPercentage: 1, resetsAt: Math.round((NOW + 1000) / 1000) }] }, 'fallback-name', NOW).agent, 'fallback-name');
  assert.equal(U.parseAgent({ windows: [] }, 'x', NOW), null);
  assert.equal(U.parseAgent('nope', 'x', NOW), null);
});

test('over the threshold means strictly above 70', () => {
  const mk = (pct) => ({ agents: [{ agent: 'claude-code', agentName: 'Claude Code', windows: [{ label: 'Weekly', usedPercentage: pct, resetsAtMs: NOW + 1e6 }] }] });
  assert.equal(U.overThreshold(mk(70)), false);
  assert.equal(U.overThreshold(mk(70.5)), true);
  assert.equal(U.overThreshold(mk(0)), false);
  assert.equal(U.overThreshold(null), false);
});

test('text: the bar, the reset time, and lines that name the agent only when there are several', () => {
  assert.deepEqual([0, 12, 50, 100].map(U.bar), ['▱▱▱▱▱▱▱▱', '▰▱▱▱▱▱▱▱', '▰▰▰▰▱▱▱▱', '▰▰▰▰▰▰▰▰']);
  const same = U.resetText(NOW + 3600e3, NOW, 'en-GB');
  assert.match(same, /^\d{1,2}:\d{2}/);
  assert.ok(!/^[A-Z][a-z]{2} /.test(same), 'a reset today has no weekday');
  assert.match(U.resetText(NOW + 3 * 86400e3, NOW, 'en-GB'), /^[A-Z][a-z]{2} \d{1,2}:\d{2}/);
  const one = U.readUsage(dirWith({ 'claude-code.json': file('claude-code', [win('Weekly', 74, 86400e3)]) }), NOW);
  const l1 = U.lines(one, { nowMs: NOW, locale: 'en-GB' });
  assert.match(l1[0].text, /^⚠ Weekly  ▰▰▰▰▰▰▱▱  74%  ·  resets /);
  assert.equal(l1[0].short, 'Weekly 74%');
  assert.equal(l1[0].hot, true);
  const two = U.readUsage(dirWith({ 'claude-code.json': file('claude-code', [win('Session', 20, 3600e3)]), 'codex.json': file('codex', [win('Weekly', 30, 3600e3)]) }), NOW);
  assert.deepEqual(U.lines(two, { nowMs: NOW }).map((x) => x.short), ['Claude Code Session 20%', 'Codex Weekly 30%']);
  assert.deepEqual(U.lines(null), []);
});

test('the menu gets a Plan usage section, and the tooltip lists only the limits that are over', () => {
  const usage = U.readUsage(dirWith({ 'claude-code.json': file('claude-code', [win('Session', 20, 3600e3), win('Weekly', 74, 86400e3)]) }), NOW);
  const rows = app.buildMenu([], { now: NOW, usage });
  const labels = rows.map((r) => r.label || '--');
  assert.ok(labels.includes('Plan usage'));
  assert.equal(labels.filter((l) => /%/.test(l)).length, 2);
  assert.ok(labels.at(-1) === 'Quit Votive Dots' && labels.at(-2) === '--');
  assert.deepEqual(app.tooltipLines([], NOW, usage), ['⚠ Weekly 74%']);
  assert.equal(app.buildMenu([], { now: NOW }).some((r) => r.label === 'Plan usage'), false);   // no usage, no section
  const keys = rows.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('the icon badge: a red mark in the corner that pulses, absent when not asked for', () => {
  const px = (b, n, x, y) => Array.from(b.subarray((y * n + x) * 4, (y * n + x) * 4 + 4));
  const n = 32;
  const plain = I.render(['done'], { size: n });
  const flagged = I.render(['done'], { size: n, badge: true, phase: 0 });
  const dim = I.render(['done'], { size: n, badge: true, phase: 1 });
  assert.equal(px(plain, n, 26, 5)[0], 0);                                  // nothing in the corner
  assert.deepEqual(px(flagged, n, 26, 5), [255, 255, 69, 58]);              // opaque red
  assert.ok(px(dim, n, 26, 5)[0] > 50 && px(dim, n, 26, 5)[0] < 130);
  assert.deepEqual(px(flagged, n, 16, 18), px(plain, n, 16, 18));           // the dot itself is untouched
  assert.ok(I.render([], { size: n, badge: true }).some((b, i) => i % 4 === 0 && b > 0));   // it shows even with no sessions
});

test('a limit over the threshold makes the tray pulse even when every session is calm, and it stops when the limit drops', () => {
  const { Tray } = require('../linux/tray');
  const tray = new Tray({});
  tray.update({ states: ['done'], tooltipLines: [], badge: true });
  assert.ok(tray._timer, 'the pulse timer is running');
  tray.update({ states: ['done'], tooltipLines: [], badge: false });
  assert.equal(tray._timer, null);
  assert.equal(tray.phase, 0);
});
