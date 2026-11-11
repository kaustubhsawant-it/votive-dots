'use strict';
//
// The pictures on menu rows (linux/png.js, linux/menuicons.js, the `icon-data` property of linux/dbus/dbusmenu.js) and the polished menu layout (icons instead of emoji dots,
// the less used items under "More"). The PNG writer is checked by reading its output back with zlib, the row picture by its pixels.
//
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const png = require('../linux/png');
const MI = require('../linux/menuicons');
const { DbusMenu } = require('../linux/dbus/dbusmenu');
const app = require('../linux/votive-tray');

/** Reads a PNG written by png.encode back: { width, height, rgba }. Only what the writer produces (8-bit RGBA, filter 0, one IDAT). */
function decode(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let pos = 8, width = 0, height = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    assert.equal(buf.readUInt32BE(pos + 8 + len), png.crc32(buf.subarray(pos + 4, pos + 8 + len)), type + ' checksum');
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 6); }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) { assert.equal(raw[y * (width * 4 + 1)], 0); raw.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)); }
  return { width, height, rgba };
}

test('png: a written image reads back pixel for pixel; bad sizes and data are refused; ARGB becomes RGBA', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]);   // 2 x 2
  const back = decode(png.encode(2, 2, rgba));
  assert.equal(back.width, 2); assert.equal(back.height, 2);
  assert.deepEqual([...back.rgba], [...rgba]);
  assert.throws(() => png.encode(0, 2, rgba), /bad size/);
  assert.throws(() => png.encode(2, 2, Buffer.alloc(5)), /bad pixel data/);
  assert.deepEqual([...png.fromArgb(Buffer.from([200, 1, 2, 3]))], [1, 2, 3, 200]);
  assert.equal(png.crc32(Buffer.from('123456789')), 0xcbf43926, 'the standard check value');
});

test('state icons: one picture per state, in the state\'s own colour and shape, small, and cached', () => {
  const colourOf = (buf) => { const { rgba, width, height } = decode(buf); const o = ((height >> 1) * width + (width >> 1)) * 4; return [...rgba.subarray(o, o + 4)]; };
  assert.deepEqual(colourOf(MI.stateIcon('working')).slice(0, 3), [255, 214, 10]);      // the Mac's yellow
  assert.deepEqual(colourOf(MI.stateIcon('done')).slice(0, 3), [48, 209, 88]);
  assert.deepEqual(colourOf(MI.stateIcon('stopped')).slice(0, 3).length, 3);
  const a = MI.stateIcon('needsInput'), b = MI.stateIcon('needsInput');
  assert.equal(a, b, 'cached: the same buffer');
  assert.ok(a.length < 2000 && decode(a).width === 24);
  assert.notDeepEqual([...MI.stateIcon('working', { shapes: true })], [...MI.stateIcon('done', { shapes: true })]);
  const states = ['starting', 'working', 'done', 'needsInput', 'warning', 'stuck', 'stopped'];
  assert.equal(new Set(states.map((s) => MI.stateIcon(s).toString('hex'))).size, 7, 'every state looks different');
});

test('dbusmenu: a row may carry a picture (icon-data, bytes); one that is too big or missing is simply not sent', () => {
  const m = new DbusMenu();
  const img = png.encode(2, 2, Buffer.alloc(16, 255));
  m.setItems([{ key: 'a', label: 'with', icon: img }, { key: 'b', label: 'without' }, { key: 'c', label: 'huge', icon: Buffer.alloc(20000) }]);
  const pa = m.props(m.byId.get(m.ids.get('a')), []), pb = m.props(m.byId.get(m.ids.get('b')), []), pc = m.props(m.byId.get(m.ids.get('c')), []);
  assert.ok(pa.get('icon-data') && pa.get('icon-data').sig === 'ay' && Buffer.from(pa.get('icon-data').value).equals(img));
  assert.equal(pb.has('icon-data'), false);
  assert.equal(pc.has('icon-data'), false);
  // changing only the picture is a property change, not a new layout
  let seen = null; m.onChange = (rev, c) => { seen = c; };
  m.setItems([{ key: 'a', label: 'with', icon: png.encode(2, 2, Buffer.alloc(16, 7)) }, { key: 'b', label: 'without' }, { key: 'c', label: 'huge', icon: Buffer.alloc(20000) }]);
  assert.equal(seen.layout, false);
  assert.equal(seen.updated.length, 1);
});

const S = (o) => Object.assign({ key: 'a', agentName: 'Claude Code', name: 'api', cwd: '/p/api', state: 'working', label: 'working', lastActivityAt: 1, prompt: 'fix', sessionId: 'x' }, o);

test('buildMenu with icons: no emoji dots, a picture on every session row, the state is still in the words', () => {
  const rows = app.buildMenu([S({}), S({ key: 'b', name: 'web', state: 'needsInput', label: 'needs you' })], { icons: true, onFocus() {}, onQuit() {} });
  const sess = rows.filter((r) => r.key.startsWith('s:'));
  assert.equal(sess.length, 2);
  for (const r of sess) { assert.ok(Buffer.isBuffer(r.icon) && r.icon.length > 50, 'a picture'); assert.doesNotMatch(r.label, /[\u{1F7E0}-\u{1F7EB}\u{1F534}\u{1F535}]/u, 'no emoji dot'); }
  assert.match(sess[1].label, /^web   Claude Code, needs you/);
  const plain = app.buildMenu([S({})], { onQuit() {} }).find((r) => r.key === 's:0');
  assert.match(plain.label, /^🟡/);                                   // without icons nothing changed
  assert.equal(plain.icon, undefined);
});

test('buildMenu compact: the less used items move under "More" and everything is still reachable; off by default', () => {
  const opts = { sessions: 0, priority: { pins: {}, folders: {}, positions: [], onlyPriority: false }, onPin() {}, onPinFolder() {}, onMove() {}, onOnlyPriority() {}, onOpenFolder() {}, onOpenData() {}, onAbout() {}, onCopy() {}, onToggle() {}, onOpenReport() {}, onQuit() {}, snippets: [] };
  const sess = [S({})];
  const flat = app.buildMenu(sess, opts);
  const compact = app.buildMenu(sess, Object.assign({}, opts, { compact: true }));
  const keys = (rows) => rows.map((r) => r.key);
  assert.ok(keys(flat).includes('priority') && keys(flat).includes('about') && keys(flat).includes('copy') && keys(flat).includes('open'));
  assert.ok(!keys(compact).some((k) => ['priority', 'open', 'copy', 'about'].includes(k)));
  const more = compact.find((r) => r.key === 'more');
  assert.deepEqual(more.children.map((r) => r.key).sort(), ['about', 'copy', 'open', 'priority']);
  assert.ok(keys(compact).indexOf('more') > keys(compact).indexOf('settings') && keys(compact).indexOf('more') < keys(compact).indexOf('quit'));
  assert.ok(compact.length < flat.length);
  const all = (rows) => rows.flatMap(function walk(n) { return [n.key, ...(n.children || []).flatMap(walk)]; });
  assert.deepEqual(all(compact).filter((k) => k !== 'more').sort(), all(flat).sort(), 'nothing lost, nothing added');
  assert.equal(new Set(all(compact)).size, all(compact).length);
  const bare = app.buildMenu([], { compact: true, onQuit() {} });
  assert.equal(bare.some((r) => r.key === 'more'), false, 'no "More" row when there is nothing to put in it');
});
