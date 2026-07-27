// roads.js — desire paths.
//
// There is no road-building code in this game. There is only wear: a traveller
// scuffs the ground they walk over, worn ground is cheaper to walk over, and
// cheaper ground attracts the next traveller. That feedback loop is the entire
// road system, and it is why the first crossing of a river matters so much —
// whoever wades a ford makes it slightly easier for everyone after them, and a
// few hundred crossings later it is a bridge with a town on the bank.
//
// Wear is the only part of the map the sim mutates, so it is also the only part
// a snapshot has to store.

import { MAP, TILE, terrainCost } from './terrain.js';

/** Below this a tile is trampled grass; above it, it reads as a track. */
export const ROAD_MIN = 0.18;
/** Wear at which a tile is a proper made road and stops getting better. */
export const WEAR_FULL = 1.8;
export const WEAR_MAX = 2.6;

/** What a fully worn road costs to walk, whatever it was cut through. */
const ROAD_COST = 0.6;

/** Roads fade if nobody uses them. Slow — an abandoned road is still a road. */
const DECAY_HALFLIFE = 900;

export function roadFrac(w) {
  return w <= 0 ? 0 : Math.min(1, w / WEAR_FULL);
}

/**
 * What it costs to cross tile `i` right now.
 *
 * Note that this blends *toward* a flat road cost rather than scaling the
 * terrain down. That is deliberate: a well-made road over a mountain pass
 * should cost about what a road over grass costs, which is what makes a pass
 * worth wearing in at all.
 */
export function moveCost(terrain, wear, i) {
  const f = roadFrac(wear[i]);
  if (f <= 0) return terrainCost(terrain, i);
  return terrainCost(terrain, i) * (1 - f) + ROAD_COST * f;
}

// ------------------------------------------------------------ the touch log
//
// Wear is the one field the renderer has to chase every frame, and it used to
// find the changes by comparing all 117,600 tiles against what it had already
// painted. That scan cost more than the sim step it was chasing. Instead the
// sim writes down which tiles it scuffed, in the same spirit as `state.events`:
// a transient change-log the renderer drains and nothing serialises.
//
// Only *deposits* are logged. Decay touches every tile at once, and logging
// that would be the full-map scan again by another name — the renderer sweeps
// for it slowly instead, which is all a 900-second half-life needs.

/** Tiles the log can hold before it gives up and asks for a full repaint. */
const TOUCH_CAP = 8192;

export function createTouchLog() {
  return { idx: new Int32Array(TOUCH_CAP), flags: new Uint8Array(MAP.w * MAP.h), n: 0, overflow: false };
}

function touch(log, i) {
  if (!log || log.flags[i]) return;
  if (log.n >= TOUCH_CAP) { log.overflow = true; return; }
  log.flags[i] = 1;
  log.idx[log.n++] = i;
}

/** Called by the renderer once it has repainted everything the log listed. */
export function clearTouchLog(log) {
  for (let k = 0; k < log.n; k++) log.flags[log.idx[k]] = 0;
  log.n = 0;
  log.overflow = false;
}

/**
 * Scuff the ground under a traveller.
 *
 * The spill onto the four neighbours is what makes a road *widen* with traffic
 * instead of staying one tile across forever: a rarely used track never lifts
 * its neighbours past ROAD_MIN, a trunk road drags a two-tile verge along with
 * it.
 */
export function depositTrail(state, wx, wy, amount) {
  const { wear } = state;
  const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
  if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h) return;
  const log = state.wearTouched;
  const i = ty * MAP.w + tx;
  wear[i] = Math.min(WEAR_MAX, wear[i] + amount);
  touch(log, i);
  const spill = amount * 0.34;
  if (tx > 0) { wear[i - 1] = Math.min(WEAR_MAX, wear[i - 1] + spill); touch(log, i - 1); }
  if (tx < MAP.w - 1) { wear[i + 1] = Math.min(WEAR_MAX, wear[i + 1] + spill); touch(log, i + 1); }
  if (ty > 0) { wear[i - MAP.w] = Math.min(WEAR_MAX, wear[i - MAP.w] + spill); touch(log, i - MAP.w); }
  if (ty < MAP.h - 1) { wear[i + MAP.w] = Math.min(WEAR_MAX, wear[i + MAP.w] + spill); touch(log, i + MAP.w); }
}

/** Global fade. Cheap enough to run over the whole map; it's one pass of 38k. */
export function decayWear(wear, dt) {
  const k = Math.pow(0.5, dt / DECAY_HALFLIFE);
  for (let i = 0; i < wear.length; i++) {
    if (wear[i] > 0) {
      const v = wear[i] * k;
      wear[i] = v < 0.004 ? 0 : v;      // snap to zero so faint scuffs clear out
    }
  }
}

// ------------------------------------------------------------- junctions

// Sixteen samples on a ring. Counting *runs* of road around the ring is what
// distinguishes a crossroads from a wide road: a road passing through gives two
// opposite arms, a junction gives three or more.
const RING = [];
for (let a = 0; a < 16; a++) {
  RING.push([Math.round(Math.cos((a / 16) * Math.PI * 2) * 3), Math.round(Math.sin((a / 16) * Math.PI * 2) * 3)]);
}

/** How many distinct road arms leave this tile. */
export function armCount(wear, tx, ty) {
  const hits = [];
  for (const [dx, dy] of RING) {
    const x = tx + dx, y = ty + dy;
    const on = x >= 0 && y >= 0 && x < MAP.w && y < MAP.h && wear[y * MAP.w + x] > ROAD_MIN;
    hits.push(on);
  }
  let arms = 0;
  for (let a = 0; a < 16; a++) {
    if (hits[a] && !hits[(a + 15) % 16]) arms++;      // a run starts here
  }
  // All sixteen on (the middle of a plaza) is one blob, not sixteen arms.
  if (arms === 0 && hits[0]) arms = 1;
  return arms;
}

/**
 * Find the best place to found a town: a busy junction, well away from the
 * towns that already exist. Returns null if nothing qualifies yet.
 */
export function bestJunction(state, minArms, minWear, minDistance) {
  const { wear, towns } = state;
  let best = null;
  // Step 2 because a junction is several tiles wide; checking every tile just
  // costs time to find the same spot. The border margin keeps towns off the
  // edge of the world, where half the roads through them would be off-map.
  const EDGE = 26;
  for (let ty = EDGE; ty < MAP.h - EDGE; ty += 2) {
    for (let tx = EDGE; tx < MAP.w - EDGE; tx += 2) {
      const i = ty * MAP.w + tx;
      if (wear[i] < minWear) continue;
      const wx = (tx + 0.5) * TILE, wy = (ty + 0.5) * TILE;
      if (towns.some((t) => Math.hypot(t.x - wx, t.y - wy) < minDistance)) continue;
      const arms = armCount(wear, tx, ty);
      if (arms < minArms) continue;
      const score = wear[i] * arms;
      if (!best || score > best.score) {
        best = { tx, ty, x: wx, y: wy, arms, wear: wear[i], score };
      }
    }
  }
  return best;
}
