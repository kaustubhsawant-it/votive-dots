'use strict';
//
// High-priority ("pinned") sessions and the hand-set order of the dots, the same rules as the Mac's SessionPriority.swift.
// A pinned session sorts first, in the menu and in the tray dots, and (when the person asks for it) is the only kind that raises automatic alerts.
// A session is high priority in two ways: that one session was pinned (by its key, agent:sessionId), or its folder was marked, so every session
// started there is high priority without doing anything each time. On the Mac these live in the app's preferences; here they live in one small file,
// ~/.votive/priority.json, that only this tray writes.
//
const fs = require('fs');
const path = require('path');

const KEEP_SECONDS = 14 * 24 * 3600;   // a pin for a session that is no longer running is dropped after this long (a resumed session keeps its pin)
const MAX_PINS = 50;
const MAX_FOLDERS = 50;
const MAX_POSITIONS = 100;
const MAX_FILE_BYTES = 64 * 1024;

/** A folder as stored and compared: no trailing slash. */
function normalize(p) {
  let s = String(p).trim();
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** What is stored, validated: short non-empty keys, positive finite times, at most `limit` (the newest). */
function clean(raw, limit = MAX_PINS, pathKeys = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k || k.length > (pathKeys ? 1024 : 300) || (pathKeys && !k.startsWith('/'))) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    out[k] = v;
  }
  const entries = Object.entries(out);
  if (entries.length <= limit) return out;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, limit));
}
const cleanFolders = (raw) => clean(raw, MAX_FOLDERS, true);

/** A stored order, validated: short non-empty text keys, no repeats, at most 100 (the first ones). */
function cleanOrder(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const k of raw) {
    if (typeof k !== 'string' || !k || k.length > 300 || seen.has(k)) continue;
    seen.add(k); out.push(k);
    if (out.length === MAX_POSITIONS) break;
  }
  return out;
}

/** When this session became high priority (its own pin, else its folder's rule), or null if it is not. */
function pinTime(s, pins, folders) {
  if (pins[s.key] !== undefined) return pins[s.key];
  if (!s.cwd) return null;
  const t = folders[normalize(s.cwd)];
  return t === undefined ? null : t;
}
const isHighPriority = (s, pins, folders = {}) => pinTime(s, pins, folders) !== null;

/**
 * High-priority sessions first, in the order they became so; everyone else after them in the order given.
 * `positions` is the order set by hand: inside each of those two groups, sessions with a place in it come first, in that order, then the rest as before.
 * It never moves a session from one group to the other, so it cannot change anyone's priority.
 */
function order(sessions, pins, folders = {}, positions = []) {
  const place = new Map();
  positions.forEach((k, i) => { if (!place.has(k)) place.set(k, i); });
  const byPlace = (group) => {
    if (!place.size) return group;
    return group.filter((s) => place.has(s.key)).sort((a, b) => place.get(a.key) - place.get(b.key)).concat(group.filter((s) => !place.has(s.key)));
  };
  const pinned = sessions.filter((s) => isHighPriority(s, pins, folders)).sort((a, b) => {
    const ta = pinTime(a, pins, folders), tb = pinTime(b, pins, folders);
    if (ta !== tb) return ta - tb;
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const rest = sessions.filter((s) => !isHighPriority(s, pins, folders));
  return byPlace(pinned).concat(byPlace(rest));
}

/** A full order to store: `ids` as shown, followed by older entries still stored for sessions not shown now. */
const placed = (ids, stored = []) => cleanOrder(ids.concat(stored.filter((k) => !ids.includes(k))));

/**
 * The hand-set order after moving one session `delta` places (-1 earlier, +1 later) inside its priority group, or null when it cannot move
 * (already at that end of its group, or not shown). `displayed` is the list as shown now.
 */
function moved(key, delta, displayed, pins, folders = {}, stored = []) {
  const i = displayed.findIndex((s) => s.key === key);
  if (i < 0 || !delta) return null;
  const j = i + (delta < 0 ? -1 : 1);
  if (j < 0 || j >= displayed.length) return null;
  if (isHighPriority(displayed[i], pins, folders) !== isHighPriority(displayed[j], pins, folders)) return null;
  const ids = displayed.map((s) => s.key);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return placed(ids, stored);
}
const canMove = (key, delta, displayed, pins, folders = {}) => moved(key, delta, displayed, pins, folders) !== null;

/** Whether an automatic alert (banner, state-change sound) may fire for this session. A message a person asked a session to send is not automatic and never goes through this. */
const shouldAlert = (s, onlyPriority, pins, folders = {}) => !onlyPriority || isHighPriority(s, pins, folders);

/** The pins that are still wanted: every pin of a running session, and recent pins of sessions that are not running. */
function pruned(pins, live, nowSeconds) {
  const out = {};
  for (const [k, t] of Object.entries(pins)) if (live.has(k) || nowSeconds - t < KEEP_SECONDS) out[k] = t;
  return out;
}

/** The file with the pins, folder rules, hand-set order and the "only alert for high priority" switch. The only writer. */
class PriorityStore {
  constructor(root) {
    this.file = path.join(root, 'priority.json');
    this.root = root;
    this._key = null;
    this._value = { pins: {}, folders: {}, positions: [], onlyPriority: false };
  }

  /** { pins, folders, positions, onlyPriority }; the file is parsed again only when it changed. A missing, huge or broken file is "nothing set". */
  read() {
    let key = 'missing';
    try { const st = fs.statSync(this.file); key = st.mtimeMs + ':' + st.size; if (st.size > MAX_FILE_BYTES) key = 'big'; } catch (e) { /* no file */ }
    if (key === this._key) return this._value;
    let v = { pins: {}, folders: {}, positions: [], onlyPriority: false };
    if (key !== 'missing' && key !== 'big') {
      try {
        const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        v = { pins: clean(o.pins), folders: cleanFolders(o.folders), positions: cleanOrder(o.positions), onlyPriority: o.onlyPriority === true };
      } catch (e) { /* unreadable: nothing set, and the next write replaces it */ }
    }
    this._key = key;
    this._value = v;
    return v;
  }

  _write(v) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this._key = null;
  }

  /** Pins or unpins one session. Returns whether it is pinned afterwards. */
  toggle(key, nowSeconds = Date.now() / 1000) {
    const v = this.read();
    const pins = Object.assign({}, v.pins);
    const now = pins[key] === undefined;
    if (now) pins[key] = nowSeconds; else delete pins[key];
    this._write(Object.assign({}, v, { pins: clean(pins) }));
    return now;
  }

  /** Marks or unmarks a folder: every session started in it is high priority. Returns whether it is marked afterwards. */
  toggleFolder(folder, nowSeconds = Date.now() / 1000) {
    const key = normalize(folder);
    if (!key.startsWith('/')) return false;
    const v = this.read();
    const folders = Object.assign({}, v.folders);
    const now = folders[key] === undefined;
    if (now) folders[key] = nowSeconds; else delete folders[key];
    this._write(Object.assign({}, v, { folders: cleanFolders(folders) }));
    return now;
  }

  setPositions(list) { this._write(Object.assign({}, this.read(), { positions: cleanOrder(list) })); }
  setOnlyPriority(on) { this._write(Object.assign({}, this.read(), { onlyPriority: on === true })); }

  /** Drops pins nobody needs any more. Writes only when something changed. */
  prune(live, nowSeconds = Date.now() / 1000) {
    const v = this.read();
    const after = pruned(v.pins, live, nowSeconds);
    if (Object.keys(after).length !== Object.keys(v.pins).length) this._write(Object.assign({}, v, { pins: after }));
  }
}

module.exports = { normalize, clean, cleanFolders, cleanOrder, pinTime, isHighPriority, order, placed, moved, canMove, shouldAlert, pruned, PriorityStore, KEEP_SECONDS };
