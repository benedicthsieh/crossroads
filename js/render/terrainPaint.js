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
function hillshade(terrain) {
  const { w, h, elev, kind } = terrain;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
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
  return out;
}

/** Tiles of water that touch land, so the shallows can be a lighter colour. */
function shoreMask(terrain) {
  const { w, h, kind } = terrain;
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (kind[i] !== T.WATER) continue;
      if (kind[i - 1] !== T.WATER || kind[i + 1] !== T.WATER
        || kind[i - w] !== T.WATER || kind[i + w] !== T.WATER) out[i] = 1;
    }
  }
  return out;
}

/**
 * Paint the whole map.
 * @returns {HTMLCanvasElement} 1 pixel per world unit.
 */
export function bakeTerrain(terrain) {
  const p = pal();
  const cv = document.createElement('canvas');
  cv.width = WORLD.w;
  cv.height = WORLD.h;
  const g = cv.getContext('2d');
  const img = g.createImageData(WORLD.w, WORLD.h);
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
  const deepWater = mixRgb(water, rgb('#16233f'), 0.42);
  const shallow = mixRgb(water, grass[0], 0.3);
  const fordBed = mixRgb(dirt[0], water, 0.42);

  const shade = hillshade(terrain);
  const shore = shoreMask(terrain);
  const { kind, elev, ford } = terrain;

  // Elevation range of mountain tiles, so the snow line is a proportion of the
  // range this seed actually produced rather than an absolute height.
  let peakLo = 1, peakHi = 0;
  for (let i = 0; i < kind.length; i++) {
    if (kind[i] !== T.MOUNTAIN) continue;
    if (elev[i] < peakLo) peakLo = elev[i];
    if (elev[i] > peakHi) peakHi = elev[i];
  }
  const peakSpan = Math.max(0.001, peakHi - peakLo);

  for (let y = 0; y < WORLD.h; y++) {
    for (let x = 0; x < WORLD.w; x++) {
      const o = (y * WORLD.w + x) * 4;
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
        default: {
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

  g.putImageData(img, 0, 0);
  return cv;
}
