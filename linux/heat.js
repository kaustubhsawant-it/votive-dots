'use strict';
//
// CPU heat warning, the counterpart of the Mac's (1.8.1). Off by default; while it is on the tray reads the CPU's temperature sensors
// every few seconds, without root, and keeps the numbers in memory. Nothing is written and nothing leaves the computer.
//
// Where the numbers come from: /sys/class/hwmon/*/temp*_input (millidegrees C) of the chips that are the CPU (coretemp, k10temp, zenpower,
// cpu_thermal, ...), and /sys/class/thermal/thermal_zone*/temp of CPU-like zones as a fallback. The hottest one counts, as on the Mac.
// The warning starts at the line (95 C by default, 70 to 110) and stays on until 3 C below it, so it does not flicker.
//
const fs = require('fs');
const path = require('path');

const CPU_CHIPS = /^(coretemp|k10temp|zenpower|cpu_thermal|cpu-thermal|x86_pkg_temp|soc_thermal|bcm2835_thermal|armada_thermal)$/i;
const CPU_ZONES = /^(x86_pkg_temp|cpu[-_ ]?thermal|cpu|soc[-_ ]?thermal|tcpu)/i;
const HYSTERESIS_C = 3;

const readText = (file, fsApi) => { try { return String(fsApi.readFileSync(file, 'utf8')).trim(); } catch (e) { return ''; } };
const readDir = (dir, fsApi) => { try { return fsApi.readdirSync(dir); } catch (e) { return []; } };

/** Millidegrees to degrees, or null for a value that is not a believable temperature (a sensor that is unplugged reads -274000 or 0). */
function degrees(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  const c = n / 1000;
  return c > 0 && c < 150 ? c : null;
}

/** The hottest CPU sensor: { c, source } or null when this machine exposes none. `root` and `fsApi` are for tests. */
function readHottest(root = '/sys', fsApi = fs) {
  let best = null;
  const take = (c, source) => { if (c !== null && (!best || c > best.c)) best = { c, source }; };
  const hwmon = path.join(root, 'class', 'hwmon');
  for (const d of readDir(hwmon, fsApi)) {
    const dir = path.join(hwmon, d);
    const name = readText(path.join(dir, 'name'), fsApi);
    if (!CPU_CHIPS.test(name)) continue;
    for (const f of readDir(dir, fsApi)) {
      if (/^temp\d+_input$/.test(f)) take(degrees(readText(path.join(dir, f), fsApi)), name + ' ' + f.replace('_input', ''));
    }
  }
  if (best) return best;
  const thermal = path.join(root, 'class', 'thermal');
  for (const z of readDir(thermal, fsApi)) {
    if (!/^thermal_zone\d+$/.test(z)) continue;
    const type = readText(path.join(thermal, z, 'type'), fsApi);
    if (CPU_ZONES.test(type)) take(degrees(readText(path.join(thermal, z, 'temp'), fsApi)), type);
  }
  return best;
}

/** On at the line, off 3 C below it. `was` is the previous answer. */
function hot(c, line, was) {
  if (c === null || c === undefined) return false;
  return was ? c > line - HYSTERESIS_C : c >= line;
}

/** Keeps the state between looks: call look(settings) on every refresh; it reads the sensors at most every `everyMs`, and only while the setting is on. */
class HeatWatch {
  constructor({ root = '/sys', fsApi = fs, everyMs = 5000 } = {}) {
    this.root = root; this.fsApi = fsApi; this.everyMs = everyMs;
    this.at = 0; this.reading = null; this.hot = false;
  }

  /** { on, hot, c, line, source }: `on` is whether the setting is on; `c` is null when there is no sensor. */
  look({ enabled, line = 95 }, now = Date.now()) {
    if (!enabled) { this.reading = null; this.hot = false; this.at = 0; return { on: false, hot: false, c: null, line, source: '' }; }
    if (now - this.at >= this.everyMs) { this.reading = readHottest(this.root, this.fsApi); this.at = now; }
    const c = this.reading ? this.reading.c : null;
    this.hot = hot(c, line, this.hot);
    return { on: true, hot: this.hot, c, line, source: this.reading ? this.reading.source : '' };
  }
}

/** The line in the menu (under a divider) and the tooltip, e.g. "CPU 97° (warning at 95°)", or "CPU temperature is not available here". */
function menuLine(h) {
  if (!h.on) return null;
  if (h.c === null) return 'CPU temperature: no sensor found on this computer';
  const now = Math.round(h.c);
  return h.hot ? 'CPU ' + now + '°, hot (warning at ' + h.line + '°)' : 'CPU ' + now + '° (warning at ' + h.line + '°)';
}

module.exports = { readHottest, hot, HeatWatch, menuLine, degrees, HYSTERESIS_C };
