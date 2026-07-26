// scenery.js — trees, crags, boulders and reeds.
//
// Scenery is a *view* of the terrain, not part of the game state. It is derived
// from the same seed, so it costs nothing to store and comes back identically
// on the other side of a save. The sim has no idea it exists — a traveller
// walks through a forest tile, not around a tree.
//
// Two things make it feel connected to the sim anyway: anything standing on a
// worn tile stops being drawn (the road cleared it), and anything a new
// building lands on is removed for good.

import { MAP, TILE, WORLD, T } from '../sim/terrain.js';
import { ROAD_MIN } from '../sim/roads.js';
import { hash3 } from '../sim/rng.js';
import { propMeta } from '../props.js';

const STEP = 14;

/** Minimum spacing by prop family — canopies turn to mush without it. */
function gapFor(name) {
  if (name.startsWith('tree') || name.startsWith('pine')) return 22;
  if (name.startsWith('crag')) return 26;
  return 10;
}

export function buildScenery(terrain) {
  const out = [];
  // Spatial buckets, so the spacing check stays O(1) instead of O(n²).
  const cell = 32;
  const cols = Math.ceil(WORLD.w / cell);
  const buckets = new Map();
  const key = (x, y) => Math.floor(y / cell) * cols + Math.floor(x / cell);

  const tooClose = (x, y, gap) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const list = buckets.get((cy + j) * cols + (cx + i));
        if (!list) continue;
        for (const q of list) {
          if (Math.hypot(q.x - x, q.y - y) < Math.max(gap, gapFor(q.name))) return true;
        }
      }
    }
    return false;
  };

  const place = (name, x, y) => {
    if (tooClose(x, y, gapFor(name))) return;
    const item = { name, x: Math.round(x), y: Math.round(y) };
    out.push(item);
    const k = key(x, y);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(item);
  };

  const nearWater = (tx, ty) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = tx + dx, y = ty + dy;
        if (x < 0 || y < 0 || x >= MAP.w || y >= MAP.h) continue;
        if (terrain.kind[y * MAP.w + x] === T.WATER) return true;
      }
    }
    return false;
  };

  let n = 0;
  for (let gy = STEP; gy < WORLD.h - STEP; gy += STEP) {
    for (let gx = STEP; gx < WORLD.w - STEP; gx += STEP) {
      const r1 = hash3(gx, gy, 11);
      const r2 = hash3(gx, gy, 23);
      const r3 = hash3(gx, gy, 37);
      const x = gx + (r1 - 0.5) * STEP * 0.9;
      const y = gy + (r2 - 0.5) * STEP * 0.9;
      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h) continue;
      const i = ty * MAP.w + tx;
      const kind = terrain.kind[i];
      n++;

      if (kind === T.WATER) continue;

      if (nearWater(tx, ty) && r3 < 0.45) {
        place(`reeds${(r1 * 2) | 0}`, x, y);
        continue;
      }

      switch (kind) {
        case T.FOREST:
          if (r3 < 0.5) {
            // A few conifers mixed in, more of them on the higher ground.
            const conifer = terrain.elev[i] > 0.5 ? 0.45 : 0.16;
            place(r1 < conifer ? `pine${(r2 * 2) | 0}` : `tree${(r2 * 3) | 0}`, x, y);
          } else if (r3 < 0.78) {
            place(`bush${(r1 * 3) | 0}`, x, y);
          }
          break;
        case T.MOUNTAIN:
          if (r3 < 0.34) place(`crag${(r1 * 3) | 0}`, x, y);
          else if (r3 < 0.46) place(`rock${(r2 * 2) | 0}`, x, y);
          break;
        case T.HILL:
          if (r3 < 0.1) place(`rock${(r2 * 2) | 0}`, x, y);
          else if (r3 < 0.17) place(r1 < 0.4 ? `pine${(r2 * 2) | 0}` : `bush${(r1 * 3) | 0}`, x, y);
          break;
        default:
          if (r3 < 0.045) place(`tree${(r2 * 3) | 0}`, x, y);
          else if (r3 < 0.09) place(`bush${(r1 * 3) | 0}`, x, y);
          else if (r3 < 0.14) place(`flowers${(r2 * 2) | 0}`, x, y);
      }
    }
  }

  out.sort((a, b) => a.y - b.y);
  return out;
}

/**
 * Clear anything standing where a building just went up.
 * `propName` is a real prop, so the cleared area matches the sprite's width
 * rather than a guess.
 */
export function clearAround(scenery, x, y, propName) {
  const meta = propName ? propMeta(propName) : null;
  const rx = (meta ? meta.w : 26) * 0.6 + 6;
  const ry = 18;
  return scenery.filter((q) => Math.abs(q.x - x) > rx || Math.abs(q.y - y) > ry);
}

/** True once the road has worn through where this prop stands. */
export function trampled(state, q) {
  const tx = Math.floor(q.x / TILE), ty = Math.floor(q.y / TILE);
  if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h) return false;
  return state.wear[ty * MAP.w + tx] > ROAD_MIN;
}
