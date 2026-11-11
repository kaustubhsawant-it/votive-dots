'use strict';
//
// Dot colour sets on Linux (the Mac's Default, Colorblind friendly and High contrast): the colours, where the choice is kept, and that it reaches the pictures.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../linux/palettes');
const { PrefsStore } = require('../linux/prefs');
const MI = require('../linux/menuicons');
const icon = require('../linux/icon');

test('palettes: the same three sets as the Mac, every state present, colours are plain hex', () => {
  assert.deepEqual(P.IDS, ['default', 'colorblind', 'contrast']);
  assert.deepEqual(P.NAMES, ['Default', 'Colorblind friendly', 'High contrast']);
  for (const p of P.PALETTES.slice(1)) {
    assert.deepEqual(Object.keys(p.colors).sort(), Object.keys(icon.COLORS).sort(), p.id);
    for (const hex of Object.values(p.colors)) assert.match(hex, /^#[0-9A-F]{6}$/);
  }
  assert.deepEqual(P.overrides('colorblind').working, [0xF0, 0xE4, 0x42]);   // Okabe and Ito yellow
  assert.deepEqual(P.overrides('default'), {});
  assert.deepEqual(P.overrides('../../etc'), {});
  assert.equal(P.idOfName('High contrast'), 'contrast');
  assert.equal(P.idOfName('nonsense'), 'default');
  assert.equal(P.isDefault('default') && P.isDefault(undefined) && P.isDefault('x'), true);
  assert.equal(P.isDefault('contrast'), false);
});

test('palettes: the choice is kept in the tray\'s own file, survives a restart, and an unknown set is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-pal-'));
  const a = new PrefsStore(root);
  assert.equal(a.palette(), 'default');
  a.setPalette('contrast');
  assert.equal(new PrefsStore(root).palette(), 'contrast');
  a.toggle('portToolsOn');
  assert.deepEqual(new PrefsStore(root).read(), { portToolsOn: true, palette: 'contrast' }, 'the two kinds of preference live together');
  assert.throws(() => a.setPalette('purple'), /unknown colour set/);
  a.setPalette('default');
  assert.deepEqual(new PrefsStore(root).read(), { portToolsOn: true });
  fs.writeFileSync(path.join(root, 'linux-prefs.json'), '{"palette":"<script>","portToolsOn":true}');
  assert.equal(new PrefsStore(root).palette(), 'default', 'a hand-edited value that is not a known set is ignored');
});

test('palettes: the colours reach the menu pictures and the tray icon', () => {
  const plain = MI.stateIcon('working', { shapes: true, palette: 'default' });
  const blind = MI.stateIcon('working', { shapes: true, palette: 'colorblind' });
  assert.notDeepEqual(plain, blind);
  assert.deepEqual(MI.stateIcon('working', { shapes: true }), plain, 'no palette means the default');
  const px = (buf) => icon.render(['working'], { size: 22, shapes: false, colors: buf });
  assert.notDeepEqual(px({}), px(P.overrides('colorblind')));
});

test('palettes: the tray applies the set, and a non-default set turns the coloured-emoji row off', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'linux', 'votive-tray.js'), 'utf8');
  assert.match(src, /colors: palettes\.overrides\(palette\)/);
  assert.match(src, /palettes\.isDefault\(palette\)/);
  assert.match(src, /prefs\.setPalette\(palettes\.idOfName\(value\)\)/);
});
