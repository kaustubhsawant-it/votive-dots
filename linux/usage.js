'use strict';
//
// Plan usage for the Linux tray: reads ~/.votive/usage/<agent>.json (written by the status-line wrapper and by Codex's reader) by the Mac app's
// rules (UsageStore.swift): a window whose reset time has passed is dropped, so a stale 90% can never keep the icon flagged; percentages are
// clamped to 0-100; Claude Code is listed first. Read-only.
//
const fs = require('fs');
const path = require('path');
const { agentName } = require('./sessions');

const THRESHOLD = 70;                 // strictly over this is "hot", the same number as the Mac app
const MAX_FILE_BYTES = 64 * 1024;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** One agent's usage from the parsed JSON, or null when it has no live window. */
function parseAgent(obj, fallbackName, nowMs) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.windows)) return null;
  const windows = [];
  for (const w of obj.windows) {
    if (!w || !finite(w.usedPercentage) || !finite(w.resetsAt) || w.resetsAt <= 0) continue;
    const resetsAtMs = (w.resetsAt > 1e11 ? w.resetsAt : w.resetsAt * 1000);   // seconds, or already milliseconds
    if (resetsAtMs <= nowMs) continue;
    const label = typeof w.label === 'string' && w.label ? Array.from(w.label).slice(0, 20).join('') : 'Limit';
    windows.push({ label, usedPercentage: Math.min(100, Math.max(0, w.usedPercentage)), resetsAtMs });
  }
  if (!windows.length) return null;
  const agent = typeof obj.agent === 'string' && obj.agent ? obj.agent : fallbackName;
  return { agent, agentName: agentName(agent), windows };
}

/** Every agent with a live window: Claude Code first, then by name. Null when there is none. */
function readUsage(dir, nowMs = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const agents = [];
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.') || n === 'wrapped.json') continue;
    try {
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const a = parseAgent(JSON.parse(fs.readFileSync(file, 'utf8')), n.replace(/\.json$/, ''), nowMs);
      if (a) agents.push(a);
    } catch (e) { /* half-written or foreign: skipped */ }
  }
  agents.sort((a, b) => (a.agent === 'claude-code') !== (b.agent === 'claude-code') ? (a.agent === 'claude-code' ? -1 : 1) : a.agentName < b.agentName ? -1 : a.agentName > b.agentName ? 1 : 0);
  return agents.length ? { agents } : null;
}

const overThreshold = (usage) => !!usage && usage.agents.some((a) => a.windows.some((w) => w.usedPercentage > THRESHOLD));

/** "▰▰▱▱▱▱▱▱": eight cells, filled in proportion (a text bar works in every menu). */
function bar(pct) {
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 100 * 8);
  return '▰'.repeat(filled) + '▱'.repeat(8 - filled);
}

/** "14:30" for a reset later today, "Mon 14:30" for another day, in the person's own locale. */
function resetText(ms, nowMs = Date.now(), locale) {
  const d = new Date(ms), n = new Date(nowMs);
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return same ? time : d.toLocaleDateString(locale, { weekday: 'short' }) + ' ' + time;
}

/** One text line per live window, for the menu and the tooltip. */
function lines(usage, { nowMs = Date.now(), locale } = {}) {
  if (!usage) return [];
  const named = usage.agents.length > 1;
  const out = [];
  for (const a of usage.agents) for (const w of a.windows) {
    const pct = Math.round(w.usedPercentage);
    out.push({
      key: a.agent + ':' + w.label,
      hot: w.usedPercentage > THRESHOLD,
      text: (w.usedPercentage > THRESHOLD ? '⚠ ' : '') + (named ? a.agentName + ' ' : '') + w.label + '  ' + bar(w.usedPercentage) + '  ' + pct + '%  ·  resets ' + resetText(w.resetsAtMs, nowMs, locale),
      short: (named ? a.agentName + ' ' : '') + w.label + ' ' + pct + '%',
    });
  }
  return out;
}

module.exports = { THRESHOLD, parseAgent, readUsage, overThreshold, bar, resetText, lines };
