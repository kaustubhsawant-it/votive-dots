'use strict';
//
// The Votive Dots main window on Linux (sidebar: Overview, Forecast, Habits, History, Dot order, settings pages, Agents & tools, and an insights card).
// The helper is linux/ui/votive-main.py (python3 + GTK 3, no cairo); the host is the same as the popup's (linux/window.js). What the helper sends back is checked
// here before anything acts on it: only the listed actions pass, a setting must be one the window shows and its value must fit the setting.
//
const path = require('path');
const { WindowHost } = require('./window');
const { SETTING_PAGES } = require('./mainstate');

const SCRIPT = path.join(__dirname, 'ui', 'votive-main.py');
const MAX_LINE = 4096;
const ROWS = new Map(SETTING_PAGES.flatMap((p) => p.rows).map((r) => [r.name, r]));
const PAGE_IDS = new Set(['overview', 'forecast', 'habits', 'history', 'order', 'general', 'alerts', 'sounds', 'agents']);
const shortKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 300;

/** One message from the helper, or null when it is not one we know. */
function parseMainAction(line) {
  if (typeof line !== 'string' || line.length > MAX_LINE) return null;
  let o;
  try { o = JSON.parse(line); } catch (e) { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  switch (o.t) {
    case 'focus': case 'pin': return shortKey(o.key) ? { t: o.t, key: o.key } : null;
    case 'move': return shortKey(o.key) && Number.isInteger(o.delta) && o.delta !== 0 && Math.abs(o.delta) <= 20 ? { t: 'move', key: o.key, delta: o.delta } : null;
    case 'set': {
      const row = ROWS.get(o.name);
      if (!row) return null;
      if (row.type === 'bool') return typeof o.value === 'boolean' ? { t: 'set', name: o.name, value: o.value } : null;
      if (row.type === 'int') return Number.isInteger(o.value) && o.value >= row.min && o.value <= row.max ? { t: 'set', name: o.name, value: o.value } : null;
      if (row.type === 'choice') return typeof o.value === 'string' && row.choices.includes(o.value) ? { t: 'set', name: o.name, value: o.value } : null;
      return null;
    }
    case 'keepawake': case 'report': case 'closed': return { t: o.t };
    default: return null;
  }
}

/** The host for the main window. Same lifecycle as the popup's; opts as WindowHost. */
class MainWindowHost extends WindowHost {
  constructor(opts = {}) { super(Object.assign({ script: SCRIPT, parse: parseMainAction }, opts)); }
  /** Shows the window on a page ("overview", "forecast", ...). */
  async openPage(state, page) {
    const r = await this.open(state);
    if (r.ok && PAGE_IDS.has(page)) this.send({ t: 'page', id: page });
    return r;
  }
}

module.exports = { MainWindowHost, parseMainAction, SCRIPT, PAGE_IDS };
