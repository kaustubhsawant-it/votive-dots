'use strict';
//
// The tray icon (linux/icon.js): pixels in ARGB32, one dot per session in a row, colorblind shapes, and the pulse frame.
//
const { test } = require('node:test');
const assert = require('node:assert');
const I = require('../linux/icon');

const px = (buf, size, x, y) => Array.from(buf.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));   // [A, R, G, B]
const opaque = (buf) => { let n = 0; for (let i = 0; i < buf.length; i += 4) if (buf[i] > 0) n++; return n; };
const STATES = ['starting', 'working', 'done', 'needsInput', 'warning', 'stuck', 'stopped'];

test('a single dot: ARGB bytes, solid centre, transparent corners', () => {
  const b = I.render(['done'], { size: 22 });
  assert.equal(b.length, 22 * 22 * 4);
  assert.deepEqual(px(b, 22, 11, 11), [255, 48, 209, 88]);      // alpha, red, green, blue
  assert.deepEqual(px(b, 22, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(px(b, 22, 21, 21), [0, 0, 0, 0]);
  const edge = Array.from({ length: 22 }, (_, x) => px(b, 22, x, 11)[0]).filter((a) => a > 0 && a < 255);
  assert.ok(edge.length >= 2, 'the edge is anti-aliased, not a hard step');
});

test('every state has its own colour, and none draws outside the icon', () => {
  for (const s of STATES) assert.ok(opaque(I.render([s], { size: 32 })) > 40, s);
  assert.deepEqual(px(I.render(['working'], { size: 22 }), 22, 11, 11), [255, 255, 214, 10]);
  const colors = new Set(STATES.map((s) => px(I.render([s], { size: 32 }), 32, 16, 16).join()));
  assert.equal(colors.size, 7);
});

test('colorblind shapes: every state is a different shape', () => {
  const alphas = (s) => I.render([s], { size: 48, shapes: true }).filter((_, i) => i % 4 === 0).toString('hex');
  assert.equal(new Set(STATES.map(alphas)).size, 7);
  assert.equal(px(I.render(['starting'], { size: 48, shapes: true }), 48, 24, 24)[0], 0);                  // the ring is hollow
  assert.equal(px(I.render(['starting'], { size: 48 }), 48, 24, 24)[0], 255);                              // without shapes it is a plain dot
  assert.deepEqual(I.render(['done'], { size: 22 }), I.render(['done'], { size: 22, shapes: false }));
});

test('layout: dots are in one row, left to right, inside the icon, never overlapping, and stop at nine', () => {
  for (const size of [22, 32, 48]) for (let n = 1; n <= 12; n++) {
    const dots = I.layout(n, size), w = I.width(n, size);
    assert.equal(dots.length, Math.min(n, 9));
    for (const d of dots) assert.ok(d.cx - d.r >= 0 && d.cx + d.r <= w && d.cy - d.r >= 0 && d.cy + d.r <= size, `n=${n} size=${size}`);
    for (let i = 1; i < dots.length; i++) {
      assert.equal(dots[i].cy, dots[0].cy, 'one row');
      assert.ok(dots[i].cx - dots[i - 1].cx >= dots[i].r + dots[i - 1].r, `overlap n=${n} size=${size}`);
    }
  }
  assert.deepEqual(I.layout(0, 22), []);
  assert.equal(I.width(0, 22), 22);                               // none or one dot: a square slot
  assert.equal(I.width(1, 22), 22);
  assert.ok(I.width(2, 22) > 22 && I.width(4, 22) > I.width(3, 22) && I.width(4, 22) > 2 * I.width(2, 22) - 22);   // each dot widens the icon
  assert.equal(I.width(30, 22), I.width(9, 22));
  assert.equal(I.layout(4, 22).length, 4);
  assert.ok(I.layout(1, 22)[0].r > I.layout(4, 22)[0].r);        // a lone dot fills the slot
  assert.equal(I.layout(4, 22)[0].r, I.layout(9, 22)[0].r);      // the dots stay one size, the icon grows
  assert.equal(I.render(['done', 'done', 'done', 'done'], { size: 22 }).length, I.width(4, 22) * 22 * 4);
  const four = I.render(['working', 'waiting', 'done', 'stopped'], { size: 22 }), w = I.width(4, 22), d = I.layout(4, 22);
  assert.deepEqual(d.map((p) => px(four, w, Math.round(p.cx), 11)[0]), [255, 255, 255, 255]);   // every dot is drawn at its own place
  assert.equal(px(four, w, Math.round((d[0].cx + d[1].cx) / 2), 11)[0] < 255, true);                  // and there is a gap between two dots
});

test('no sessions: a quiet grey ring, not an empty icon', () => {
  const b = I.render([], { size: 22 });
  assert.ok(opaque(b) > 20);
  assert.equal(px(b, 22, 11, 11)[0], 0);                          // hollow
  const ring = px(b, 22, 11, 5);
  assert.ok(ring[0] > 0 && ring[0] < 255);                        // translucent
  assert.deepEqual(ring.slice(1), [150, 150, 150]);
});

test('the pulse: attention states dim in phase 1, calm states do not', () => {
  const on = I.render(['needsInput', 'done'], { size: 32, phase: 0 });
  const off = I.render(['needsInput', 'done'], { size: 32, phase: 1 });
  const [l, r] = I.layout(2, 32), w = I.width(2, 32);
  const left = (b) => px(b, w, Math.round(l.cx), 16)[0], right = (b) => px(b, w, Math.round(r.cx), 16)[0];
  assert.equal(left(on), 255);
  assert.ok(left(off) > 60 && left(off) < 130);
  assert.equal(right(on), 255);
  assert.equal(right(off), 255);
  assert.deepEqual(I.render(['done'], { size: 22, phase: 1 }), I.render(['done'], { size: 22, phase: 0 }));
});

test('colour overrides and the pixmaps property', () => {
  const b = I.render(['done'], { size: 22, colors: { done: [1, 2, 3] } });
  assert.deepEqual(px(b, 22, 11, 11), [255, 1, 2, 3]);
  const pm = I.pixmaps(['done', 'working']);
  assert.deepEqual(pm.map((p) => [p[0], p[1], p[2].length]), [22, 32, 48].map((h) => [I.width(2, h), h, I.width(2, h) * h * 4]));
  assert.deepEqual(I.pixmaps(['done']).map((p) => [p[0], p[1]]), [[22, 22], [32, 32], [48, 48]]);   // one dot stays square
  assert.deepEqual(I.render(['done', 'stopped'], { size: 22 }), I.render(['done', 'stopped'], { size: 22 }));   // deterministic
});
