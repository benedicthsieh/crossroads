// terrain.js — the map, and the reason travel is interesting.
//
// The whole premise of the game is that roads are *discovered*, not designed.
// That only works if the ground argues back, so the map is built to be crossed
// unevenly: grassland is cheap, forest slows you, hills slow you more, and
// mountain ridges and rivers are near-walls with a handful of gaps in them.
// Travellers funnel through those gaps, the gaps wear into roads, and the roads
// meet at crossroads. Nothing places a road or a town — the terrain does, by
// being annoying in specific places.
//
// Terrain is a pure function of the seed. Nothing here is ever mutated by the
// sim (that's `wear`, which lives in state.js), so a snapshot never has to
// store 38,400 tiles of it: save the seed, regenerate on load.

import { hash3 } from './rng.js';

// One tile is 6 world units — roughly a third of a villager's height, small
// enough that a worn track reads as a track rather than as a tiled corridor.
export const TILE = 6;
export const MAP = { w: 300, h: 200 };
export const WORLD = { w: MAP.w * TILE, h: MAP.h * TILE };

export const T = {
  WATER: 0,
  GRASS: 1,
  FOREST: 2,
  HILL: 3,
  MOUNTAIN: 4,
};

export const TERRAIN_NAMES = ['water', 'grassland', 'forest', 'hills', 'mountain'];

/**
 * Movement cost per tile, before roads. These ratios are the map's entire
 * personality: grass is the baseline, a river is a wall you *can* wade if the
 * detour is absurd, and a mountain is worth going around unless the pass is
 * short. Fords and worn tracks are what bring the extremes back down.
 */
export const BASE_COST = [60, 1, 2.2, 3.2, 8];
export const FORD_COST = 5;

/** Terrain a building can stand on. */
export function buildable(kind) {
  return kind === T.GRASS || kind === T.FOREST || kind === T.HILL;
}

// ------------------------------------------------------------------- noise

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  // Smoothstep the interpolant or the noise shows its grid.
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash3(x0, y0, seed);
  const n10 = hash3(x0 + 1, y0, seed);
  const n01 = hash3(x0, y0 + 1, seed);
  const n11 = hash3(x0 + 1, y0 + 1, seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

function fbm(x, y, seed, octaves = 5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, y * f, seed + i * 101) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged noise: the |n| fold is what turns blobs into chains. */
function ridged(x, y, seed, octaves = 4) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x * f, y * f, seed + i * 71) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// --------------------------------------------------------------- generation

/** Threshold that puts exactly `fraction` of the values above it. */
function percentile(values, fraction) {
  const bins = new Int32Array(512);
  for (let i = 0; i < values.length; i++) {
    bins[Math.max(0, Math.min(511, (values[i] * 511) | 0))]++;
  }
  const want = values.length * (1 - fraction);
  let acc = 0;
  for (let b = 0; b < 512; b++) {
    acc += bins[b];
    if (acc >= want) return b / 511;
  }
  return 1;
}

/**
 * Carve rivers by walking downhill from high ground.
 *
 * Rivers matter more than they look: a river that reaches the map edge cuts the
 * world in two, and the only cheap way across is a ford. Fords are therefore
 * placed deliberately and sparsely rather than left to chance — they are the
 * bottlenecks the road network ends up hanging off.
 */
function carveRivers(elev, water, ford, flow, seed) {
  const { w, h } = MAP;
  const idx = (x, y) => y * w + x;
  const sources = [];

  // Pick sources on high ground, spread out, scanning a coarse grid so the
  // result doesn't depend on iteration order of anything else.
  for (let ty = 4; ty < h - 4; ty += 7) {
    for (let tx = 4; tx < w - 4; tx += 7) {
      const e = elev[idx(tx, ty)];
      if (e < 0.62) continue;
      sources.push({ x: tx, y: ty, e: e + hash3(tx, ty, seed + 7) * 0.05 });
    }
  }
  sources.sort((a, b) => b.e - a.e);

  const chosen = [];
  for (const s of sources) {
    if (chosen.length >= 6) break;
    if (chosen.some((c) => Math.hypot(c.x - s.x, c.y - s.y) < 42)) continue;
    chosen.push(s);
  }

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const seen = new Uint8Array(w * h);

  for (let ri = 0; ri < chosen.length; ri++) {
    let { x, y } = chosen[ri];
    // Every river gets an outlet: the nearest map edge to its source. A pure
    // steepest-descent river dies in the first basin it finds, which leaves a
    // chain of ponds rather than a barrier. Biasing the descent toward the
    // outlet keeps terrain in charge of the *route* while guaranteeing the
    // river actually reaches the edge and cuts the map in two.
    const outlet = (() => {
      const d = [x, w - 1 - x, y, h - 1 - y];
      const min = Math.min(...d);
      if (min === d[0]) return (px) => px;
      if (min === d[1]) return (px) => w - 1 - px;
      if (min === d[2]) return (px, py) => py;
      return (px, py) => h - 1 - py;
    })();
    const path = [];
    // Visited tiles are excluded from the descent. Without that, the meander
    // jitter can make a river prefer the tile it just came from, and it spends
    // its whole step budget oscillating between two squares — which looks, from
    // the outside, exactly like "the generator doesn't make rivers".
    seen.fill(0);
    let steps = 0;
    while (steps++ < 4000) {
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) break;
      const here = idx(x, y);
      path.push(here);
      seen[here] = 1;
      if (water[here] && path.length > 4) break;              // joined another river

      // Steepest descent, with a hash nudge so rivers meander instead of
      // running in eight straight compass directions.
      let bx = -1, by = -1, best = Infinity;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) { bx = nx; by = ny; best = -Infinity; break; }
        if (seen[idx(nx, ny)]) continue;
        const cost = elev[idx(nx, ny)]
          + (hash3(nx, ny, seed + ri * 31) - 0.5) * 0.03
          + outlet(nx, ny) * 0.0022;
        if (cost < best) { best = cost; bx = nx; by = ny; }
      }
      if (bx < 0) break;                                      // boxed in by its own bed
      // Rivers cut down as they go, so the bed never runs uphill. This also
      // leaves a real valley in the elevation field, which the hillshade and
      // the terrain classifier both pick up for free.
      if (bx >= 0 && by >= 0 && bx < w && by < h && elev[idx(bx, by)] >= elev[here]) {
        elev[idx(bx, by)] = elev[here] - 0.001;
      }
      x = bx; y = by;
    }

    // Downstream tiles carry more water, so the channel widens toward the mouth.
    for (let i = 0; i < path.length; i++) {
      const t = i / Math.max(1, path.length - 1);
      const radius = t < 0.18 ? 0 : (t < 0.5 ? 1 : (t < 0.8 ? 1.6 : 2.2));
      const px = path[i] % w, py = (path[i] / w) | 0;
      const r = Math.ceil(radius);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.hypot(dx, dy) > radius + 0.4) continue;
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          water[idx(nx, ny)] = 1;
          flow[idx(nx, ny)] = Math.max(flow[idx(nx, ny)], t);
        }
      }
    }

    // Fords roughly every 26 tiles of river. Deliberate and spaced: the point
    // is to force travellers into a small number of crossings, not to make the
    // river porous everywhere.
    for (let i = 8; i < path.length - 6; i++) {
      if (i % 26 !== 0) continue;
      const px = path[i] % w, py = (path[i] / w) | 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (water[idx(nx, ny)]) ford[idx(nx, ny)] = 1;
        }
      }
    }
  }
}

/**
 * Build the whole map from a seed.
 * Returns plain typed arrays — no classes, nothing the renderer can hook into.
 */
export function generateTerrain(seed) {
  const { w, h } = MAP;
  const n = w * h;
  const elev = new Float32Array(n);
  const moist = new Float32Array(n);
  const kind = new Uint8Array(n);
  const water = new Uint8Array(n);
  const ford = new Uint8Array(n);
  const flow = new Float32Array(n);

  const s = seed >>> 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const base = fbm(x / 46, y / 46, s, 5);
      const chains = ridged(x / 78, y / 78, s + 977, 4);
      // Ridges are added, not blended, so the chains sit on top of the rolling
      // ground rather than replacing it — foothills come free that way.
      let e = base * 0.62 + chains * 0.62;
      // Ease the very edge of the map down a little so the border isn't a wall
      // of cliffs and travellers can actually enter.
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y) / 14;
      if (edge < 1) e *= 0.72 + 0.28 * edge;
      elev[i] = Math.max(0, Math.min(1, e));
      moist[i] = fbm(x / 34 + 100, y / 34 + 100, s + 4231, 4);
    }
  }

  carveRivers(elev, water, ford, flow, s);

  // Thresholds by percentile rather than by absolute height: every seed then
  // lands the same *proportions* of terrain, so "mostly passable" is a property
  // of the generator instead of something to get lucky with.
  const mountainAt = percentile(elev, 0.09);
  const hillAt = percentile(elev, 0.24);
  const forestAt = percentile(moist, 0.27);

  for (let i = 0; i < n; i++) {
    if (water[i]) { kind[i] = T.WATER; continue; }
    if (elev[i] >= mountainAt) kind[i] = T.MOUNTAIN;
    else if (elev[i] >= hillAt) kind[i] = T.HILL;
    else if (moist[i] >= forestAt) kind[i] = T.FOREST;
    else kind[i] = T.GRASS;
  }

  return { w, h, kind, elev, moist, ford, flow, seed: s };
}

// ------------------------------------------------------------------ queries

export function tileIndex(tx, ty) {
  return ty * MAP.w + tx;
}

export function tileAt(wx, wy) {
  return [
    Math.max(0, Math.min(MAP.w - 1, Math.floor(wx / TILE))),
    Math.max(0, Math.min(MAP.h - 1, Math.floor(wy / TILE))),
  ];
}

export function tileCentre(tx, ty) {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

/** Terrain cost of a tile, ignoring roads. */
export function terrainCost(terrain, i) {
  const k = terrain.kind[i];
  if (k === T.WATER) return terrain.ford[i] ? FORD_COST : BASE_COST[T.WATER];
  return BASE_COST[k];
}
