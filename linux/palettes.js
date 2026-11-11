'use strict';
//
// The colour sets for the state dots, the same three the Mac offers (Votive/Services/StateColors.swift): the system colours, an Okabe and Ito colourblind-safe set,
// and a high-contrast set. A state's colour never changes what the state means: its name is written beside every dot and Colorblind shapes still gives each its own shape.
// The choice lives in ~/.votive/linux-prefs.json (the tray's own file). Coloured emoji dots (the GNOME text row) cannot be recoloured, so a non-default set uses the drawn row.
//
const PALETTES = [
  { id: 'default', name: 'Default', note: 'The usual colours.', colors: {} },
  { id: 'colorblind', name: 'Colorblind friendly', note: 'Chosen to stay apart for the common kinds of color blindness.', colors: {
    starting: '#56B4E9', working: '#F0E442', done: '#009E73', needsInput: '#CC79A7', warning: '#E69F00', stuck: '#0072B2', stopped: '#D55E00' } },
  { id: 'contrast', name: 'High contrast', note: 'Strong, saturated colors that stand out on any panel.', colors: {
    starting: '#0066FF', working: '#FFD60A', done: '#00C853', needsInput: '#B000FF', warning: '#FF8C00', stuck: '#8B4513', stopped: '#FF1744' } },
];
const IDS = PALETTES.map((p) => p.id);
const NAMES = PALETTES.map((p) => p.name);

const rgbOf = (hex) => { const v = parseInt(hex.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

/** The {state: [r, g, b]} overrides for a palette id; {} for the default or anything unknown. */
function overrides(id) {
  const p = PALETTES.find((x) => x.id === id);
  if (!p) return {};
  const out = {};
  for (const [state, hex] of Object.entries(p.colors)) out[state] = rgbOf(hex);
  return out;
}

const isDefault = (id) => !id || id === 'default' || !IDS.includes(id);
const idOfName = (name) => (PALETTES.find((p) => p.name === name) || PALETTES[0]).id;
const nameOfId = (id) => (PALETTES.find((p) => p.id === id) || PALETTES[0]).name;

module.exports = { PALETTES, IDS, NAMES, overrides, isDefault, idOfName, nameOfId };
