'use strict';
//
// The session model for the Linux tray: reads the event files the hooks write to ~/.votive/events and turns them into
// the same states the Mac app shows. A port of OverlayStore.swift, StatusResolver.resolveEvent and the event-only branch
// of AgentScanner.scan (dead process -> red for a minute, stuck after the threshold, pid-reuse guard, 30 minute limit for
// sessions with no pid). Read-only: it never writes, deletes or signals anything.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATES = ['starting', 'working', 'done', 'needsInput', 'warning', 'stuck', 'stopped'];
const LABELS = { starting: 'starting', working: 'working', done: 'done', needsInput: 'needs you', warning: 'error', stuck: 'stuck', stopped: 'stopped' };
// Lower sorts first when the tray has to pick the one state that stands for all sessions.
const URGENCY = { needsInput: 0, warning: 1, stuck: 2, stopped: 3, working: 4, starting: 5, done: 6 };

const AGENT_NAMES = {
  'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', qwen: 'Qwen Code', copilot: 'Copilot CLI', cursor: 'Cursor',
  windsurf: 'Windsurf', goose: 'Goose', cline: 'Cline', opencode: 'OpenCode', amp: 'Amp', aider: 'Aider', generic: 'Agent',
};
const agentName = (id) => AGENT_NAMES[id] || String(id).split('-').map((w) => w.slice(0, 1).toUpperCase() + w.slice(1)).join(' ');

const MAX_FILE_BYTES = 64 * 1024;
const MAX_PLAUSIBLE_MS = 4102444800000;   // year 2100, the Mac app's bound
const RED_GRACE_MS = 60 * 1000;
const OVERLAY_ONLY_TTL_MS = 30 * 60 * 1000;
const PID_REUSE_SLACK_MS = 5000;

/** Text from a file we did not write: control and invisible characters become spaces, cut to `max` characters. */
function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join('') : t;
}

/** One parsed event file, or null when it is not ours or not sane. */
function parseEvent(raw) {
  let o;
  try { o = JSON.parse(raw); } catch (e) { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.sessionId !== 'string' || !o.sessionId || typeof o.lastEvent !== 'string') return null;
  const at = o.lastEventAt;
  if (!Number.isInteger(at) || at < 0 || at > MAX_PLAUSIBLE_MS) return null;
  const agent = typeof o.agent === 'string' && o.agent ? o.agent : 'claude-code';
  const notifyAt = Number.isInteger(o.notifyAt) && o.notifyAt >= 0 && o.notifyAt <= MAX_PLAUSIBLE_MS ? o.notifyAt : null;
  return {
    agent: clip(agent, 40), sessionId: clip(o.sessionId, 80), lastEvent: o.lastEvent, lastEventAt: at,
    cwd: typeof o.cwd === 'string' ? clip(o.cwd, 400) : '',
    pid: Number.isInteger(o.pid) && o.pid > 1 ? o.pid : 0,
    prompt: clip(o.prompt, 160) || null,
    transcriptPath: typeof o.transcriptPath === 'string' && o.transcriptPath.startsWith('/') ? clip(o.transcriptPath, 1024) : '',
    notifyMessage: notifyAt !== null ? clip(o.notifyMessage, 300) || null : null, notifyAt,
  };
}

/** Every readable event file in `dir`. A missing folder is "no sessions"; a half-written, oversized or foreign file is skipped. */
function readEvents(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    const file = path.join(dir, n);
    let raw;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) { continue; }   // gone between the listing and the read: the hook renamed over it
    const ev = parseEvent(raw);
    if (ev) out.push(ev);
  }
  return out;
}

/** The state an event stands for, or null when it should be hidden. Same precedence as StatusResolver.resolveEvent. */
function resolveEvent(ev, { alive, now, firstSeenDeadAt, stuckMs = 8 * 60000, activityFloor = 0 }) {
  if (!alive) return firstSeenDeadAt != null && now - firstSeenDeadAt > RED_GRACE_MS ? null : 'stopped';
  switch (ev.lastEvent) {
    case 'waiting': return 'needsInput';
    case 'error': return 'warning';
    case 'starting': return 'starting';
    case 'done': return 'done';
    case 'working': return stuckMs > 0 && now - Math.max(ev.lastEventAt, activityFloor) > stuckMs ? 'stuck' : 'working';
    default: return null;
  }
}

// ---------- the process, from /proc ----------

let bootTimeMs;
function bootTime() {
  if (bootTimeMs !== undefined) return bootTimeMs;
  try {
    const m = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
    bootTimeMs = m ? parseInt(m[1], 10) * 1000 : null;
  } catch (e) { bootTimeMs = null; }
  return bootTimeMs;
}

/** When the process started (epoch ms), from field 22 of /proc/<pid>/stat (clock ticks since boot, 100 per second). Null if unknown. */
function processStartMs(pid) {
  try {
    const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = s.slice(s.lastIndexOf(')') + 2).split(' ');   // fields[0] is the state, field 22 of the file is fields[19]
    const ticks = parseInt(fields[19], 10);
    const boot = bootTime();
    return Number.isFinite(ticks) && boot ? boot + Math.round(ticks * 10) : null;
  } catch (e) { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const defaultProbe = { alive: pidAlive, startMs: processStartMs };

/** The pid is alive AND is still the process that wrote the file: one that started after the last event cannot be (pid reuse). */
function hostAlive(ev, probe) {
  if (!ev.pid || !probe.alive(ev.pid)) return false;
  const started = probe.startMs(ev.pid);
  return !(started != null && started > ev.lastEventAt + PID_REUSE_SLACK_MS);
}

/**
 * Keeps the bookkeeping that needs memory between scans (when each session was first seen dead, when it was first seen),
 * so a session that dies while we watch gets its minute of red and the order stays stable. Create one and call scan().
 */
class SessionTracker {
  constructor({ eventsDir, probe = defaultProbe, stuckMinutes = 8, read = readEvents } = {}) {
    this.eventsDir = eventsDir || path.join(process.env.VOTIVE_HOME || path.join(os.homedir(), '.votive'), 'events');
    this.probe = probe;
    this.stuckMs = stuckMinutes * 60000;
    this.read = read;
    this.firstSeenDead = new Map();
    this.firstSeenAt = new Map();
    this.activityFloor = 0;
  }

  /** Call after the machine wakes from suspend: quiet time is counted from now, not from before the lid closed. */
  noteWake(now) { this.activityFloor = now; }

  scan(now = Date.now()) {
    const present = new Set();
    const sessions = [];
    for (const ev of this.read(this.eventsDir)) {
      const key = ev.agent + ':' + ev.sessionId;
      let alive;
      if (ev.pid) alive = hostAlive(ev, this.probe);
      else {
        if (now - ev.lastEventAt > OVERLAY_ONLY_TTL_MS) continue;   // no pid to check: trust it only while recent
        alive = true;
      }
      // A session that died long before we first saw it is history, not a red dot.
      if (!alive && !this.firstSeenAt.has(key) && now - ev.lastEventAt > RED_GRACE_MS) continue;
      present.add(key);
      if (alive) this.firstSeenDead.delete(key);
      else if (!this.firstSeenDead.has(key)) this.firstSeenDead.set(key, now);
      const state = resolveEvent(ev, { alive, now, firstSeenDeadAt: this.firstSeenDead.get(key), stuckMs: this.stuckMs, activityFloor: this.activityFloor });
      if (!state) continue;
      if (!this.firstSeenAt.has(key)) this.firstSeenAt.set(key, ev.lastEventAt);   // the first event we saw stands in for when it opened
      sessions.push({
        key, agent: ev.agent, agentName: agentName(ev.agent), sessionId: ev.sessionId, pid: ev.pid, cwd: ev.cwd,
        name: ev.cwd ? path.basename(ev.cwd.replace(/\/+$/, '')) || 'session' : 'session',
        state, label: LABELS[state], startedAt: this.firstSeenAt.get(key), lastActivityAt: ev.lastEventAt, prompt: ev.prompt, transcriptPath: ev.transcriptPath || '',
        notifyMessage: ev.notifyMessage, notifyAt: ev.notifyAt,
      });
    }
    for (const m of [this.firstSeenDead, this.firstSeenAt]) for (const k of m.keys()) if (!present.has(k)) m.delete(k);
    sessions.sort((a, b) => a.startedAt - b.startedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return sessions;
  }
}

/** The one state that stands for all sessions (the most urgent), or null when there are none. */
function overallState(sessions) {
  let best = null;
  for (const s of sessions) if (best === null || URGENCY[s.state] < URGENCY[best]) best = s.state;
  return best;
}

/** "3 min", "2 h", "just now": how long ago, in the short form a menu row wants. */
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  if (s < 86400) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' d';
}

module.exports = { STATES, LABELS, URGENCY, agentName, parseEvent, readEvents, resolveEvent, processStartMs, pidAlive, hostAlive, SessionTracker, overallState, ago, RED_GRACE_MS };
