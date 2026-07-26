// state.js — the game, as data.
//
// Everything the simulation *is* lives in the object this file builds, and
// nothing in here imports a renderer, touches the DOM or creates a canvas. That
// separation is the point: a game state that is only ever plain numbers can be
// stepped headlessly, diffed, snapshotted between frames, written to
// localStorage, and handed to another client that will reproduce it exactly.
//
// The snapshot format leans on one observation: the map is a pure function of
// the seed, so the only thing worth storing is what the sim has *changed* —
// road wear, towns, and who is currently walking about. That takes a
// 240x160 world from ~1 MB of terrain down to a few kilobytes.

import { Rng } from './rng.js';
import { generateTerrain, MAP, TILE, WORLD } from './terrain.js';
import { decayWear, roadFrac, ROAD_MIN, WEAR_MAX } from './roads.js';
import { considerFounding, growTown } from './towns.js';
import {
  findGates, spawnTraveler, spawnResident, updateTravelers, creditPassers, MAX_TRAVELERS,
} from './travelers.js';

export const SAVE_VERSION = 2;
export { WORLD, MAP, TILE };

const SPAWN_MIN = 1.1;
const SPAWN_MAX = 2.6;

export function createState(seed = (Math.random() * 1e9) | 0) {
  const s = seed >>> 0 || 1;
  const terrain = generateTerrain(s);
  const state = {
    version: SAVE_VERSION,
    seed: s,
    time: 0,
    rng: new Rng(s ^ 0x5f3759df),
    terrain,
    wear: new Float32Array(MAP.w * MAP.h),
    gates: findGates(terrain),
    towns: [],
    travelers: [],
    nextId: 1,
    stats: { travelers: 0, trades: 0, paths: 0, distance: 0, roadTiles: 0 },
    // Transient. The renderer drains this every frame; it is never serialized,
    // because a popup that has already played has nothing to restore.
    events: [],
    timers: { spawn: 0.5, upkeep: 0, found: 6, residents: 4 },
  };
  return state;
}

// ------------------------------------------------------------------- stepping

export function step(state, dt) {
  state.time += dt;

  const tm = state.timers;

  tm.spawn -= dt;
  if (tm.spawn <= 0) {
    spawnTraveler(state);
    tm.spawn = state.rng.range(SPAWN_MIN, SPAWN_MAX);
  }

  updateTravelers(state, dt);

  // Housekeeping runs on its own clock. None of it needs frame resolution, and
  // the map-wide passes are wasteful at 60Hz.
  tm.upkeep -= dt;
  if (tm.upkeep <= 0) {
    const elapsed = 1.0;
    creditPassers(state);
    decayWear(state.wear, elapsed);
    for (const town of state.towns) growTown(state, town);
    tm.upkeep = elapsed;
  }

  tm.found -= dt;
  if (tm.found <= 0) {
    considerFounding(state);
    tm.found = 5;
    state.stats.roadTiles = countRoads(state);
  }

  // Towns fill up with people who live there once there's something to live in.
  tm.residents -= dt;
  if (tm.residents <= 0) {
    tm.residents = 3;
    for (const town of state.towns) {
      const want = Math.min(7, Math.floor(town.buildings.length / 2));
      const have = state.travelers.filter((t) => t.resident === town.id).length;
      if (have < want && state.travelers.length < MAX_TRAVELERS + 20) spawnResident(state, town);
    }
  }
}

function countRoads(state) {
  let n = 0;
  for (let i = 0; i < state.wear.length; i++) if (state.wear[i] > ROAD_MIN) n++;
  return n;
}

/** Fraction of the map that has worn into road, for the HUD. */
export function roadCoverage(state) {
  return state.stats.roadTiles / state.wear.length;
}

// --------------------------------------------------------------- wear codec
//
// Two things make the wear field cheap to store. It is quantised to 64 levels —
// about 0.04 of wear per step, far finer than anything visible or than anything
// the cost function reacts to — and everything below a faint scuff is snapped
// to zero. Most of the map is then long runs of zero, which run-length encodes
// to nothing, and the roads themselves compress to a few kilobytes.

const WEAR_LEVELS = 63;
/** Below this, a tile is untrodden as far as a save is concerned. */
const WEAR_DEADZONE = 0.03;

function encodeWear(wear) {
  const bytes = [];
  let runVal = -1, runLen = 0;
  const flush = () => {
    while (runLen > 0) {
      const n = Math.min(255, runLen);
      bytes.push(runVal, n);
      runLen -= n;
    }
  };
  for (let i = 0; i < wear.length; i++) {
    const w = wear[i] < WEAR_DEADZONE ? 0 : wear[i];
    const q = Math.max(0, Math.min(WEAR_LEVELS, Math.round((w / WEAR_MAX) * WEAR_LEVELS)));
    if (q === runVal) runLen++;
    else { flush(); runVal = q; runLen = 1; }
  }
  flush();

  // btoa in chunks: String.fromCharCode.apply on 100k+ args blows the stack.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.slice(i, i + CHUNK));
  }
  return btoa(binary);
}

function decodeWear(b64, out) {
  const binary = atob(b64);
  let at = 0;
  for (let i = 0; i + 1 < binary.length; i += 2) {
    const v = (binary.charCodeAt(i) / WEAR_LEVELS) * WEAR_MAX;
    const n = binary.charCodeAt(i + 1);
    for (let k = 0; k < n && at < out.length; k++) out[at++] = v;
  }
  return out;
}

// -------------------------------------------------------- snapshot / restore

/**
 * A complete, JSON-serialisable picture of the game.
 * Deliberately excludes anything derivable: terrain, gates and in-flight paths
 * are all rebuilt on restore.
 */
export function snapshot(state) {
  return {
    v: SAVE_VERSION,
    seed: state.seed,
    time: Math.round(state.time * 100) / 100,
    rng: state.rng.s,
    nextId: state.nextId,
    stats: { ...state.stats },
    timers: { ...state.timers },
    wear: encodeWear(state.wear),
    towns: state.towns.map((t) => ({
      id: t.id, name: t.name, x: t.x, y: t.y, founded: Math.round(t.founded),
      traffic: Math.round(t.traffic * 10) / 10, radius: Math.round(t.radius), arms: t.arms,
      buildings: t.buildings.map((b) => ({
        kind: b.kind, x: b.x, y: b.y, variant: b.variant, born: Math.round(b.born),
      })),
    })),
    travelers: state.travelers.map((t) => ({
      id: t.id, seed: t.seed, role: t.role,
      x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10,
      vx: Math.round(t.vx * 100) / 100, vy: Math.round(t.vy * 100) / 100,
      walked: Math.round(t.walked * 10) / 10,
      speed: Math.round(t.speed * 10) / 10,
      carry: t.carry, legs: t.legs, leg: t.leg,
      rest: Math.round(t.rest * 10) / 10, resident: t.resident,
    })),
  };
}

export function restore(snap) {
  if (!snap || typeof snap !== 'object') throw new Error('not a snapshot');
  if (snap.v !== SAVE_VERSION) {
    throw new Error(`snapshot is version ${snap.v}, this build reads ${SAVE_VERSION}`);
  }
  const state = createState(snap.seed);
  state.time = snap.time || 0;
  state.rng.s = (snap.rng >>> 0) || 1;
  state.nextId = snap.nextId || 1;
  Object.assign(state.stats, snap.stats || {});
  Object.assign(state.timers, snap.timers || {});
  decodeWear(snap.wear || '', state.wear);
  state.towns = (snap.towns || []).map((t) => ({ ...t, buildings: [...(t.buildings || [])] }));
  state.travelers = (snap.travelers || []).map((t) => ({
    ...t,
    path: null,     // recomputed on the traveller's next tick
    pi: 0,
    done: false,
  }));
  return state;
}

/** Convenience for the HUD and the road painter. */
export { roadFrac };
