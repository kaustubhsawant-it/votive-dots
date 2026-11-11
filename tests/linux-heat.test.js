'use strict';
//
// The Linux CPU heat warning: reads the hottest CPU sensor from a made-up /sys, warns at the line, and stays on until 3 C below it.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const heat = require('../linux/heat');

function fakeSys(chips = {}, zones = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-heat-'));
  let n = 0;
  for (const [name, temps] of Object.entries(chips)) {
    const d = path.join(root, 'class', 'hwmon', 'hwmon' + n++);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'name'), name + '\n');
    temps.forEach((t, i) => fs.writeFileSync(path.join(d, 'temp' + (i + 1) + '_input'), String(t) + '\n'));
  }
  let z = 0;
  for (const [type, t] of Object.entries(zones)) {
    const d = path.join(root, 'class', 'thermal', 'thermal_zone' + z++);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'type'), type + '\n');
    fs.writeFileSync(path.join(d, 'temp'), String(t) + '\n');
  }
  return root;
}

test('heat: the hottest CPU sensor counts; other chips (disk, wifi) do not', () => {
  const root = fakeSys({ coretemp: [61000, 88500, 70000], nvme: [99000], iwlwifi_1: [101000] });
  const r = heat.readHottest(root);
  assert.equal(r.c, 88.5);
  assert.match(r.source, /coretemp temp2/);
});

test('heat: an unplugged or impossible sensor is ignored', () => {
  assert.equal(heat.degrees('-274000'), null);
  assert.equal(heat.degrees('0'), null);
  assert.equal(heat.degrees('250000'), null);
  assert.equal(heat.degrees('junk'), null);
  assert.equal(heat.degrees('71000'), 71);
});

test('heat: with no CPU chip, a CPU-like thermal zone is used; with nothing, null', () => {
  assert.equal(heat.readHottest(fakeSys({}, { x86_pkg_temp: 77000, acpitz: 90000 })).c, 77);
  assert.equal(heat.readHottest(fakeSys({ nvme: [50000] })), null);
  assert.equal(heat.readHottest(path.join(os.tmpdir(), 'votive-no-such-sys')), null);
});

test('heat: on at the line, off only 3 degrees below it', () => {
  assert.equal(heat.hot(94.9, 95, false), false);
  assert.equal(heat.hot(95, 95, false), true);
  assert.equal(heat.hot(93, 95, true), true);     // still above 92
  assert.equal(heat.hot(92, 95, true), false);    // 3 below: off
  assert.equal(heat.hot(null, 95, true), false);
});

test('heat: the watch reads nothing while the setting is off and reads at most every 5 s while on', () => {
  const root = fakeSys({ k10temp: [96000] });
  let reads = 0;
  const fsApi = Object.assign({}, fs, { readFileSync: (...a) => { reads++; return fs.readFileSync(...a); } });
  const w = new heat.HeatWatch({ root, fsApi, everyMs: 5000 });
  assert.deepEqual(w.look({ enabled: false }, 1000), { on: false, hot: false, c: null, line: 95, source: '' });
  assert.equal(reads, 0);
  const a = w.look({ enabled: true, line: 95 }, 10000);
  assert.equal(a.hot, true);
  const after = reads;
  w.look({ enabled: true, line: 95 }, 12000);
  assert.equal(reads, after);                      // within 5 s: no new read
  w.look({ enabled: true, line: 95 }, 16000);
  assert.ok(reads > after);
});

test('heat: the menu line says what it sees, and says so when there is no sensor', () => {
  assert.equal(heat.menuLine({ on: false }), null);
  assert.equal(heat.menuLine({ on: true, hot: false, c: 71.4, line: 95 }), 'CPU 71° (warning at 95°)');
  assert.equal(heat.menuLine({ on: true, hot: true, c: 96.6, line: 95 }), 'CPU 97°, hot (warning at 95°)');
  assert.match(heat.menuLine({ on: true, hot: false, c: null, line: 95 }), /no sensor/);
});

test('heat: the tray shows the line in its menu only while the setting is on, and a hot CPU lights the icon badge', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'linux', 'votive-tray.js'), 'utf8');
  assert.match(src, /\['cpuHeatWarning', 'Warn when the CPU is hot'\]/);
  assert.match(src, /\|\| heat\.hot,/);
  assert.match(src, /heatMod\.menuLine\(heat\)/);
});
