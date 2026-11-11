'use strict';
//
// What the Votive Dots main window shows on Linux, as plain data: the counterpart of the Mac window's pages (Overview, Forecast, Habits, History,
// Dot order, and the settings pages) and of its insights card. Pure: the same input always gives the same state, so it is tested without a screen.
// The GTK helper (linux/ui/votive-main.py) only draws this; it computes nothing and reads nothing.
//
const usageMod = require('./usage');
const priorityMod = require('./priority');
const palettes = require('./palettes');

const DAY = 24 * 3600e3;
const MAX_INSIGHTS = 6;
const SOUND_CHOICES = ['none', 'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'];

// The settings pages. Names are the shared setting names (Scripts/overlay-settings.js), so a change here shows up on the Mac side of the shared
// vocabulary and agents can read it. `local` ones live in this tray's own files (the tray decides how to write them).
const SETTING_PAGES = [
  { id: 'general', title: 'General', rows: [
    { name: 'colorblindShapes', label: 'Colorblind shapes', help: 'Give every state its own shape as well as its own colour.', type: 'bool' },
    { name: 'usagePulse', label: 'Flag the icon when a plan limit is over 70%', help: 'A red mark on the icon while any plan limit is over 70%.', type: 'bool' },
    { name: 'dotPalette', label: 'Dot colours', help: 'Change the colour of each state. The state is always written next to a dot, and Colorblind shapes still gives each its own shape.', type: 'choice', choices: palettes.NAMES, local: true },
    { name: 'cpuHeatWarning', label: 'Warn when the CPU is hot', help: 'Reads the CPU temperature every few seconds, only while this is on. Nothing leaves this computer.', type: 'bool' },
    { name: 'cpuHeatWarningAt', label: 'CPU warning line (°C)', help: 'The warning stays on until 3 degrees below this.', type: 'int', min: 70, max: 110 },
    { name: 'portToolsOn', label: 'Ports list (developer tool)', help: 'Adds a Ports menu: which local ports are in use and by which program. Read-only unless you confirm a stop.', type: 'bool', local: true },
  ] },
  { id: 'alerts', title: 'Alerts', rows: [
    { name: 'notifyOnRequest', label: 'Notify me when a session was asked to', help: 'A notification when an agent calls the notify tool.', type: 'bool' },
    { name: 'bannerOnEveryChange', label: 'Notify me on every change', help: 'Finished, needs you, error, stopped: a notification for each.', type: 'bool' },
    { name: 'stuckThresholdMinutes', label: 'A working session counts as stuck after (minutes)', help: '0 turns stuck detection off.', type: 'int', min: 0, max: 240 },
    { name: 'alertsOnlyPriority', label: 'Only alert for high-priority sessions', help: 'Sessions you have not starred stay quiet. A message an agent was asked to send still gets through.', type: 'bool', local: true },
  ] },
  { id: 'sounds', title: 'Sounds', rows: [
    { name: 'sounds', label: 'Sounds', help: 'Play a sound with an alert.', type: 'bool' },
    { name: 'soundNotify', label: 'A requested message', type: 'choice', choices: SOUND_CHOICES },
    { name: 'soundNeedsYou', label: 'A session needs you', type: 'choice', choices: SOUND_CHOICES },
    { name: 'soundError', label: 'A session hit an error', type: 'choice', choices: SOUND_CHOICES },
    { name: 'soundStuck', label: 'A session is stuck', type: 'choice', choices: SOUND_CHOICES },
    { name: 'soundStopped', label: 'A session stopped', type: 'choice', choices: SOUND_CHOICES },
    { name: 'soundDone', label: 'A session finished', type: 'choice', choices: SOUND_CHOICES },
  ] },
];
const DEFAULTS = { colorblindShapes: false, usagePulse: true, cpuHeatWarning: false, cpuHeatWarningAt: 95, portToolsOn: false, notifyOnRequest: true,
  bannerOnEveryChange: false, stuckThresholdMinutes: 8, alertsOnlyPriority: false, dotPalette: 'Default', sounds: true, soundNotify: 'Glass', soundNeedsYou: 'none', soundError: 'none',
  soundStuck: 'none', soundStopped: 'none', soundDone: 'none' };

/** The settings pages with the real values (a missing value is the default). */
function settingsPages(values = {}) {
  return SETTING_PAGES.map((p) => ({ id: p.id, title: p.title, rows: p.rows.map((r) => Object.assign({}, r, { value: values[r.name] === undefined ? DEFAULTS[r.name] : values[r.name] })) }));
}

// the model's sentences about WHEN you use the plan go on the Habits page; the forecast and its self-test go on the Forecast page
const HABIT_LINE = /^(Most of your use|Weekdays average|Weekday working hours)/;

const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
const isWeekend = (ms) => { const w = new Date(ms).getDay(); return w === 0 || w === 6; };

/**
 * From the hourly use ({cells: Map(hourStartMs -> points)}): average points per clock hour on weekdays and on weekend days, and total points per day for the last
 * `days` days. Hours are local. Empty when there is no use.
 */
function habitsData(use, now, days = 14) {
  const wd = new Array(24).fill(0), we = new Array(24).fill(0);
  const wdDays = new Set(), weDays = new Set(), perDay = new Map();
  if (use && use.cells) {
    for (const [h, pts] of use.cells) {
      const hour = new Date(h).getHours();
      if (isWeekend(h)) { we[hour] += pts; weDays.add(dayKey(h)); } else { wd[hour] += pts; wdDays.add(dayKey(h)); }
      perDay.set(dayKey(h), (perDay.get(dayKey(h)) || 0) + pts);
    }
  }
  const avg = (arr, n) => arr.map((v) => (n ? v / n : 0));
  const out = { weekday: avg(wd, wdDays.size), weekend: avg(we, weDays.size), daily: [] };
  const peak = Math.max(0.0001, ...out.weekday, ...out.weekend);
  out.peak = peak;
  for (let i = days - 1; i >= 0; i--) {
    const ms = now - i * DAY;
    const d = new Date(ms);
    out.daily.push({ label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + d.getDate(), points: Math.round((perDay.get(dayKey(ms)) || 0) * 10) / 10 });
  }
  return out;
}

/** Highest weekly reading per local day, for the History page. */
function weeklyByDay(samples, now, days = 14) {
  const best = new Map();
  for (const s of samples || []) if (typeof s.w === 'number') best.set(dayKey(s.t), Math.max(best.get(dayKey(s.t)) || 0, s.w));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const ms = now - i * DAY;
    const d = new Date(ms);
    out.push({ label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + d.getDate(), pct: best.has(dayKey(ms)) ? Math.round(best.get(dayKey(ms))) : null });
  }
  return out;
}

/** The forecast page's numbers (null when there is not enough history yet) with the plain sentences from the same model the Mac uses. */
function forecastData(analysis, pacing, now) {
  if (!analysis) return { has: false, lines: [], habitLines: [], pacing: pacing || null };
  const f = analysis.forecast;
  return {
    has: !!f,
    used: f ? Math.round(f.used) : null, projected: f ? Math.round(f.projected) : null,
    low: f && f.low !== null ? Math.round(f.low) : null, high: f && f.high !== null ? Math.round(f.high) : null,
    target: analysis.target, resets: f ? usageMod.resetText(f.resetsAt, now) : '',
    lines: (analysis.insights || []).filter((t) => !HABIT_LINE.test(t)), habitLines: (analysis.insights || []).filter((t) => HABIT_LINE.test(t)),
    samples: analysis.samples, daysSeen: analysis.daysSeen, pacing: pacing || null,
  };
}

/**
 * Ranked, plain-language things worth knowing, critical first, at most six, one action each (the page to open). "All clear" only when nothing is urgent.
 * input: sessions, usageRows [{name, pct}], forecast (forecastData), heat ({hot, c}), settings.
 */
function insightsFor({ sessions = [], usageRows = [], forecast = null, heat = null }) {
  const out = [];
  const needs = sessions.filter((s) => s.state === 'needsInput');
  if (needs.length) out.push({ id: 'needs', tone: 'critical', title: needs.length === 1 ? '1 session needs you' : needs.length + ' sessions need you', text: needs.map((s) => s.name).slice(0, 3).join(', ') + (needs.length > 3 ? '…' : ''), page: 'overview' });
  const bad = sessions.filter((s) => s.state === 'stopped' || s.state === 'warning');
  if (bad.length) out.push({ id: 'bad', tone: 'critical', title: bad.length === 1 ? '1 session stopped or hit an error' : bad.length + ' sessions stopped or hit an error', text: bad.map((s) => s.name).slice(0, 3).join(', '), page: 'overview' });
  const full = usageRows.filter((u) => u.pct >= 90);
  if (full.length) out.push({ id: 'limit90', tone: 'critical', title: full[0].name + ' is at ' + full[0].pct + '%', text: 'Close to the limit. Smaller jobs, or wait for the reset.', page: 'forecast' });
  if (heat && heat.hot) out.push({ id: 'heat', tone: 'critical', title: 'The CPU is hot (' + Math.round(heat.c) + '°)', text: 'Long agent runs make it hotter. Give it some air, or pause one.', page: 'general' });
  const stuck = sessions.filter((s) => s.state === 'stuck');
  if (stuck.length) out.push({ id: 'stuck', tone: 'warning', title: stuck.length === 1 ? '1 session looks stuck' : stuck.length + ' sessions look stuck', text: stuck.map((s) => s.name).slice(0, 3).join(', '), page: 'overview' });
  const warm = usageRows.filter((u) => u.pct > usageMod.THRESHOLD && u.pct < 90);
  if (warm.length) out.push({ id: 'limit70', tone: 'warning', title: warm[0].name + ' is at ' + warm[0].pct + '%', text: 'Over ' + usageMod.THRESHOLD + '% of the limit.', page: 'forecast' });
  if (forecast && forecast.has && forecast.projected !== null) {
    if (forecast.projected >= 100) out.push({ id: 'fc-out', tone: 'warning', title: 'The weekly limit may run out before the reset', text: 'Forecast ' + forecast.projected + '% at the reset. Move big jobs after it.', page: 'forecast' });
    else if (forecast.projected > forecast.target) out.push({ id: 'fc-over', tone: 'warning', title: 'On course to pass your ' + forecast.target + '% target', text: 'Forecast ' + forecast.projected + '% at the reset.', page: 'forecast' });
    else out.push({ id: 'fc-ok', tone: 'info', title: 'Weekly forecast: ' + forecast.projected + '%', text: 'On course for the reset; target ' + forecast.target + '%.', page: 'forecast' });
  }
  if (!out.length) out.push({ id: 'clear', tone: 'info', title: 'All clear', text: sessions.length ? 'Nothing needs you right now.' : 'No agent sessions are running.', page: 'overview' });
  return out.slice(0, MAX_INSIGHTS);
}

/** The whole window state. Everything is data the tray already has or reads from local files. */
function buildMainState({ now = Date.now(), sessions = [], icons = {}, usage = null, priority = { pins: {}, folders: {}, onlyPriority: false }, analysis = null, pacing = null, use = null, samples = [], settings = {}, keepAwake = false, heat = null, summary = '', version = '', agents = [] } = {}) {
  const usageRows = [];
  if (usage) for (const a of usage.agents) for (const w of a.windows) usageRows.push({ name: a.agentName + ' · ' + w.label, pct: Math.round(w.usedPercentage), resets: usageMod.resetText(w.resetsAtMs, now) });
  const rows = sessions.map((s) => ({
    key: s.key, name: s.name, agent: s.agentName, state: s.state, label: s.label, prompt: s.prompt || '', cwd: s.cwd || '',
    age: ago(now - s.lastActivityAt), high: priorityMod.isHighPriority(s, priority.pins || {}, priority.folders || {}),
  }));
  const forecast = forecastData(analysis, pacing, now);
  const values = Object.assign({}, settings, { alertsOnlyPriority: priority.onlyPriority === true });
  return {
    title: 'Votive Dots', version, icons, keepAwake, summary, usage: usageRows, sessions: rows, forecast,
    habits: habitsData(use, now), history: weeklyByDay(samples, now), order: rows.map((r) => ({ key: r.key, name: r.name, agent: r.agent, state: r.state, high: r.high })),
    agents, settings: settingsPages(values), insights: insightsFor({ sessions: rows, usageRows, forecast, heat }),
  };
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  if (s < 86400) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' d';
}

module.exports = { buildMainState, settingsPages, habitsData, weeklyByDay, forecastData, insightsFor, SETTING_PAGES, SOUND_CHOICES, DEFAULTS, MAX_INSIGHTS };
