'use strict';
//
// High priority and the hand-set order on Linux (linux/priority.js, a port of the Mac's SessionPriority.swift), the "only alert for high priority" gate
// (linux/alerts.js) and the menu rows (linux/votive-tray.js buildMenu). The file store is tested in a scratch folder.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../linux/priority');
const { Alerter } = require('../linux/alerts');
const app = require('../linux/votive-tray');

const s = (key, startedAt, cwd = '/') => ({ key, agent: 'claude-code', agentName: 'Claude Code', sessionId: key, name: key, cwd, state: 'working', label: 'working', startedAt, lastActivityAt: startedAt, prompt: null });
const ids = (x) => x.map((e) => e.key).join(',');
const all = [s('a', 1), s('b', 2), s('c', 3), s('d', 4)];

test('order: pinned sessions come first, in pin order; the rest keep theirs; ties fall back to start time then key', () => {
  assert.equal(ids(R.order(all, {})), 'a,b,c,d');
  assert.equal(ids(R.order(all, { c: 100 })), 'c,a,b,d');
  assert.equal(ids(R.order(all, { d: 50, b: 100 })), 'd,b,a,c');
  assert.equal(ids(R.order(all, { d: 200, b: 100 })), 'b,d,a,c');
  assert.equal(ids(R.order(all, { zzz: 1 })), 'a,b,c,d');
  assert.equal(ids(R.order(all, { d: 10, c: 10 })), 'c,d,a,b');
});

test('folder rules: every session started in a marked folder is high priority, a sub-folder is not, a trailing slash does not matter', () => {
  const fs2 = [s('a', 1, '/p/a'), s('b', 2, '/p/b'), s('c', 3, '/p/b/'), s('d', 4, '/p/d'), s('e', 5, '')];
  assert.equal(ids(R.order(fs2, {}, { '/p/b': 100 })), 'b,c,a,d,e');
  assert.equal(ids(R.order(fs2, { d: 50 }, { '/p/b': 100 })), 'd,b,c,a,e');
  assert.equal(ids(R.order([s('x', 1, '/p/b/inner'), s('y', 2, '/p/b')], {}, { '/p/b': 1 })), 'y,x');
  assert.equal(R.normalize('/p/b/'), '/p/b');
  assert.equal(R.normalize('/p/b//'), '/p/b');
  assert.equal(R.normalize('/'), '/');
  assert.equal(R.normalize('  /x  '), '/x');
});

test('hand-set order: placed sessions first inside each group, and it never moves a session between the two groups', () => {
  assert.equal(ids(R.order(all, {}, {}, ['c', 'a'])), 'c,a,b,d');
  assert.equal(ids(R.order(all, { d: 1 }, {}, ['c', 'b', 'd'])), 'd,c,b,a');       // d is pinned: stays first whatever the order says
  assert.equal(ids(R.order(all, {}, {}, ['zzz', 'b'])), 'b,a,c,d');
});

test('move: one step inside the group, null at an end or across the group line; the stored order lists the shown sessions then older entries', () => {
  assert.deepEqual(R.moved('b', -1, all, {}), ['b', 'a', 'c', 'd']);
  assert.deepEqual(R.moved('b', 1, all, {}, {}, ['old']), ['a', 'c', 'b', 'd', 'old']);
  assert.equal(R.moved('a', -1, all, {}), null);
  assert.equal(R.moved('d', 1, all, {}), null);
  assert.equal(R.moved('zzz', 1, all, {}), null);
  assert.equal(R.moved('b', 0, all, {}), null);
  const shown = R.order(all, { c: 5 });                                              // c,a,b,d
  assert.equal(R.moved('c', 1, shown, { c: 5 }), null);                              // the pinned one cannot step below the line
  assert.equal(R.moved('a', -1, shown, { c: 5 }), null);                             // nor the others above it
  assert.equal(R.canMove('b', -1, shown, { c: 5 }), true);
});

test('alert gate: everything alerts unless "only high priority" is on; then only pinned or folder-marked sessions', () => {
  assert.equal(R.shouldAlert(all[0], false, {}), true);
  assert.equal(R.shouldAlert(all[0], true, {}), false);
  assert.equal(R.shouldAlert(all[0], true, { a: 5 }), true);
  assert.equal(R.shouldAlert(all[1], true, { a: 5 }), false);
  assert.equal(R.shouldAlert(s('f', 1, '/p/b'), true, {}, { '/p/b': 1 }), true);
});

test('clean: bad keys, times and shapes are dropped; over the cap the newest stay; folders must be absolute', () => {
  assert.deepEqual(Object.keys(R.clean({ ok: 5, '': 1, neg: -3, zero: 0, str: 'x', nan: NaN, inf: Infinity, ['x'.repeat(301)]: 2, int: 7 })).sort(), ['int', 'ok']);
  assert.deepEqual(R.clean('nope'), {}); assert.deepEqual(R.clean(null), {}); assert.deepEqual(R.clean([1, 2]), {});
  const big = Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['k' + (i + 1), i + 1]));
  const c = R.clean(big);
  assert.equal(Object.keys(c).length, 50);
  assert.ok(c.k80 !== undefined && c.k30 === undefined && c.k31 !== undefined);
  assert.deepEqual(Object.keys(R.cleanFolders({ '/ok': 5, 'relative/path': 5, '': 1, '/neg': -1 })), ['/ok']);
  assert.deepEqual(R.cleanOrder(['a', 'a', '', 7, 'b', 'x'.repeat(301)]), ['a', 'b']);
  assert.equal(R.cleanOrder(Array.from({ length: 150 }, (_, i) => 'k' + i)).length, 100);
});

test('prune: pins of running sessions stay, recent ones of sessions that are gone stay for two weeks, older ones go', () => {
  const now = 2000000, day = 86400;
  const p = { live: 1, recent: now - 13 * day, old: now - 15 * day, fresh: now - 5 };
  assert.deepEqual(Object.keys(R.pruned(p, new Set(['live']), now)).sort(), ['fresh', 'live', 'recent']);
});

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'votive-prio-'));

test('store: pin, folder rule, order and the alert switch are saved in a private file; a broken or huge file is "nothing set" and is replaced by the next write', () => {
  const root = scratch();
  const st = new R.PriorityStore(root);
  assert.deepEqual(st.read(), { pins: {}, folders: {}, positions: [], onlyPriority: false });
  assert.equal(st.toggle('claude-code:x', 1000), true);
  assert.equal(st.read().pins['claude-code:x'], 1000);
  assert.equal(st.toggleFolder('/p/b/', 2000), true);
  assert.deepEqual(st.read().folders, { '/p/b': 2000 });
  assert.equal(st.toggleFolder('relative', 1), false);
  st.setPositions(['b', 'a']); st.setOnlyPriority(true);
  assert.deepEqual(new R.PriorityStore(root).read(), { pins: { 'claude-code:x': 1000 }, folders: { '/p/b': 2000 }, positions: ['b', 'a'], onlyPriority: true });
  assert.equal(fs.statSync(path.join(root, 'priority.json')).mode & 0o777, 0o600);
  assert.equal(st.toggle('claude-code:x'), false);
  assert.deepEqual(st.read().pins, {});
  st.toggle('live', 5); st.toggle('gone', 1);
  st.prune(new Set(['live']), 1 + R.KEEP_SECONDS + 10);
  assert.deepEqual(Object.keys(st.read().pins), ['live']);
  fs.writeFileSync(path.join(root, 'priority.json'), '{ not json');
  const broken = new R.PriorityStore(root);
  assert.deepEqual(broken.read().pins, {});
  broken.toggle('k', 1);
  assert.deepEqual(Object.keys(broken.read().pins), ['k']);
  fs.writeFileSync(path.join(root, 'priority.json'), JSON.stringify({ pins: { big: 1 }, pad: 'x'.repeat(70000) }));
  assert.deepEqual(new R.PriorityStore(root).read().pins, {});
});

test('alerter: with the gate on, a state change of an ungated session makes no banner or sound, a requested message still does', () => {
  const raised = [];
  const settings = () => ({ bannerOnEveryChange: true, sounds: true, notifyOnRequest: true, soundDone: 'Glass' });
  const a = new Alerter({ conn: null, settings, play: () => true, notify: (n) => raised.push(n.key + ':' + n.kind), gate: (x) => x.key === 'pinned', now: () => 1000000 });
  const mk = (state, extra = {}) => ['pinned', 'other'].map((k) => Object.assign(s(k, 1), { state, notifyMessage: null, notifyAt: null }, extra));
  a.observe(mk('working'));
  const r = a.observe(mk('done'));
  assert.deepEqual(r.map((x) => x.key).sort(), ['pinned']);
  assert.deepEqual(raised.filter((x) => x.endsWith(':done')), ['pinned:done']);
  raised.length = 0;
  a.observe(mk('done', { notifyMessage: 'Ready?', notifyAt: 999999 }));
  assert.ok(raised.includes('other:notify'), 'a message the session was asked to send is not an automatic alert');
});

test('buildMenu: stars on high-priority sessions, a Priority and order item with a switch per session and folder, Move rows only where they can act, and the alert switch', () => {
  const log = [];
  const sess = [s('x', 1, '/p/x'), s('y', 2, '/p/y')];
  const priority = { pins: { x: 5 }, folders: { '/p/y': 7 }, positions: [], onlyPriority: true };
  const rows = app.buildMenu(sess, { priority, onPin: (e) => log.push('pin ' + e.key), onPinFolder: (e) => log.push('folder ' + e.key), onMove: (e, d) => log.push('move ' + e.key + ' ' + d), onOnlyPriority: () => log.push('only'), onToggle() {}, onQuit() {} });
  assert.match(rows.find((r) => r.key === 's:0').label, /^🟡  ★ x /);
  assert.match(rows.find((r) => r.key === 's:1').label, /^🟡  ★ y /);                // y is high priority through its folder
  const prio = rows.find((r) => r.key === 'priority');
  const x = prio.children.find((c) => c.key === 'prio:0');
  assert.equal(x.label, '★ x');
  assert.deepEqual(x.children.filter((c) => c.toggle).map((c) => [c.label, c.checked]), [['High priority', true], ['High priority for everything in this folder', false]]);
  assert.equal(x.children.find((c) => c.key === 'mvup:0').enabled, false);          // first of its group
  assert.equal(x.children.find((c) => c.key === 'mvdn:0').enabled, true);
  const y = prio.children.find((c) => c.key === 'prio:1');
  assert.equal(y.children.find((c) => c.key === 'pinf:1').checked, true);
  x.children.find((c) => c.key === 'pin:0').onClick(); x.children.find((c) => c.key === 'pinf:0').onClick(); x.children.find((c) => c.key === 'mvdn:0').onClick();
  const sw = rows.find((r) => r.key === 'settings').children.find((c) => c.key === 'set:alertsOnlyPriority');
  assert.equal(sw.checked, true);
  sw.onClick();
  assert.deepEqual(log, ['pin x', 'folder x', 'move x 1', 'only']);
  const keys = rows.flatMap(function walk(n) { return [n.key, ...(n.children || []).flatMap(walk)]; });
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(app.buildMenu(sess, { onQuit() {} }).some((r) => r.key === 'priority'), false);   // nothing wired: nothing shown
  const dup = app.buildMenu([s('x', 1), Object.assign(s('x2', 2), { name: 'x', agentName: 'Codex' })], { priority: { pins: {}, folders: {}, positions: [], onlyPriority: false }, onPin() {}, onQuit() {} }).find((r) => r.key === 'priority');
  assert.deepEqual(dup.children.map((c) => c.label), ['x (Claude Code)', 'x (Codex)']);
});

test('a reorder reaches a tray host as new text in the same rows: the shape of the menu does not change, so a host that never moves rows still shows the new order', () => {
  const { DbusMenu } = require('../linux/dbus/dbusmenu');
  const a = s('a', 1, '/p/a'), b = s('b', 2, '/p/b');
  const pr = (pins) => ({ pins, folders: {}, positions: [], onlyPriority: false });
  const menu = new DbusMenu();
  const seen = [];
  menu.onChange = (rev, c) => seen.push(c);
  const build = (list, pins) => app.buildMenu(list, { priority: pr(pins), onPin() {}, onFocus() {}, onQuit() {} });
  menu.setItems(build(R.order([a, b], {}), {}));
  const rowId = (k) => menu.ids.get(k);
  const [s0, s1] = [rowId('s:0'), rowId('s:1')];
  menu.setItems(build(R.order([a, b], { b: 5 }), { b: 5 }));                          // b is pinned: it goes first
  const change = seen.at(-1);
  assert.equal(change.layout, false, 'no new layout: the rows stay where they are');
  assert.deepEqual([rowId('s:0'), rowId('s:1')], [s0, s1]);
  const label = (id) => menu.byId.get(id).label;
  assert.match(label(s0), /★ b /);
  assert.match(label(s1), / a /);
  assert.ok(change.updated.some(([id]) => id === s0) && change.updated.some(([id]) => id === s1), 'both rows announce their new text');
});
