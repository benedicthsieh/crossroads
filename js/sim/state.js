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
import { decayWear, roadFrac, ROAD_MIN, WEAR_MAX, bestJunction } from './roads.js';
import { growTown, growPopulation, totalPopulation, TOWN_SPACING, housing, population } from './towns.js';
import {
  findGates, spawnBorderCaravan, spawnTownCaravan, spawnTradeCaravan, borderInterval,
  updateCaravans, creditPassers, MAX_CARAVANS,
} from './caravans.js';
import { updateResidents, balanceResidents } from './residents.js';

export const SAVE_VERSION = 3;
export { WORLD, MAP, TILE };

/** How full a town has to be before its surplus starts leaving as caravans. */
const EMIGRATE_FULL = 0.72;

/**
 * How worn a junction must be before anyone will consider settling it.
 * Together with the wear rate in caravans.js this is what paces the whole
 * game: it is the gap between "there is a track here" and "this is a place".
 */
const FOUND_WEAR = 0.95;

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
    caravans: [],
    residents: [],
    // The best unclaimed crossroads on the map right now, or null. Derived from
    // the wear field on a slow timer and cached here because every caravan that
    // finishes a leg wants to know about it, and the scan is not cheap.
    frontier: null,
    nextId: 1,
    stats: {
      caravans: 0, souls: 0, settled: 0, trades: 0, paths: 0, distance: 0, roadTiles: 0,
    },
    // Transient. The renderer drains this every frame; it is never serialized,
    // because a popup that has already played has nothing to restore.
    events: [],
    timers: { spawn: 2, upkeep: 0, frontier: 4, residents: 3 },
  };
  return state;
}

// ------------------------------------------------------------------- stepping

export function step(state, dt) {
  state.time += dt;

  const tm = state.timers;

  // Arrivals from off the map. Frequent at first, rare once the world has
  // towns of its own — by then most traffic is towns talking to each other.
  tm.spawn -= dt;
  if (tm.spawn <= 0) {
    spawnBorderCaravan(state);
    tm.spawn = borderInterval(state, state.rng);
  }

  updateCaravans(state, dt);
  updateResidents(state, dt);

  // Housekeeping runs on its own clock. None of it needs frame resolution, and
  // the map-wide passes are wasteful at 60Hz.
  tm.upkeep -= dt;
  if (tm.upkeep <= 0) {
    const elapsed = 1.0;
    creditPassers(state);
    decayWear(state.wear, elapsed);
    for (const town of state.towns) {
      growTown(state, town);
      growPopulation(state, town, elapsed);
      considerEmigration(state, town);
      considerTrade(state, town);
    }
    tm.upkeep = elapsed;
  }

  // The frontier scan is the expensive one: every caravan deciding where to go
  // reads the result, but none of them need it fresher than this.
  tm.frontier -= dt;
  if (tm.frontier <= 0) {
    tm.frontier = 6;
    state.frontier = bestJunction(state, 3, FOUND_WEAR, TOWN_SPACING);
    state.stats.roadTiles = countRoads(state);
  }

  // Keep each town's visible crowd in step with how many people live there.
  tm.residents -= dt;
  if (tm.residents <= 0) {
    tm.residents = 3;
    balanceResidents(state);
  }
}

/**
 * A town with more people than it knows what to do with sends some away.
 *
 * This is what shifts the source of traffic from the borders to the map itself.
 * A full town keeps pushing caravans out; those caravans wear the roads between
 * settlements, feed the towns they pass through, and eventually found or fill
 * the next one. Nothing tells them to — they are just surplus with somewhere to
 * be.
 */
function considerEmigration(state, town) {
  if (state.caravans.length >= MAX_CARAVANS) return;
  const beds = housing(town);
  if (population(town) < beds * EMIGRATE_FULL) return;
  if (town.buildings.length < 3) return;
  const crowding = population(town) / Math.max(1, beds);
  if (state.rng.chance(0.02 * crowding)) spawnTownCaravan(state, town);
}

/**
 * A town sending a trade run to its neighbours.
 *
 * Emigration alone cannot keep the map busy: a town can only export people as
 * fast as it grows them, which works out at a caravan every couple of minutes.
 * Trade runs come *back*, so they cost the town nothing permanent and can leave
 * far more often. This is what stops the late game looking deserted, and what
 * keeps the roads between towns from decaying once the borders go quiet.
 */
function considerTrade(state, town) {
  if (state.caravans.length >= MAX_CARAVANS) return;
  if (state.towns.length < 2) return;
  if (town.buildings.length < 4) return;
  if (population(town) < 25) return;
  // Busier towns trade more, so a trunk-road town visibly out-trades a quiet one.
  const rate = 0.010 + 0.0012 * Math.min(12, town.buildings.length);
  if (state.rng.chance(rate)) spawnTradeCaravan(state, town);
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
      traffic: Math.round(t.traffic * 10) / 10, pop: Math.round(t.pop * 10) / 10,
      radius: Math.round(t.radius), arms: t.arms,
      buildings: t.buildings.map((b) => ({
        kind: b.kind, x: b.x, y: b.y, variant: b.variant, born: Math.round(b.born),
      })),
    })),
    caravans: state.caravans.map((c) => ({
      id: c.id, seed: c.seed,
      x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10,
      vx: Math.round(c.vx * 100) / 100, vy: Math.round(c.vy * 100) / 100,
      walked: Math.round(c.walked * 10) / 10,
      speed: Math.round(c.speed * 10) / 10,
      wagons: c.wagons, souls: c.souls, carry: c.carry, goal: c.goal,
      legs: c.legs, leg: c.leg, home: c.home,
      rest: Math.round(c.rest * 10) / 10, origin: c.origin,
    })),
    // Residents are a *sample* of a town's population, not the population
    // itself — `town.pop` is the real number. They're stored anyway so a
    // restored town doesn't briefly stand empty while the sampler catches up.
    residents: state.residents.map((r) => ({
      id: r.id, seed: r.seed, role: r.role, town: r.town,
      x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
      vx: Math.round(r.vx * 100) / 100, vy: Math.round(r.vy * 100) / 100,
      walked: Math.round(r.walked * 10) / 10,
      speed: Math.round(r.speed * 10) / 10,
      carry: r.carry, rest: Math.round(r.rest * 10) / 10,
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
  state.towns = (snap.towns || []).map((t) => ({
    pop: 0, ...t, buildings: [...(t.buildings || [])],
  }));
  state.caravans = (snap.caravans || []).map((c) => ({
    ...c,
    path: null,     // recomputed on the caravan's next tick
    pi: 0,
    done: false,
  }));
  state.residents = (snap.residents || []).map((r) => ({
    ...r,
    goal: null,
    path: null,
    pi: 0,
    done: false,
  }));
  return state;
}

/** Convenience for the HUD and the road painter. */
export { roadFrac, totalPopulation };
