'use strict';
//
// Pictures for menu rows (PNG bytes for the dbusmenu `icon-data` property), drawn in plain JavaScript with the same shapes and colours as the tray icon and the Mac app.
// Cached: the menu is rebuilt every two seconds and a picture never changes for the same inputs.
//
const icon = require('./icon');
const png = require('./png');
const palettes = require('./palettes');

const cache = new Map();
const remember = (key, make) => { if (!cache.has(key)) { if (cache.size > 200) cache.clear(); cache.set(key, make()); } return cache.get(key); };

/** One state as a picture: a dot, or its shape when `shapes` is on. */
function stateIcon(state, { shapes = true, size = 24, palette = 'default' } = {}) {
  return remember('s:' + state + ':' + shapes + ':' + size + ':' + palette, () => png.encode(size, size, png.fromArgb(icon.render([state], { size, shapes, colors: palettes.overrides(palette) }))));
}

module.exports = { stateIcon };
