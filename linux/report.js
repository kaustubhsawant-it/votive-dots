'use strict';
//
// The Votive window on Linux: a tray cannot open a window, so "Open Votive report…" writes one page, ~/Votive/report.html, and opens it in a web browser. It is not in
// ~/.votive because Ubuntu's snap Firefox is not allowed to read hidden folders ("Access to the file was denied", seen in the VM). The page is read-only and self-contained: one file, its own CSS, no script, no image, no link out and no network access (a Content-Security-Policy says so,
// and a test checks for it). Everything on it comes from files on this computer: the sessions, the plan usage, and the habits and pacing advice that the existing
// scripts compute from the usage history. Every piece of text that came from another program is escaped.
//
const fs = require('fs');
const path = require('path');
const usageMod = require('./usage');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const STATE_COLOR = { starting: '#3b82f6', working: '#eab308', done: '#22c55e', needsInput: '#a855f7', warning: '#f97316', stuck: '#92400e', stopped: '#ef4444' };
const STATE_ORDER = ['needsInput', 'warning', 'stuck', 'stopped', 'working', 'starting', 'done'];

const CSS = `
:root{color-scheme:light dark;--bg:#f6f6f8;--card:#fff;--ink:#1c1c22;--mute:#6b6b78;--line:#e4e4ea;--bar:#e8e8ee;--ok:#22c55e;--warn:#f97316;--hot:#ef4444}
@media (prefers-color-scheme:dark){:root{--bg:#16161b;--card:#1f1f26;--ink:#ececf1;--mute:#9a9aa8;--line:#2e2e38;--bar:#2e2e38}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 48px}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}
.sub{color:var(--mute);margin:0 0 22px}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:0 0 16px}
table{width:100%;border-collapse:collapse}th{font-weight:600;text-align:left;color:var(--mute);font-size:13px;padding:0 8px 8px 0}td{padding:8px 8px 8px 0;border-top:1px solid var(--line);vertical-align:top}
.dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:8px;vertical-align:-1px}.star{color:#eab308;margin-right:4px}
.prompt{color:var(--mute);font-size:13px}.bars{display:grid;gap:14px}.bar{height:10px;border-radius:6px;background:var(--bar);overflow:hidden;margin-top:4px}
.bar i{display:block;height:100%;background:var(--ok)}.bar i.warn{background:var(--warn)}.bar i.hot{background:var(--hot)}.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
ul{margin:0;padding-left:20px}li{margin:4px 0}pre{margin:0;white-space:pre-wrap;word-wrap:break-word;font:13px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace}.mute{color:var(--mute)}
@media (max-width:560px){main{padding:16px 12px 32px}section{padding:14px}table,tbody,tr,td{display:block}th{display:none}td{border:0;padding:2px 0}tr{border-top:1px solid var(--line);padding:8px 0}}
`;

const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return s + ' s ago';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
};

/**
 * The page, as one string. Pure: the same input always gives the same page.
 * input: { sessions, usage, habits: { insights: [text], samples, daysSeen } | null, pacing: text | null, priority: { pins, folders } | null, now }
 */
function buildReport({ sessions = [], usage = [], habits = null, pacing = null, highPriority = () => false, now = Date.now() } = {}) {
  const out = [];
  out.push('<!doctype html><html lang="en"><head><meta charset="utf-8">');
  out.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">');
  out.push('<meta name="viewport" content="width=device-width,initial-scale=1"><title>Votive Dots report</title><style>' + CSS + '</style></head><body><main>');
  out.push('<h1>Votive Dots</h1><p class="sub">Report made ' + esc(new Date(now).toLocaleString()) + '. Everything here was read from files on this computer; nothing was sent anywhere. Reload by choosing Open Votive Dots report again.</p>');

  // sessions
  out.push('<section><h2>Sessions</h2>');
  if (!sessions.length) out.push('<p class="mute">No agent sessions are running.</p>');
  else {
    const sorted = sessions.slice().sort((a, b) => (highPriority(b) - highPriority(a)) || STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
    out.push('<table><thead><tr><th>Session</th><th>State</th><th>Agent</th><th>Last activity</th></tr></thead><tbody>');
    for (const s of sorted) {
      out.push('<tr><td>' + (highPriority(s) ? '<span class="star" title="High priority">★</span>' : '') + '<strong>' + esc(s.name) + '</strong>'
        + (s.prompt ? '<div class="prompt">“' + esc(s.prompt) + '”</div>' : '') + (s.cwd ? '<div class="prompt">' + esc(s.cwd) + '</div>' : '') + '</td>'
        + '<td><span class="dot" style="background:' + (STATE_COLOR[s.state] || '#888') + '"></span>' + esc(s.label) + '</td><td>' + esc(s.agentName) + '</td><td>' + esc(dur(now - s.lastActivityAt)) + '</td></tr>');
    }
    out.push('</tbody></table>');
  }
  out.push('</section>');

  // plan usage
  out.push('<section><h2>Plan usage</h2>');
  const wins = [];
  for (const a of usage) for (const w of a.windows) wins.push({ agent: a.agentName, w });
  if (!wins.length) out.push('<p class="mute">No plan usage has been recorded yet. It appears after the next status-line refresh of an agent that reports it.</p>');
  else {
    out.push('<div class="bars">');
    for (const { agent, w } of wins) {
      const pct = Math.round(w.usedPercentage);
      const cls = pct > usageMod.THRESHOLD ? (pct >= 90 ? 'hot' : 'warn') : '';
      out.push('<div><div class="row"><span><strong>' + esc(agent) + '</strong> · ' + esc(w.label) + '</span><span>' + pct + '% used · resets ' + esc(new Date(w.resetsAtMs).toLocaleString()) + '</span></div>'
        + '<div class="bar" role="img" aria-label="' + pct + ' percent used"><i class="' + cls + '" style="width:' + Math.min(100, Math.max(0, pct)) + '%"></i></div></div>');
    }
    out.push('</div>');
  }
  out.push('</section>');

  // forecast and habits
  out.push('<section><h2>Forecast and habits</h2>');
  if (habits && habits.insights && habits.insights.length) {
    out.push('<ul>' + habits.insights.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>');
    out.push('<p class="mute">Based on ' + esc(habits.samples) + ' samples over ' + esc(habits.daysSeen) + ' whole days. A small statistical model of your own usage history, not a neural network.</p>');
  } else out.push('<p class="mute">No usage history yet. It starts after the next Claude Code status-line refresh.</p>');
  out.push('</section>');

  if (pacing) out.push('<section><h2>Pacing advice</h2><pre>' + esc(pacing) + '</pre></section>');
  out.push('<p class="mute">Votive Dots for Linux. It only reads local files and sends nothing over a network.</p>');
  out.push('</main></body></html>');
  return out.join('\n');
}

/** Reads what the page needs. Every reader is injectable; a reader that fails leaves its section empty instead of failing the page. */
function gather({ eventsSessions = [], usageDir, priority = null, now = Date.now(), habitsFn, pacingFn } = {}) {
  let usage = [];
  try { const u = usageMod.readUsage(usageDir, now); usage = u ? u.agents : []; } catch (e) { /* no usage */ }
  let habits = null, pacing = null;
  try {
    const history = require('../Scripts/usage-history').read('claude-code');
    if (history.length) {
      habits = (habitsFn || ((h) => require('../Scripts/usage-habits').analyse(h, { target: 80 })))(history);
      pacing = (pacingFn || ((h) => { const p = require('../Scripts/usage-pacing'); return p.format(p.advise(h, { target: 80, conserve: 85 })); }))(history);
    }
  } catch (e) { /* a missing or broken history: the sections say so */ }
  const highPriority = priority ? (s) => priorityIsHigh(s, priority) : () => false;
  return { sessions: eventsSessions, usage, habits, pacing, highPriority, now };
}
const priorityIsHigh = (s, p) => require('./priority').isHighPriority(s, p.pins || {}, p.folders || {});

/** Where the report goes: ~/Votive, or VOTIVE_REPORT_DIR. A visible folder, because a snap browser cannot read a hidden one. */
const reportDir = (env = process.env) => env.VOTIVE_REPORT_DIR || path.join(require('os').homedir(), 'Votive');

/** Writes the page (private file, atomic) and returns its path. */
function write(root, html) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'report.html');
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, html, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { buildReport, gather, write, reportDir, esc };
