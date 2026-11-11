'use strict';
//
// The data behind the Linux main window: pages, insights (critical first, at most six), settings with real values, habits and history from synthetic days.
//
const { test } = require('node:test');
const assert = require('node:assert');
const ms = require('../linux/mainstate');

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const S = (o) => Object.assign({ key: 'claude-code:a', name: 'api', agentName: 'Claude Code', state: 'working', label: 'working', prompt: '', cwd: '/w/api', lastActivityAt: NOW - 5000 }, o);

test('insights: critical first, one per kind, at most six, "all clear" only when nothing is urgent', () => {
  const out = ms.insightsFor({
    sessions: [S({ state: 'needsInput', name: 'web' }), S({ state: 'stuck', name: 'infra' }), S({ state: 'stopped', name: 'db' })],
    usageRows: [{ name: 'Claude Code · Weekly', pct: 93 }, { name: 'Claude Code · Session', pct: 75 }],
    forecast: { has: true, projected: 104, target: 80 }, heat: { hot: true, c: 97 },
  });
  assert.deepEqual(out.map((i) => i.id), ['needs', 'bad', 'limit90', 'heat', 'stuck', 'limit70']);   // capped at six; the forecast one is cut
  assert.ok(out.slice(0, 4).every((i) => i.tone === 'critical'));
  const clear = ms.insightsFor({ sessions: [], usageRows: [], forecast: null, heat: null });
  assert.deepEqual(clear.map((i) => i.id), ['clear']);
  assert.equal(ms.insightsFor({ sessions: [S()], usageRows: [], forecast: { has: true, projected: 60, target: 80 } })[0].id, 'fc-ok');
});

test('settings: every row has its real value, a missing one is the default, and choices carry the sound list', () => {
  const pages = ms.settingsPages({ colorblindShapes: true, soundDone: 'Hero' });
  assert.deepEqual(pages.map((p) => p.id), ['general', 'alerts', 'sounds']);
  const row = (name) => pages.flatMap((p) => p.rows).find((r) => r.name === name);
  assert.equal(row('colorblindShapes').value, true);
  assert.equal(row('usagePulse').value, true);
  assert.equal(row('cpuHeatWarningAt').value, 95);
  assert.equal(row('soundDone').value, 'Hero');
  assert.equal(row('soundNeedsYou').value, 'none');
  assert.ok(row('soundDone').choices.includes('Glass'));
  assert.equal(row('stuckThresholdMinutes').max, 240);
});

test('habits and history: hours and days come from the data, empty data gives empty charts not errors', () => {
  const h0 = new Date(2026, 10, 9, 10).getTime();     // a Monday, 10:00 local
  const use = { cells: new Map([[h0, 4], [h0 + 3600e3, 2], [new Date(2026, 10, 7, 15).getTime(), 6]]) };   // plus a Saturday 15:00
  const h = ms.habitsData(use, new Date(2026, 10, 11, 12).getTime());
  assert.equal(h.weekday[10], 4);
  assert.equal(h.weekday[11], 2);
  assert.equal(h.weekend[15], 6);
  assert.equal(h.daily.length, 14);
  assert.equal(h.daily.at(-3).points, 6);              // Mon 9 Nov: 4 + 2
  const empty = ms.habitsData(null, NOW);
  assert.equal(empty.weekday.length, 24);
  assert.ok(empty.weekday.every((v) => v === 0));
  const w = ms.weeklyByDay([{ t: NOW - 3600e3, w: 41 }, { t: NOW - 7200e3, w: 38 }, { t: NOW - 2 * 86400e3, w: 20 }], NOW);
  assert.equal(w.at(-1).pct, 41);
  assert.equal(w.at(-3).pct, 20);
  assert.equal(w.at(-2).pct, null);
});

test('the whole state is plain JSON, carries every page, and never throws on empty input', () => {
  const st = ms.buildMainState({ now: NOW, sessions: [S(), S({ key: 'codex:b', name: 'web', agentName: 'Codex', state: 'needsInput', label: 'needs you' })], icons: { working: 'AAAA' },
    usage: { agents: [{ agentName: 'Claude Code', windows: [{ label: 'Weekly', usedPercentage: 41.6, resetsAtMs: NOW + 86400e3 }] }] },
    priority: { pins: { 'codex:b': 1 }, folders: {}, onlyPriority: true }, settings: { sounds: false }, keepAwake: true, summary: '1 needs you, 1 working' });
  const round = JSON.parse(JSON.stringify(st));
  assert.deepEqual(Object.keys(round).sort(), ['agents', 'forecast', 'habits', 'history', 'icons', 'insights', 'keepAwake', 'order', 'sessions', 'settings', 'summary', 'title', 'usage', 'version']);
  assert.equal(round.usage[0].pct, 42);
  assert.equal(round.sessions.find((s) => s.key === 'codex:b').high, true);
  assert.equal(round.settings.flatMap((p) => p.rows).find((r) => r.name === 'alertsOnlyPriority').value, true);
  assert.equal(round.settings.flatMap((p) => p.rows).find((r) => r.name === 'sounds').value, false);
  assert.equal(round.forecast.has, false);
  assert.doesNotThrow(() => ms.buildMainState());
});
