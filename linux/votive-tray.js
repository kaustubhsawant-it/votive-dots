#!/usr/bin/env node
'use strict';
//
// Votive Dots for Linux: one dot per agent session in the desktop's tray, from the event files the hooks write.
//
//   node linux/votive-tray.js            run the tray (the systemd user service does this)
//   node linux/votive-tray.js --print    print the sessions it would show, as JSON, and exit
//
// It only reads ~/.votive and talks to the user's own D-Bus session bus. It opens no network connection and never sends
// input to another program.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection, sessionAddress } = require('./dbus/bus');
const { Tray } = require('./tray');
const { SessionTracker, overallState, ago, LABELS } = require('./sessions');
const { ATTENTION } = require('./icon');
const { Alerter } = require('./alerts');
const { makePlayer } = require('./sound');
const usageMod = require('./usage');
const { KeepAwake } = require('./keepawake');
const focus = require('./focus');
const snippetsMod = require('./snippets');
const portsMod = require('./ports');
const portActions = require('./portactions');
const reportMod = require('./report');
const menuIcons = require('./menuicons');
const { WindowHost } = require('./window');
const { MainWindowHost } = require('./mainwindow');
const mainState = require('./mainstate');
const palettes = require('./palettes');
const priorityMod = require('./priority');
const { PrefsStore } = require('./prefs');

const BUS_NAME = 'dev.votive.Votive';
const POLL_MS = 2000;
const WAKE_GAP_MS = 30000;   // a timer that fires this late means the machine was suspended

/** GNOME's AppIndicator extension draws a text label beside the icon (other hosts ignore it); that is where the row of dots goes there. */
const actions = require('./actions');
const labelWanted = (env) => env.VOTIVE_TRAY_LABEL ? env.VOTIVE_TRAY_LABEL === '1' : /gnome/i.test(env.XDG_CURRENT_DESKTOP || '');

const EMOJI = { starting: '🔵', working: '🟡', done: '🟢', needsInput: '🟣', warning: '🟠', stuck: '🟤', stopped: '🔴' };
const GLYPH = { starting: '◯', working: '●', done: '■', needsInput: '▲', warning: '◆', stuck: '▮▮', stopped: '✕' };   // colorblind shapes, as on the Mac

const heatMod = require('./heat');

const votiveRoot = (env = process.env) => env.VOTIVE_HOME || path.join(os.homedir(), '.votive');

/** The rows of the tray menu for a list of sessions. Pure: the same input always gives the same menu. */
// the switches in the Settings submenu: [setting name, label]
const TOGGLES = [
  ['colorblindShapes', 'Colorblind shapes'],
  ['usagePulse', 'Flag the icon when a plan limit is over 70%'],
  ['notifyOnRequest', 'Notify me when a session was asked to'],
  ['bannerOnEveryChange', 'Notify me on every change (finished, needs you, error, stopped)'],
  ['sounds', 'Sounds'],
  ['cpuHeatWarning', 'Warn when the CPU is hot'],
  ['portToolsOn', 'Ports list (developer tool)'],
];
const TOGGLE_DEFAULTS = { colorblindShapes: false, usagePulse: true, notifyOnRequest: true, bannerOnEveryChange: false, sounds: true, cpuHeatWarning: false, portToolsOn: false };

/** The state pictures the window shows, as base64 PNG: the same shapes and colours as the menu rows and the Mac app. The window draws nothing itself. */
const windowIcons = (palette = 'default') => { const out = {}; for (const st of Object.keys(require('./icon').COLORS)) out[st] = menuIcons.stateIcon(st, { shapes: true, size: 40, palette }).toString('base64'); return out; };
const SUMMARY_ORDER = ['needsInput', 'warning', 'stuck', 'stopped', 'working', 'starting', 'done'];
/** "1 needs you, 2 working, 1 done", as under the Mac's session list. */
function summaryLine(sessions) {
  const parts = [];
  for (const st of SUMMARY_ORDER) {
    const of = sessions.filter((x) => x.state === st);
    if (of.length) parts.push(of.length + ' ' + of[0].label);
  }
  return parts.join(', ');
}

const INDENT = '\u2003\u2002 ';   // lines up the second line under the name, after the dot and its two spaces
const clip = (text, n) => (text.length > n ? text.slice(0, n - 1).trimEnd() + '…' : text);

/**
 * The menu, laid out like the Mac's: plan usage, the sessions (name, then agent and state, then what it was asked), a summary, the controls.
 * The dot is text at the start of the first line: GNOME's extension draws a row icon only on rows without a submenu, and at the far right.
 * A row is flat and goes to its terminal when clicked; the other per-session actions are in the Copy sub-menu below.
 */
function buildMenu(sessions, { now = Date.now(), shapes = false, icons = false, compact = false, usage = null, heat = null, palette = 'default', settings = {}, keepAwake = null, snippets = null, ports = null, priority = null, onOpenWindow, onOpenMain, onOpenReport, onPortAction, onOpenFolder, onOpenTranscript, onOpenData, onAbout, onEditPorts, onPin, onPinFolder, onMove, onOnlyPriority, onToggle, onKeepAwake, onFocus, onCopy, onCopySnippet, onAddSnippet, onEditSnippets, onQuit } = {}) {
  const dot = (s) => (shapes ? GLYPH : EMOJI)[s.state];
  const high = (s) => !!priority && priorityMod.isHighPriority(s, priority.pins, priority.folders);
  const items = [];
  const usageRows = usageMod.lines(usage, { nowMs: now });
  if (usageRows.length) {
    items.push({ key: 'usage-head', label: 'Plan usage', enabled: false });
    for (const u of usageRows) items.push({ key: 'u:' + u.key, label: u.text, enabled: false });
    items.push({ key: 'sep-usage', separator: true });
  }
  items.push({ key: 'head', enabled: false, label: sessions.length ? 'Sessions' : 'No agent sessions' });
  // Rows are keyed by their place in the list, not by the session: a tray host (GNOME's AppIndicator) gives a row its id once and does not move rows
  // it already has, so when the order changes (a pin, a move) the same slots just get new text.
  sessions.forEach((s, i) => {
    const second = (s.prompt ? '“' + clip(s.prompt, 52) + '”  ·  ' : '') + ago(now - s.lastActivityAt);
    // no sub-menu: GNOME opens those inline, under the row, which is what made the list stack up. Clicking the row goes to its terminal, as on the Mac.
    items.push({
      key: 's:' + i, onClick: onFocus ? () => onFocus(s) : undefined, icon: icons ? menuIcons.stateIcon(s.state, { shapes: true, palette }) : undefined,
      label: (icons ? '' : dot(s) + '  ') + (high(s) ? '★ ' : '') + s.name + '   ' + s.agentName + ', ' + s.label + '\n' + INDENT + second,
    });
  });
  if (sessions.length) items.push({ key: 'summary', label: summaryLine(sessions), enabled: false });
  const heatRow = heat ? heatMod.menuLine(heat) : null;
  if (heatRow) items.push({ key: 'sep-heat', separator: true }, { key: 'heat', label: heatRow, enabled: false });
  items.push({ key: 'sep-bottom', separator: true });
  if (onOpenMain) items.push({ key: 'main', label: 'Open Votive Dots…', onClick: onOpenMain });
  if (onOpenWindow) items.push({ key: 'window', label: 'Quick view', onClick: onOpenWindow });
  if (onOpenReport) items.push({ key: 'report', label: 'Open Votive Dots report…', onClick: onOpenReport });
  if (keepAwake !== null) {
    items.push({ key: 'keep-awake', label: 'Keep awake', toggle: 'checkmark', checked: keepAwake, onClick: onKeepAwake });
  }
  if (snippets !== null) {
    const rows = snippets.length
      ? snippets.map((t, i) => ({ key: 'snip:' + i, label: snippetsMod.shown(t), onClick: onCopySnippet ? () => onCopySnippet(t) : undefined }))
      : [{ key: 'snip-none', label: 'No snippets yet', enabled: false }];
    rows.push({ key: 'sep-snip', separator: true }, { key: 'snip-add', label: 'Add from clipboard', onClick: onAddSnippet }, { key: 'snip-edit', label: 'Edit snippets…', onClick: onEditSnippets });
    items.push({ key: 'snippets', label: 'Prompt snippets', children: rows });
  }
  if (priority && sessions.length && onPin) {
    const who = (s) => s.name + (sessions.filter((x) => x.name === s.name).length > 1 ? ' (' + s.agentName + ')' : '');
    const kids = sessions.map((s, i) => {
      const rows = [{ key: 'pin:' + i, label: 'High priority', toggle: 'checkmark', checked: priority.pins[s.key] !== undefined, onClick: () => onPin(s) }];
      if (s.cwd && s.cwd.startsWith('/')) rows.push({ key: 'pinf:' + i, label: 'High priority for everything in this folder', toggle: 'checkmark', checked: priority.folders[priorityMod.normalize(s.cwd)] !== undefined, onClick: () => onPinFolder(s) });
      const earlier = priorityMod.canMove(s.key, -1, sessions, priority.pins, priority.folders), later = priorityMod.canMove(s.key, 1, sessions, priority.pins, priority.folders);
      rows.push({ key: 'sep-mv:' + i, separator: true });
      rows.push({ key: 'mvup:' + i, label: 'Move earlier', enabled: earlier, onClick: earlier ? () => onMove(s, -1) : undefined });
      rows.push({ key: 'mvdn:' + i, label: 'Move later', enabled: later, onClick: later ? () => onMove(s, 1) : undefined });
      return { key: 'prio:' + i, label: (high(s) ? '★ ' : '') + who(s), children: rows };
    });
    items.push({ key: 'priority', label: 'Priority and order', children: kids });
  }
  if (onOpenFolder || onOpenTranscript || onOpenData) {
    const whoOf = (s) => s.name + (sessions.filter((x) => x.name === s.name).length > 1 ? ' (' + s.agentName + ')' : '');
    const rows = [];
    if (onOpenFolder) sessions.forEach((s, i) => { if (s.cwd && s.cwd.startsWith('/')) rows.push({ key: 'open:folder:' + i, label: 'Folder · ' + whoOf(s), onClick: () => onOpenFolder(s.cwd) }); });
    if (onOpenTranscript) sessions.forEach((s, i) => { if (s.transcriptPath) rows.push({ key: 'open:transcript:' + i, label: 'Transcript · ' + whoOf(s), onClick: () => onOpenTranscript(s.transcriptPath) }); });
    if (rows.length && onOpenData) rows.push({ key: 'sep-open', separator: true });
    if (onOpenData) rows.push({ key: 'open:data', label: 'Votive Dots data folder (~/.votive)', onClick: onOpenData });
    items.push({ key: 'open', label: 'Open', children: rows });
  }
  if (ports) items.push(portsItem(ports, onEditPorts, onPortAction));
  const copyRows = [];
  if (onCopy) {
    sessions.forEach((s, i) => {
      const who = s.name + (sessions.filter((x) => x.name === s.name).length > 1 ? ' (' + s.agentName + ')' : '');
      if (s.cwd) copyRows.push({ key: 'copy:path:' + i, label: 'Folder path · ' + who, onClick: () => onCopy(s.cwd) });
      if (s.sessionId) copyRows.push({ key: 'copy:id:' + i, label: 'Session ID · ' + who, onClick: () => onCopy(s.sessionId) });
    });
  }
  if (copyRows.length) items.push({ key: 'copy', label: 'Copy', children: copyRows });
  if (onToggle) {
    const switches = TOGGLES.map(([name, label]) => ({
      key: 'set:' + name, label, toggle: 'checkmark', checked: settings[name] === undefined ? TOGGLE_DEFAULTS[name] : settings[name] === true,
      onClick: () => onToggle(name),
    }));
    if (priority && onOnlyPriority) switches.push({ key: 'set:alertsOnlyPriority', label: 'Only alert for high-priority sessions', toggle: 'checkmark', checked: priority.onlyPriority === true, onClick: onOnlyPriority });
    items.push({ key: 'settings', label: 'Settings', children: switches });
  }
  if (onAbout) items.push({ key: 'about', label: 'About Votive Dots', onClick: onAbout });
  items.push({ key: 'quit', label: 'Quit Votive Dots', onClick: onQuit });
  if (!compact) return items;
  // a shorter menu: the less used items go under one "More" row, so the menu does not run off a short screen (GNOME opens sub-menus inline)
  const MORE = ['priority', 'open', 'copy', 'about'];
  const moved = items.filter((it) => MORE.includes(it.key));
  if (!moved.length) return items;
  const out = [];
  for (const it of items) {
    if (MORE.includes(it.key)) continue;
    if (it.key === 'settings') { out.push(it); out.push({ key: 'more', label: 'More', children: moved }); continue; }
    out.push(it);
  }
  if (!out.some((it) => it.key === 'more')) out.splice(out.length - 1, 0, { key: 'more', label: 'More', children: moved });
  return out;
}

const ABOUT_TEXT = 'Shows the live status of your AI coding-agent sessions (Claude Code, Codex, Gemini CLI and more) as coloured dots. Click a session to jump to its terminal. It only reads local files and sends nothing over a network. MIT licensed. Not affiliated with any agent\'s maker.';
const ALL_PORTS_SHOWN = 40;
/**
 * The Ports list: the watched ports (what is using each), then everything that listens, then a way to edit the watch list.
 * `ports` = { watched: [numbers], rows: inspected listeners, undefined before the first scan, null when /proc could not be read, home }. Read-only: no stop or pause.
 */
function portsItem({ watched, rows, home, agentPids }, onEditPorts, onPortAction) {
  const kids = [];
  if (rows === undefined) {
    kids.push({ key: 'ports-reading', label: 'Reading the listening ports…', enabled: false });
  } else if (rows === null) {
    kids.push({ key: 'ports-unreadable', label: "Couldn't read the listening ports", enabled: false });
  } else {
    kids.push({ key: 'ports-head', label: watched.length ? 'Watched ports' : 'No watched ports yet', enabled: false });
    for (const port of watched) {
      const mine = rows.filter((r) => r.listener.port === port);
      const first = mine[0];
      let second = '';
      if (first && first.listener.pid > 0) second = '\n' + INDENT + [first.folder ? portsMod.tildePath(first.folder, home) : null, first.listener.localOnly ? 'this computer only' : 'other devices can reach it'].filter(Boolean).join('  ·  ');
      const label = (first ? '🟠' : '⚪') + '  ' + portsMod.rowTitle(port, mine.map((r) => r.listener), mine.some((r) => r.paused)) + second;
      const acts = first && first.listener.pid > 0 && onPortAction ? portActions.offers(first, { agentPids: agentPids || new Set() }) : [];
      if (!acts.length) { kids.push({ key: 'port:' + port, label }); continue; }
      // a program of yours holds the port: the row opens to what is known about it and what may be done (each action asks first)
      const sub = portsMod.details(first, home).map((t, i) => ({ key: 'port:' + port + ':d' + i, label: t, enabled: false }));
      sub.push({ key: 'port:' + port + ':sep', separator: true });
      for (const a of acts) sub.push({ key: 'port:' + port + ':' + a.action, label: a.label, onClick: () => onPortAction(a.action, first) });
      kids.push({ key: 'port:' + port, label, children: sub });
    }
    kids.push({ key: 'sep-ports', separator: true });
    const all = rows.map((r) => ({ key: 'all:' + r.listener.port + ':' + r.listener.pid, label: portsMod.allPortsTitle(r) }));
    const shown = all.slice(0, ALL_PORTS_SHOWN);
    if (all.length > shown.length) shown.push({ key: 'all-more', label: '… and ' + (all.length - shown.length) + ' more', enabled: false });
    kids.push({ key: 'all-ports', label: 'All listening ports (' + rows.length + ')', children: shown.length ? shown : [{ key: 'all-none', label: 'Nothing is listening', enabled: false }] });
  }
  kids.push({ key: 'sep-ports2', separator: true }, { key: 'ports-edit', label: 'Edit ports file…', onClick: onEditPorts });
  return { key: 'ports', label: 'Ports', children: kids };
}

/** One line per session for the tooltip. */
function tooltipLines(sessions, now = Date.now(), usage = null, heat = null) {
  const hot = usageMod.lines(usage, { nowMs: now }).filter((u) => u.hot).map((u) => '⚠ ' + u.short);
  if (heat && heat.hot) hot.push('⚠ CPU ' + Math.round(heat.c) + '°');
  return hot.concat(sessions.map((s) => s.agentName + ' · ' + s.name + ': ' + s.label + ' (' + ago(now - s.lastActivityAt) + ')'));
}

/** The settings as plain {name: value}. Falls back to the defaults when the file is unreadable. */
function plainSettings(read) {
  try {
    const out = {};
    for (const [name, v] of Object.entries(read())) out[name] = v && typeof v === 'object' && 'value' in v ? v.value : v;
    return out;
  } catch (e) { return {}; }
}

/** A reader that parses the settings file again only when it changed (the tray looks every two seconds). */
function cachedSettings(read, file) {
  let key = null, value = {};
  const get = () => {
    let k = 'missing';
    try { const st = fs.statSync(file); k = st.mtimeMs + ':' + st.size; } catch (e) { /* no file: the defaults */ }
    if (k !== key) { value = plainSettings(read); key = k; }
    return value;
  };
  get.invalidate = () => { key = null; };   // after we write a setting ourselves: do not trust the modification time
  return get;
}

// The variables of the desktop session that "Go to terminal" needs. A service that starts at boot can start before the desktop has
// put them into the user manager (on a Wayland login it always does), so they are read from the manager when they are needed, not
// only from this process's own environment.
const DESKTOP_VARS = ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP'];
/** The desktop variables in the text of `systemctl --user show-environment`. Values with quoting are skipped, not interpreted. */
function parseEnvironment(text) {
  const vars = {};
  for (const line of String(text).split('\n')) {
    const m = /^([A-Z_]+)=([^'"$\\]*)$/.exec(line);
    if (m && DESKTOP_VARS.includes(m[1])) vars[m[1]] = m[2];
  }
  return vars;
}

function readUserEnvironment(cb) {
  const { execFile } = require('child_process');
  const e = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '', DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '' };
  execFile('/usr/bin/systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 3000, env: e }, (err, out) => cb(err ? {} : parseEnvironment(out)));
}

const stuckMinutesOf = (cfg) => (Number.isInteger(cfg.stuckThresholdMinutes) ? cfg.stuckThresholdMinutes : 8);

/** Starts the tray. Returns { stop() }. `opts` lets tests point it at a private bus and folder. */
async function start(opts = {}) {
  const env = opts.env || process.env;
  const eventsDir = opts.eventsDir || path.join(votiveRoot(env), 'events');
  const read = opts.readSettings || (() => require('../Scripts/overlay-settings').getSettings());
  const settingsNow = cachedSettings(read, path.join(votiveRoot(env), 'settings.json'));
  const conn = await new Connection(opts.address || sessionAddress(env)).connect();
  if (!(await conn.requestName(BUS_NAME))) {
    conn.close();
    const e = new Error('Votive Dots is already running in this session');
    e.alreadyRunning = true;
    throw e;
  }
  const tracker = new SessionTracker({ eventsDir, stuckMinutes: stuckMinutesOf(settingsNow()) });
  const heatWatch = new heatMod.HeatWatch();
  const priority = opts.priority || new priorityMod.PriorityStore(votiveRoot(env));
  const alerter = new Alerter({ conn, settings: settingsNow, gate: (sess) => { const v = priority.read(); return priorityMod.shouldAlert(sess, v.onlyPriority, v.pins, v.folders); }, play: opts.play || makePlayer({ soundsDir: path.join(votiveRoot(env), 'sounds') }) });
  let stopped = false;
  let last = Date.now();
  const keepAwake = opts.keepAwake || new KeepAwake({ onChange: () => { if (!stopped) refresh(); } });
  const updateSettings = opts.updateSettings || ((c) => require('../Scripts/overlay-settings').updateSettings(c));
  const prefs = opts.prefs || new PrefsStore(votiveRoot(env));
  const toggle = (name) => {
    if (prefs.isKnown(name)) { try { prefs.toggle(name); } catch (e) { onFocusFailed(e.message, 'Votive Dots could not save that'); } refresh(); return; }
    try { updateSettings({ [name]: !(settingsNow()[name] === undefined ? TOGGLE_DEFAULTS[name] : settingsNow()[name] === true) }); } catch (e) { /* unreadable settings: nothing to flip */ }
    settingsNow.invalidate();
    refresh();
  };
  let sessions = [];

  const tray = new Tray(conn, { title: 'Votive Dots' });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearInterval(envTimer);
    if (watcher) watcher.close();
    keepAwake.stop();
    if (windowHost) windowHost.close();
    if (mainHost) mainHost.close();
    tray.stop();
    conn.close();
    if (opts.onStop) opts.onStop();
  };

  const liveEnv = Object.assign({}, env);
  let envTimer = null;
  const loadEnv = () => (opts.readEnv || readUserEnvironment)((vars) => {
    if (stopped) return;
    const before = JSON.stringify(DESKTOP_VARS.map((k) => liveEnv[k]));
    Object.assign(liveEnv, vars);
    if (JSON.stringify(DESKTOP_VARS.map((k) => liveEnv[k])) !== before) refresh();
  });
  const focusSession = opts.focusSession || ((sess) => focus.focusSession(sess, { env: liveEnv }));
  const copy = opts.copyText || ((text) => actions.copyText(text, { env: liveEnv }));
  const snippetsRoot = votiveRoot(env);
  const readClipboard = opts.readClipboard || (() => actions.readText({ env: liveEnv }));
  const openTranscript = opts.openTranscript || ((f) => actions.openTranscript(f, { env: liveEnv }));
  const openBrowser = opts.openBrowser || ((f) => actions.openInBrowser(f, { env: liveEnv }));
  const openFolder = opts.openFolder || ((d) => actions.openFolder(d, { env: liveEnv }));
  const openFile = opts.openFile || ((f) => actions.openFile(f, { env: liveEnv }));
  const addSnippetFromClipboard = () => {
    readClipboard().then((r) => {
      if (!r.ok) return onFocusFailed(r.why, 'Votive Dots could not read the clipboard');
      const res = snippetsMod.add(snippetsRoot, r.text);
      if (res === 'unreadable') onFocusFailed('Nothing was added and your file was left as it is. Fix it with Edit snippets… (a list of quoted strings separated by commas).', "The snippets file isn't valid JSON");
      else if (res === 'empty') onFocusFailed('The clipboard has no text to add.', 'Votive Dots could not add a snippet');
      else if (res === 'duplicate') onFocusFailed('That snippet is already in the list.', 'Votive Dots did not add a snippet');
      refresh();
    });
  };
  const editSnippets = () => {
    try { snippetsMod.ensureFile(snippetsRoot); } catch (e) { return onFocusFailed(e.message, 'Votive Dots could not create the snippets file'); }
    openFile(snippetsMod.fileOf(snippetsRoot)).then((r) => { if (!r.ok) onFocusFailed(r.why, 'Votive Dots could not open the snippets file'); });
  };
  let portRows, portsAt = 0, portsBusy = false;   // portRows: undefined before the first scan, null when ss could not be read
  const portsOn = () => prefs.read().portToolsOn === true;
  const scanPorts = () => {
    if (portsBusy || stopped) return;
    portsBusy = true;
    (opts.scanPorts || (() => portsMod.scan().then((l) => (l === null ? null : portsMod.inspect(l)))))().then((rows) => {
      portsBusy = false; portsAt = Date.now();
      if (stopped) return;
      portRows = rows;
      refresh();
    }, () => { portsBusy = false; portsAt = Date.now(); });
  };
  const doPortAction = (action, row) => {
    const sendNote = (title, body) => alerter.sendNotification({ key: 'ports', kind: 'info', title, body, urgency: 1 });
    portActions.run(action, row, { agentPids: new Set(sessions.map((x) => x.pid).filter((p) => p > 0)), env: liveEnv, ...(opts.portActionDeps || {}) }).then((r) => {
      if (r.cancelled) return;
      sendNote(r.ok ? 'Votive Dots: done' : 'Votive Dots could not do that', r.message);
      portsAt = 0; scanPorts();
    });
  };
  const openReport = () => {
    let file;
    try { file = reportMod.write(reportMod.reportDir(env), reportMod.buildReport(reportMod.gather({ eventsSessions: sessions, usageDir, priority: priority.read(), now: Date.now() }))); }
    catch (e) { return onFocusFailed(e.message, 'Votive Dots could not make the report'); }
    openBrowser(file).then((r) => { if (!r.ok) onFocusFailed(r.why, 'Votive Dots could not open the report'); });
  };
  // the popup window (an optional GTK helper): what it shows, and what it may ask us to do
  const windowState = () => {
    const now = Date.now();
    const pv = priority.read();
    const u = usageMod.readUsage(usageDir, now);
    const usageRows = [];
    if (u) for (const a of u.agents) for (const w of a.windows) usageRows.push({ name: a.agentName + ' · ' + w.label, pct: Math.round(w.usedPercentage), resets: usageMod.resetText(w.resetsAtMs, now) });
    return {
      title: 'Votive Dots', icons: windowIcons(prefs.palette()), keepAwake: keepAwake.isOn, summary: summaryLine(sessions), usage: usageRows,
      sessions: sessions.map((s) => ({ key: s.key, name: s.name, agent: s.agentName, state: s.state, label: s.label, prompt: s.prompt || '', age: ago(now - s.lastActivityAt), high: priorityMod.isHighPriority(s, pv.pins, pv.folders) })),
    };
  };
  const windowHost = opts.windowHost || new WindowHost(Object.assign({ env: liveEnv, onAction: (a) => {
    if (a.t === 'report') return openReport();
    if (a.t === 'keepawake') { keepAwake.toggle(); refresh(); return; }
    const sess = sessions.find((x) => x.key === a.key);
    if (!sess) return;
    if (a.t === 'focus') focusSession(sess).then((r) => { if (!r.ok) onFocusFailed(r.why); });
    if (a.t === 'pin') { try { priority.toggle(sess.key); } catch (e) { onFocusFailed(e.message, 'Votive Dots could not save that'); } refresh(); }
  } }, opts.windowHostOpts || {}));
  const openWindow = () => { windowHost.open(windowState()).then((r) => { if (!r.ok) onFocusFailed(r.why, 'Votive Dots could not open its window'); }); };

  // ---- the main window: sidebar pages, settings and an insights card (linux/ui/votive-main.py)
  let lastHeat = null;
  let histCache = { at: 0, v: { samples: [] } };
  const readHistory = () => {
    try {
      const samples = require('../Scripts/usage-history').read('claude-code');
      if (!samples.length) return { samples: [] };
      const h = require('../Scripts/usage-habits'), p = require('../Scripts/usage-pacing');
      return { samples, analysis: h.analyse(samples, { target: 80 }), use: h.hourlyUse(samples), pacing: p.format(p.advise(samples, { target: 80, conserve: 85 })) };
    } catch (e) { return { samples: [] }; }   // a missing or broken history: the pages say so
  };
  const historyNow = (now) => { if (now - histCache.at > 30000) histCache = { at: now, v: readHistory() }; return histCache.v; };
  const agentList = () => {
    try {
      const IA = require('../Scripts/install-agents'), AD = require('../Scripts/agents').ADAPTERS;
      return Object.keys(IA.AGENTS).map((id) => ({ id, name: (AD[id] && AD[id].name) || id, detected: !!IA.detected(IA.AGENTS[id]) }));
    } catch (e) { return []; }
  };
  const mainWindowState = () => {
    const now = Date.now();
    const h = historyNow(now);
    const pv = priority.read();
    return mainState.buildMainState({
      now, sessions, icons: windowIcons(prefs.palette()), usage: usageMod.readUsage(usageDir, now), priority: pv, analysis: h.analysis || null, pacing: h.pacing || null,
      use: h.use || null, samples: h.samples, settings: Object.assign({}, settingsNow(), prefs.read(), { dotPalette: palettes.nameOfId(prefs.palette()) }), keepAwake: keepAwake.isOn, heat: lastHeat, summary: summaryLine(sessions),
      version: (() => { try { return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim().slice(0, 20); } catch (e) { return ''; } })(), agents: agentList(),
    });
  };
  const applySetting = ({ name, value }) => {
    try {
      if (name === 'portToolsOn') { if ((prefs.read().portToolsOn === true) !== value) prefs.toggle('portToolsOn'); }
      else if (name === 'alertsOnlyPriority') priority.setOnlyPriority(value);
      else if (name === 'dotPalette') prefs.setPalette(palettes.idOfName(value));
      else { updateSettings({ [name]: value }); settingsNow.invalidate(); }
    } catch (e) { onFocusFailed(e.message, 'Votive Dots could not save that'); }
    refresh();
  };
  const moveSession = (key, delta) => {
    try {
      let shown = sessions;
      for (let i = 0; i < Math.abs(delta); i++) {
        const v = priority.read();
        const next = priorityMod.moved(key, delta < 0 ? -1 : 1, shown, v.pins, v.folders, v.positions);
        if (!next) break;
        priority.setPositions(next);
        shown = priorityMod.order(shown, v.pins, v.folders, next);
      }
    } catch (e) { onFocusFailed(e.message, 'Votive Dots could not save that'); }
    refresh();
  };
  const mainHost = opts.mainHost || new MainWindowHost(Object.assign({ env: liveEnv, onAction: (a) => {
    if (a.t === 'report') return openReport();
    if (a.t === 'keepawake') { keepAwake.toggle(); refresh(); return; }
    if (a.t === 'set') return applySetting(a);
    if (a.t === 'move') return moveSession(a.key, a.delta);
    const sess = sessions.find((x) => x.key === a.key);
    if (!sess) return;
    if (a.t === 'focus') focusSession(sess).then((r) => { if (!r.ok) onFocusFailed(r.why); });
    if (a.t === 'pin') { try { priority.toggle(sess.key); } catch (e) { onFocusFailed(e.message, 'Votive Dots could not save that'); } refresh(); }
  } }, opts.mainHostOpts || {}));
  const openMain = (page) => { mainHost.openPage(mainWindowState(), page).then((r) => { if (!r.ok) onFocusFailed(r.why, 'Votive Dots could not open its window'); }); };
  const editPorts = () => {
    try { portsMod.ensureFile(snippetsRoot); } catch (e) { return onFocusFailed(e.message, 'Votive Dots could not create the ports file'); }
    openFile(portsMod.fileOf(snippetsRoot)).then((r) => { if (!r.ok) onFocusFailed(r.why, 'Votive Dots could not open the ports file'); });
  };
  const onFocusFailed = opts.onFocusFailed || ((why, title = 'Votive Dots could not go to that terminal') => alerter.sendNotification({ key: 'focus', kind: 'info', title, body: why, urgency: 1 }));
  const usageDir = opts.usageDir || path.join(votiveRoot(env), 'usage');
  const refresh = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - last > WAKE_GAP_MS) tracker.noteWake(now);
    last = now;
    const cfg = Object.assign({}, settingsNow(), prefs.read());   // the switches that agents cannot set come from this tray's own file
    tracker.stuckMs = stuckMinutesOf(cfg) * 60000;
    const pv = priority.read();
    sessions = priorityMod.order(tracker.scan(now), pv.pins, pv.folders, pv.positions);
    try { priority.prune(new Set(sessions.map((x) => x.key)), now / 1000); } catch (e) { /* a read-only folder: the pins stay */ }
    alerter.observe(sessions);
    const usage = usageMod.readUsage(usageDir, now);
    const portsWanted = cfg.portToolsOn === true;
    if (portsWanted && now - portsAt > 10000) scanPorts();
    const heat = lastHeat = heatWatch.look({ enabled: cfg.cpuHeatWarning === true, line: Number.isInteger(cfg.cpuHeatWarningAt) ? cfg.cpuHeatWarningAt : 95 }, now);
    const palette = prefs.palette();
    const textRow = labelWanted(liveEnv) && cfg.colorblindShapes !== true && palettes.isDefault(palette);   // coloured dots as text cannot carry the shapes: those people keep the drawn row
    tray.update({
      colors: palettes.overrides(palette),
      states: sessions.map((s) => s.state), label: textRow ? sessions.map((s) => EMOJI[s.state] || '').join('') : '', tooltipLines: tooltipLines(sessions, now, usage, heat).concat(keepAwake.isOn ? ['Keep awake is on'] : []), shapes: cfg.colorblindShapes === true,
      badge: (cfg.usagePulse !== false && usageMod.overThreshold(usage)) || heat.hot,
      attention: sessions.some((s) => s.state === 'needsInput'),
    });
    tray.menu.setItems(buildMenu(sessions, { now, icons: true, compact: true, usage, heat, palette, shapes: cfg.colorblindShapes === true, settings: cfg, keepAwake: keepAwake.isOn, snippets: snippetsMod.load(snippetsRoot), priority: priority.read(), onPin: (sess) => { try { priority.toggle(sess.key); } catch (e) { onFocusFailed(e.message, 'Votive Dots could not save that'); } refresh(); }, onPinFolder: (sess) => { try { priority.toggleFolder(sess.cwd); } catch (e) { onFocusFailed(e.message, 'Votive Dots could not save that'); } refresh(); }, onMove: (sess, delta) => { try { const v = priority.read(); const next = priorityMod.moved(sess.key, delta, sessions, v.pins, v.folders, v.positions); if (next) priority.setPositions(next); } catch (e) { onFocusFailed(e.message, 'Votive Dots could not save that'); } refresh(); }, onOnlyPriority: () => { try { priority.setOnlyPriority(!priority.read().onlyPriority); } catch (e) { onFocusFailed(e.message, 'Votive Dots could not save that'); } refresh(); },
      onOpenFolder: (dir) => { openFolder(dir).then((r) => { if (!r.ok) onFocusFailed(r.why, 'Votive Dots could not open that folder'); }); },
      onOpenTranscript: (file) => { openTranscript(file).then((r) => { if (!r.ok) onFocusFailed(r.why, 'Votive Dots could not open that transcript'); }); },
      onOpenData: () => { openFolder(votiveRoot(env)).then((r) => { if (!r.ok) onFocusFailed(r.why, 'Votive Dots could not open its data folder'); }); },
      onAbout: () => onFocusFailed(ABOUT_TEXT, 'Votive Dots for Linux'),
      ports: portsWanted ? { watched: portsMod.loadWatch(snippetsRoot), rows: portRows, home: os.homedir(), agentPids: new Set(sessions.map((x) => x.pid).filter((p) => p > 0)) } : null, onPortAction: doPortAction, onOpenWindow: openWindow, onOpenMain: () => openMain('overview'), onOpenReport: openReport, onEditPorts: editPorts, onCopySnippet: (text) => { copy(text).then((r) => { if (!r.ok) onFocusFailed(r.why, 'Votive could not copy that'); }); }, onAddSnippet: addSnippetFromClipboard, onEditSnippets: editSnippets, onToggle: toggle, onCopy: (text) => { copy(text).then((r) => { if (!r.ok) onFocusFailed(r.why, 'Votive could not copy that'); }); }, onFocus: (sess) => { focusSession(sess).then((r) => { if (!r.ok) onFocusFailed(r.why); }); }, onKeepAwake: () => { keepAwake.toggle(); refresh(); }, onQuit: () => setTimeout(stop, 50).unref() }));
    if (windowHost.isOpen) windowHost.update(windowState());
    if (mainHost.isOpen) mainHost.update(mainWindowState());
    if (opts.onRefresh) opts.onRefresh(sessions);
  };

  tray.on('activate', () => openWindow());   // a host that sends a plain click to the icon (KDE and others) gets the window; GNOME opens the menu instead
  tray.menu.onAboutToShow = () => { loadEnv(); if (portsOn()) scanPorts(); const before = tray.menu._sig; refresh(); return tray.menu._sig !== before; };
  conn.on('close', () => { if (!stopped) { stopped = true; clearInterval(timer); if (watcher) watcher.close(); if (opts.onStop) opts.onStop(new Error('lost the D-Bus session')); } });
  refresh();
  await tray.start();
  loadEnv();
  // until the desktop's display is known, ask the user manager again every 15 s (a login that is still starting)
  envTimer = setInterval(() => { if (liveEnv.DISPLAY || liveEnv.WAYLAND_DISPLAY) clearInterval(envTimer); else loadEnv(); }, 15000);
  envTimer.unref();

  const timer = setInterval(refresh, POLL_MS);
  let watcher = null;
  let debounce = null;
  try {
    watcher = fs.watch(eventsDir, () => { clearTimeout(debounce); debounce = setTimeout(refresh, 120); });
    watcher.on('error', () => { /* the folder went away: the poll keeps working */ });
  } catch (e) { /* no folder yet: the poll picks sessions up when it appears */ }
  return { stop, refresh, tray, conn, sessions: () => sessions };
}

async function main(argv) {
  if (argv.includes('--print')) {
    const cfg = plainSettings(() => require('../Scripts/overlay-settings').getSettings());
    const tracker = new SessionTracker({ eventsDir: path.join(votiveRoot(), 'events'), stuckMinutes: stuckMinutesOf(cfg) });
    const sessions = tracker.scan();
    console.log(JSON.stringify({ overall: overallState(sessions), sessions }, null, 2));
    return;
  }
  try {
    const app = await start({ onStop: (err) => { if (err) { console.error(err.message); process.exit(1); } process.exit(0); } });
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, app.stop);
  } catch (e) {
    if (e.alreadyRunning) { console.error(e.message); process.exit(0); }
    console.error('Votive Dots could not start: ' + e.message);
    process.exit(1);
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { start, buildMenu, labelWanted, parseEnvironment, TOGGLES, tooltipLines, votiveRoot, BUS_NAME, EMOJI, GLYPH, LABELS, ATTENTION };
