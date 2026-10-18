// terrainPaint.js — the map, baked once.
//
// One canvas at exactly one pixel per world unit, painted a pixel at a time and
// then blitted (a visible slice of it) with nearest-neighbour scaling. That is
// the whole terrain cost per frame: one drawImage.
//
// Painting at 1:1 rather than at the display scale is what makes continuous
// zoom affordable — a 3x pre-upscaled version of a 1440x960 map would be a
// 13-megapixel canvas that has to be thrown away and rebuilt every time the
// zoom bracket changes.
//
// The two tricks that stop it looking like a tile map: every pixel samples the
// terrain grid at a *jittered* position, so type boundaries come out ragged
// instead of square, and a cheap hillshade runs over the top so high ground
// reads as high rather than merely differently coloured.

import { hash3 } from '../sim/rng.js';
import { MAP, TILE, WORLD, T } from '../sim/terrain.js';
import { pal } from '../palette.js';

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/**
 * Smooth low-frequency noise for terrain mottling.
 *
 * A plain block hash (`hash3(x >> 3, y >> 3)`) is cheaper and was good enough
 * when the ground was baked at 3x, but at one pixel per world unit its eight-
 * pixel squares are plainly visible as a checkerboard. Interpolating is worth
 * the extra arithmetic here.
 */
function smoothNoise(x, y, seed, period) {
  const u = x / period, v = y / period;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  let fx = u - x0, fy = v - y0;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const n00 = hash3(x0, y0, seed);
  const n10 = hash3(x0 + 1, y0, seed);
  const n01 = hash3(x0, y0 + 1, seed);
  const n11 = hash3(x0 + 1, y0 + 1, seed);
  const a = n00 + (n10 - n00) * fx;
  const b = n01 + (n11 - n01) * fx;
  return a + (b - a) * fy;
}

const mixRgb = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Per-tile relief lighting, quantised so the result still looks hand-placed. */
function hillshade(terrain, out, b) {
  const { w, h, elev, kind } = terrain;
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const i = y * w + x;
      const l = elev[i - (x > 0 ? 1 : 0)];
      const r = elev[i + (x < w - 1 ? 1 : 0)];
      const u = elev[i - (y > 0 ? w : 0)];
      const d = elev[i + (y < h - 1 ? w : 0)];
      // Light from the upper left, same as every sprite in the project.
      const slope = (l - r) * 0.5 + (u - d) * 0.9;
      const steps = Math.max(-2, Math.min(2, Math.round(slope * 26)));
      out[i] = kind[i] === T.WATER ? 1 : 1 + steps * 0.075;
    }
  }
}

/**
 * How close each desert tile is to ground that is still alive, 0..1.
 *
 * The desert covers a tenth of the map and it has to *end* somewhere. A hard
 * line between sand and grass reads as a texture swap; a couple of tiles of
 * scorched scrub either side reads as a place where the rain stopped reaching.
 * Only desert tiles get a value, so the scan is over a tenth of the map.
 */
function desertFringe(terrain, out, b) {
  const { w, h, kind } = terrain;
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const i = y * w + x;
      out[i] = 0;
      if (kind[i] !== T.DESERT) continue;
      let green = 0;
      for (let dy = -3; dy <= 3; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const k = kind[ny * w + nx];
          if (k === T.GRASS || k === T.FOREST) green++;
        }
      }
      out[i] = Math.min(1, green / 10);
    }
  }
}

/** Tiles of water that touch land, so the shallows can be a lighter colour. */
function shoreMask(terrain, out, b) {
  const { w, h, kind } = terrain;
  for (let y = Math.max(1, b.y0); y < Math.min(h - 1, b.y1); y++) {
    for (let x = Math.max(1, b.x0); x < Math.min(w - 1, b.x1); x++) {
      const i = y * w + x;
      out[i] = 0;
      if (kind[i] !== T.WATER) continue;
      if (kind[i - 1] !== T.WATER || kind[i + 1] !== T.WATER
        || kind[i - w] !== T.WATER || kind[i + w] !== T.WATER) out[i] = 1;
    }
  }
}

/**
 * The per-tile masks, kept between paints. A fire or a flood (sim/nature.js)
 * changes a few hundred tiles at a time, and recomputing three whole-map
 * passes for that would be most of the cost of the repaint.
 */
const masks = new WeakMap();

function masksFor(terrain) {
  let m = masks.get(terrain);
  if (m) return m;
  const n = terrain.w * terrain.h;
  m = { shade: new Float32Array(n), shore: new Uint8Array(n), dry: new Float32Array(n) };
  const all = { x0: 0, y0: 0, x1: terrain.w, y1: terrain.h };
  hillshade(terrain, m.shade, all);
  shoreMask(terrain, m.shore, all);
  desertFringe(terrain, m.dry, all);
  // Elevation range of mountain tiles, so the snow line is a proportion of the
  // range this seed actually produced rather than an absolute height. Fires and
  // floods never touch a mountain, so this is fixed for the map.
  m.peakLo = 1; m.peakHi = 0;
  for (let i = 0; i < n; i++) {
    if (terrain.kind[i] !== T.MOUNTAIN) continue;
    if (terrain.elev[i] < m.peakLo) m.peakLo = terrain.elev[i];
    if (terrain.elev[i] > m.peakHi) m.peakHi = terrain.elev[i];
  }
  masks.set(terrain, m);
  return m;
}

/**
 * Paint the whole map.
 * @returns {HTMLCanvasElement} 1 pixel per world unit.
 */
export function bakeTerrain(terrain) {
  masks.delete(terrain);
  const cv = document.createElement('canvas');
  cv.width = WORLD.w;
  cv.height = WORLD.h;
  paint(cv, terrain, 0, 0, MAP.w, MAP.h);
  return cv;
}

/**
 * Repaint the tiles a fire or a flood changed, and a margin round them: the
 * jittered sampling reaches a tile into each neighbour, and the shore and the
 * desert fringe reach further.
 */
export function repaintTiles(cv, terrain, tiles) {
  if (!tiles.length) return;
  let x0 = MAP.w, y0 = MAP.h, x1 = 0, y1 = 0;
  for (const i of tiles) {
    const x = i % MAP.w, y = (i / MAP.w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const m = masksFor(terrain);
  const pad = 5;
  const b = {
    x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad),
    x1: Math.min(MAP.w, x1 + pad + 1), y1: Math.min(MAP.h, y1 + pad + 1),
  };
  hillshade(terrain, m.shade, b);
  shoreMask(terrain, m.shore, b);
  desertFringe(terrain, m.dry, b);
  paint(cv, terrain, x0 - 2, y0 - 2, x1 + 3, y1 + 3);
}

/** Paint tiles [tx0, tx1) x [ty0, ty1) into the canvas. */
function paint(cv, terrain, tx0, ty0, tx1, ty1) {
  tx0 = Math.max(0, tx0); ty0 = Math.max(0, ty0);
  tx1 = Math.min(MAP.w, tx1); ty1 = Math.min(MAP.h, ty1);
  const p = pal();
  const g = cv.getContext('2d');
  const px0 = tx0 * TILE, py0 = ty0 * TILE;
  const pw = (tx1 - tx0) * TILE, ph = (ty1 - ty0) * TILE;
  if (pw <= 0 || ph <= 0) return;
  const img = g.createImageData(pw, ph);
  const data = img.data;

  const grass = p.grass.map(rgb);
  const grassDeep = rgb(p.grassDeep);
  const leaf = p.leaf.map(rgb);
  const leafAlt = p.leafAlt.map(rgb);
  const dirt = p.dirt.map(rgb);
  const dirtDeep = rgb(p.dirtDeep);
  const stone = rgb(p.stone);
  const stoneDark = rgb(p.stoneDark);
  const water = rgb(p.water);
  const wheatDark = rgb(p.wheatDark);
  const sand = p.sand.map(rgb);
  const sandDeep = rgb(p.sandDeep);

  // Derived ramps, mixed once rather than per pixel.
  const forest = leaf.map((c) => mixRgb(c, grassDeep, 0.25));
  const forestFloor = mixRgb(leaf[2], dirtDeep, 0.4);
  const hill = [
    mixRgb(grass[0], wheatDark, 0.3),
    mixRgb(grass[2], wheatDark, 0.42),
    mixRgb(grass[1], dirt[2], 0.34),
  ];
  const hillRock = mixRgb(stone, dirt[2], 0.45);
  const rock = [
    mixRgb(stone, dirtDeep, 0.3),
    mixRgb(stoneDark, dirtDeep, 0.25),
    mixRgb(stone, stoneDark, 0.5),
  ];
  const snow = mixRgb(rgb(p.white), stone, 0.25);
  // Where the sand meets anything that isn't sand. Painting the boundary in
  // full dune colour makes the desert look like a sheet of paper laid over the
  // map; a band of scorched, half-dead ground reads as somewhere the grass gave
  // up rather than somewhere the artist stopped.
  const scrubland = mixRgb(sand[2], grassDeep, 0.34);
  const sandRock = mixRgb(sandDeep, stoneDark, 0.3);
  const deepWater = mixRgb(water, rgb('#16233f'), 0.42);
  const shallow = mixRgb(water, grass[0], 0.3);
  const fordBed = mixRgb(dirt[0], water, 0.42);

  // Burnt ground: ash and char with the first green coming through. It stays
  // this colour; a burn scar is part of the map's history now.
  const char = mixRgb(dirtDeep, rgb('#2a2420'), 0.55);
  const ash = mixRgb(stoneDark, dirtDeep, 0.5);
  const sprout = mixRgb(grass[0], dirtDeep, 0.35);

  const { shade, shore, dry, peakLo, peakHi } = masksFor(terrain);
  const { kind, elev, ford } = terrain;
  const burnt = terrain.burnt;
  const peakSpan = Math.max(0.001, peakHi - peakLo);

  for (let y = py0; y < py0 + ph; y++) {
    for (let x = px0; x < px0 + pw; x++) {
      const o = ((y - py0) * pw + (x - px0)) * 4;
      const n = hash3(x, y, 3);
      const m = hash3(x, y, 91);
      const coarse = smoothNoise(x, y, 17, 9);

      // Jittered sample: this is what stops terrain boundaries from being
      // visible six-pixel steps.
      const tx = Math.max(0, Math.min(MAP.w - 1, Math.floor((x + (n - 0.5) * 3.4) / TILE)));
      const ty = Math.max(0, Math.min(MAP.h - 1, Math.floor((y + (m - 0.5) * 3.4) / TILE)));
      const i = ty * MAP.w + tx;
      const k = kind[i];

      let col;
      switch (k) {
        case T.WATER: {
          if (ford[i]) {
            col = n > 0.72 ? shallow : fordBed;          // a gravel bar you can wade
          } else if (shore[i]) {
            col = n > 0.8 ? water : shallow;
          } else {
            col = n > 0.86 ? water : deepWater;
            // Slow horizontal banding reads as current without animating.
            if (((y + (coarse * 6) | 0) % 7) === 0 && n > 0.4) col = shallow;
          }
          break;
        }
        case T.FOREST: {
          const t = coarse * 0.65 + n * 0.35;
          col = forest[(t * 3) | 0];
          if (coarse < 0.14) col = forestFloor;          // clearings
          else if (n > 0.955) col = leafAlt[(m * 2) | 0];
          break;
        }
        case T.HILL: {
          const t = coarse * 0.7 + n * 0.3;
          col = hill[(t * 3) | 0];
          if (n > 0.975) col = hillRock;                 // stones breaking through
          break;
        }
        case T.MOUNTAIN: {
          const height = (elev[i] - peakLo) / peakSpan;
          col = rock[(n * 3) | 0];
          if (height > 0.72 && n > 0.25) col = snow;
          else if (height < 0.22 && n > 0.7) col = mixRgb(rock[0], hill[1], 0.45);
          break;
        }
        case T.DESERT: {
          // Dunes. The banding is the whole trick: a long, low-frequency ripple
          // sampled diagonally, quantised to a handful of steps, so the sand
          // reads as *drifted* rather than as noise. Straight mottling at this
          // scale looks like static, and static is the one thing sand must not
          // look like when it covers a tenth of the map.
          const ripple = smoothNoise(x + y * 0.45, y * 2.6, 61, 26);
          const band = (ripple * 3.4 + n * 0.6) | 0;
          col = sand[Math.max(0, Math.min(3, band))];
          if (ripple > 0.78 && n > 0.35) col = sand[3];        // the lit crest
          else if (ripple < 0.2) col = sandDeep;               // the trough
          if (n > 0.986) col = sandRock;                       // stone breaking through
          // Fringe: near the edge of the waste, dead scrub still holds on.
          if (dry[i] > 0 && n > dry[i] * 0.55) col = scrubland;
          break;
        }
        default: {
          if (burnt && burnt[i]) {
            col = n > 0.82 ? sprout : (coarse + n * 0.4 > 0.75 ? ash : char);
            break;
          }
          const t = coarse * 0.7 + n * 0.3;
          col = grass[(t * 4) | 0];
          if (coarse < 0.15) col = grassDeep;
          else if (n > 0.968) col = grass[3];
        }
      }

      const f = shade[i];
      data[o] = Math.max(0, Math.min(255, col[0] * f));
      data[o + 1] = Math.max(0, Math.min(255, col[1] * f));
      data[o + 2] = Math.max(0, Math.min(255, col[2] * f));
      data[o + 3] = 255;
    }
  }

  g.putImageData(img, px0, py0);
}
