'use strict';
//
// Draws the tray icon: one dot per session, in plain JavaScript, into ARGB32 buffers (the pixel format of the
// StatusNotifierItem IconPixmap property: four bytes per pixel, alpha first, red, green, blue). No image library, no files.
//
// The dots sit in a row, one after another, as in the Mac app: 1 dot (or none) fills a square slot, and every further dot
// makes the icon wider by one dot. More than nine are not drawn (the tooltip and the menu list them all). With colorblind
// shapes on, every state also has its own shape, as in the Mac app.
//
const COLORS = {
  starting: [10, 132, 255], working: [255, 214, 10], done: [48, 209, 88], needsInput: [191, 90, 242],
  warning: [255, 159, 10], stuck: [172, 142, 104], stopped: [255, 69, 58],
};
const SHAPES = { starting: 'ring', working: 'circle', done: 'square', needsInput: 'triangle', warning: 'diamond', stuck: 'pause', stopped: 'cross' };
const ATTENTION = new Set(['needsInput', 'warning', 'stuck', 'stopped']);
const IDLE_COLOR = [150, 150, 150];
const MAX_DOTS = 9;
const SAMPLES = 4;   // 4 x 4 samples per pixel for smooth edges

/** Is the point (x, y), measured from the dot's centre in units of its radius, inside the shape? */
function inside(shape, x, y) {
  const d2 = x * x + y * y;
  switch (shape) {
    case 'ring': return d2 <= 1 && d2 >= 0.4;
    case 'square': {
      const r = 0.34, qx = Math.abs(x) - (0.88 - r), qy = Math.abs(y) - (0.88 - r);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= r;
    }
    case 'triangle': {
      if (y < -1 || y > 0.8) return false;
      const half = ((y + 1) / 1.8) * 0.98;   // the triangle widens from the top point to the base
      return Math.abs(x) <= half;
    }
    case 'diamond': return Math.abs(x) + Math.abs(y) <= 1.08;
    case 'pause': return Math.abs(y) <= 0.85 && ((x >= -0.68 && x <= -0.16) || (x >= 0.16 && x <= 0.68));
    case 'cross': return d2 <= 1.12 && (Math.abs(x - y) / Math.SQRT2 <= 0.24 || Math.abs(x + y) / Math.SQRT2 <= 0.24);
    default: return d2 <= 1;   // circle
  }
}

/** The one state that matters most when a single dot has to stand for all sessions (a host that shows the row as text). */
const URGENT = ['stopped', 'needsInput', 'warning', 'stuck', 'working', 'starting', 'done'];
function mostUrgent(states) {
  for (const u of URGENT) if (states.includes(u)) return u;
  return states[0];
}

/** How wide the icon is for `n` dots when it is `size` tall: square for none or one, then one dot wider each. */
function width(n, size) {
  const count = Math.min(Math.max(n, 0), MAX_DOTS);
  if (count <= 1) return size;
  return Math.round(size * (0.08 + 0.72 + (count - 1) * 0.84));
}

/** Where the dots go for `n` of them: [{cx, cy, r}] in pixels of a width(n, size) x size icon, in a row. */
function layout(n, size) {
  if (n <= 0) return [];
  const count = Math.min(n, MAX_DOTS);
  if (count === 1) return [{ cx: size / 2, cy: size / 2, r: (size - 2 * size * 0.08) / 2 }];
  const w = width(count, size), r = size * 0.36, pitch = size * 0.84;
  const x0 = (w - (2 * r + (count - 1) * pitch)) / 2 + r;   // centred: rounding the width can leave a pixel over
  const out = [];
  for (let i = 0; i < count; i++) out.push({ cx: x0 + i * pitch, cy: size / 2, r });
  return out;
}

/**
 * ARGB32 pixels for `states` (one entry per session, in menu order), width(n, size) x size.
 * opts: size (default 22), shapes (colorblind shapes), phase (0 or 1: in phase 1 states that want attention dim, which is the pulse),
 *       colors ({state: [r, g, b]} overrides), badge (a plan limit is over the threshold: a red mark in the top-right corner that pulses too).
 */
function render(states, opts = {}) {
  const size = opts.size || 22;
  const colors = Object.assign({}, COLORS, opts.colors);
  const w = width(states.length, size);
  const buf = Buffer.alloc(w * size * 4);   // transparent black
  const dots = states.length ? layout(states.length, size).map((p, i) => Object.assign(p, { state: states[i] })) :
    [{ cx: size / 2, cy: size / 2, r: size * 0.3, state: null }];   // no sessions: a quiet grey ring
  for (const d of dots) {
    const shape = d.state === null ? 'ring' : (opts.shapes ? SHAPES[d.state] : 'circle');
    const rgb = d.state === null ? IDLE_COLOR : (colors[d.state] || IDLE_COLOR);
    const fade = d.state === null ? 0.7 : (opts.phase === 1 && ATTENTION.has(d.state) ? 0.35 : 1);
    const x0 = Math.max(0, Math.floor(d.cx - d.r - 1)), x1 = Math.min(w - 1, Math.ceil(d.cx + d.r + 1));
    const y0 = Math.max(0, Math.floor(d.cy - d.r - 1)), y1 = Math.min(size - 1, Math.ceil(d.cy + d.r + 1));
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      let hit = 0;
      for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++) {
        const x = (px + (sx + 0.5) / SAMPLES - d.cx) / d.r, y = (py + (sy + 0.5) / SAMPLES - d.cy) / d.r;
        if (inside(shape, x, y)) hit++;
      }
      if (!hit) continue;
      const alpha = Math.round(255 * fade * hit / (SAMPLES * SAMPLES));
      const o = (py * w + px) * 4;
      if (alpha > buf[o]) { buf[o] = alpha; buf[o + 1] = rgb[0]; buf[o + 2] = rgb[1]; buf[o + 3] = rgb[2]; }
    }
  }
  if (opts.badge) {
    // a white-edged red disc over the corner, so it reads on any panel and over any dot
    const r = size * 0.17, cx = w - r - size * 0.03, cy = r + size * 0.03, fade = opts.phase === 1 ? 0.35 : 1;
    for (let py = 0; py < size; py++) for (let px = 0; px < w; px++) {
      if (px < cx - r - 2 || py > cy + r + 2) continue;
      let red = 0, edge = 0;
      for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++) {
        const d = Math.hypot(px + (sx + 0.5) / SAMPLES - cx, py + (sy + 0.5) / SAMPLES - cy);
        if (d <= r * 0.78) red++; else if (d <= r) edge++;
      }
      const cover = (red + edge) / (SAMPLES * SAMPLES);
      if (!cover) continue;
      const o = (py * w + px) * 4;
      const mix = red / (red + edge);
      buf[o] = Math.max(buf[o] * (1 - cover), Math.round(255 * fade * cover));
      buf[o + 1] = Math.round(255 * (1 - mix) + 255 * mix);
      buf[o + 2] = Math.round(255 * (1 - mix) + 69 * mix);
      buf[o + 3] = Math.round(255 * (1 - mix) + 58 * mix);
    }
  }
  return buf;
}

/** The StatusNotifierItem IconPixmap value: [[width, height, ARGB bytes], ...] in several heights so the host can pick one. */
function pixmaps(states, opts = {}) {
  return [22, 32, 48].map((size) => [width(states.length, size), size, render(states, Object.assign({}, opts, { size }))]);
}

module.exports = { COLORS, SHAPES, ATTENTION, MAX_DOTS, inside, width, layout, mostUrgent, render, pixmaps };
