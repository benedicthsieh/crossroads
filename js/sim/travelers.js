// travelers.js — the people who wear the roads in.
//
// A traveller is plain data: a position, a seed, an itinerary and an index into
// a path. It knows nothing about sprites — the seed is what the renderer turns
// into a face, so two clients restoring the same snapshot draw the same person.
//
// The important line in this file is the one that calls depositTrail(). Every
// other line exists to get somebody walking across ground they'd rather not
// walk across, so that the next person doesn't have to.

import { MAP, TILE, T, tileIndex, tileCentre, terrainCost } from './terrain.js';
import { depositTrail, moveCost } from './roads.js';
import { findPath } from './paths.js';
import { townAt } from './towns.js';

export const MAX_TRAVELERS = 46;

/** Wear laid down per world unit walked. The road-formation rate, basically. */
const WEAR_PER_UNIT = 0.014;

const ROLES = ['traveler', 'traveler', 'peddler', 'merchant', 'farmer', 'villager'];
const RESIDENT_ROLES = ['villager', 'matron', 'farmer', 'kid', 'guard', 'baker'];
const GOODS = ['wheat', 'bread', 'crate', 'basket', 'log'];

/**
 * Places travellers enter and leave the world.
 *
 * Derived from the terrain, so they're recomputed on load rather than stored: a
 * gate is only useful where the border is actually walkable, and putting one in
 * a mountain wall would just make travellers batter at a cliff.
 */
export function findGates(terrain) {
  const gates = [];
  const consider = (tx, ty, ox, oy) => {
    // Search along the edge for the cheapest tile in this stretch.
    let best = null;
    for (let k = -4; k <= 4; k++) {
      const x = tx + (oy !== 0 ? k : 0);
      const y = ty + (ox !== 0 ? k : 0);
      if (x < 1 || y < 1 || x >= MAP.w - 1 || y >= MAP.h - 1) continue;
      const i = tileIndex(x, y);
      if (terrain.kind[i] === T.WATER || terrain.kind[i] === T.MOUNTAIN) continue;
      const c = terrainCost(terrain, i);
      if (!best || c < best.c) best = { x, y, c };
    }
    if (best) gates.push({ tx: best.x, ty: best.y, ...tileCentre(best.x, best.y) });
  };

  // Sparse on purpose. Every extra gate is another corridor for traffic to
  // spread across, and a road network only forms where traffic concentrates.
  const stride = 34;
  for (let x = stride; x < MAP.w - stride / 2; x += stride) {
    consider(x, 2, 0, 1);
    consider(x, MAP.h - 3, 0, 1);
  }
  for (let y = stride; y < MAP.h - stride / 2; y += stride) {
    consider(2, y, 1, 0);
    consider(MAP.w - 3, y, 1, 0);
  }
  return gates;
}

// ------------------------------------------------------------- itineraries

function weightedTown(state, rng, exclude) {
  const pool = state.towns.filter((t) => t.id !== exclude);
  if (!pool.length) return null;
  let total = 0;
  for (const t of pool) total += 1 + t.buildings.length;
  let r = rng.next() * total;
  for (const t of pool) {
    r -= 1 + t.buildings.length;
    if (r <= 0) return t;
  }
  return pool[pool.length - 1];
}

/**
 * Where this traveller is going, in order.
 *
 * Before any towns exist everyone is just crossing the map, which is exactly
 * what's needed — those crossings are what carve the first junctions. Once
 * towns are on the map they start pulling traffic through themselves, which is
 * how a small town becomes a big one.
 */
function planLegs(state, rng, from) {
  const legs = [];
  const far = state.gates.filter((g) => Math.hypot(g.x - from.x, g.y - from.y) > 520);
  const exit = far.length ? rng.pick(far) : rng.pick(state.gates);

  if (state.towns.length && rng.chance(0.72)) {
    const a = weightedTown(state, rng, -1);
    if (a) legs.push({ x: a.x, y: a.y, kind: 'town', townId: a.id });
    if (state.towns.length > 1 && rng.chance(0.4)) {
      const b = weightedTown(state, rng, a ? a.id : -1);
      if (b) legs.push({ x: b.x, y: b.y, kind: 'town', townId: b.id });
    }
  }
  legs.push({ x: exit.x, y: exit.y, kind: 'gate' });
  return legs;
}

export function spawnTraveler(state) {
  if (state.travelers.length >= MAX_TRAVELERS) return null;
  const rng = state.rng;
  const gate = rng.pick(state.gates);
  if (!gate) return null;

  const t = {
    id: state.nextId++,
    seed: rng.int(100000),
    role: rng.pick(ROLES),
    x: gate.x,
    y: gate.y,
    vx: 0,
    vy: 1,
    walked: 0,
    speed: rng.range(17, 25),
    carry: rng.chance(0.55) ? rng.pick(GOODS) : null,
    legs: null,
    leg: 0,
    path: null,
    pi: 0,
    rest: 0,
    resident: null,
    done: false,
  };
  t.legs = planLegs(state, rng, gate);
  state.travelers.push(t);
  state.stats.travelers++;
  return t;
}

/** Somebody who lives in a town and pootles about between its buildings. */
export function spawnResident(state, town) {
  const rng = state.rng;
  const t = {
    id: state.nextId++,
    seed: rng.int(100000),
    role: rng.pick(RESIDENT_ROLES),
    x: town.x + rng.range(-20, 20),
    y: town.y + rng.range(-14, 14),
    vx: 0,
    vy: 1,
    walked: 0,
    speed: rng.range(12, 18),
    carry: null,
    legs: [],
    leg: 0,
    path: null,
    pi: 0,
    rest: rng.range(0, 3),
    resident: town.id,
    done: false,
  };
  state.travelers.push(t);
  return t;
}

function residentErrand(state, t) {
  const town = state.towns.find((x) => x.id === t.resident);
  if (!town) { t.done = true; return; }
  const rng = state.rng;
  const spot = town.buildings.length && rng.chance(0.8)
    ? rng.pick(town.buildings)
    : { x: town.x + rng.range(-30, 30), y: town.y + rng.range(-22, 22) };
  t.legs = [{ x: spot.x, y: spot.y + 8, kind: 'errand' }];
  t.leg = 0;
  t.path = null;
  t.carry = rng.chance(0.35) ? rng.pick(GOODS) : null;
}

// ----------------------------------------------------------------- movement

function repath(state, t) {
  const leg = t.legs[t.leg];
  if (!leg) { t.done = true; return; }
  const [sx, sy] = [
    Math.max(0, Math.min(MAP.w - 1, Math.floor(t.x / TILE))),
    Math.max(0, Math.min(MAP.h - 1, Math.floor(t.y / TILE))),
  ];
  const [gx, gy] = [
    Math.max(0, Math.min(MAP.w - 1, Math.floor(leg.x / TILE))),
    Math.max(0, Math.min(MAP.h - 1, Math.floor(leg.y / TILE))),
  ];
  t.path = findPath(state, tileIndex(sx, sy), tileIndex(gx, gy), t.seed);
  t.pi = 0;
  state.stats.paths++;
}

function arriveLeg(state, t) {
  const leg = t.legs[t.leg];
  if (leg && leg.kind === 'town') {
    const town = state.towns.find((x) => x.id === leg.townId);
    if (town) {
      town.traffic += 1;
      state.stats.trades++;
      const give = t.carry;
      const got = state.rng.pick(GOODS);
      t.carry = got;
      state.events.push({ type: 'trade', x: t.x, y: t.y, give: give || 'coin', get: got });
    }
    t.rest = state.rng.range(1.4, 3.4);
  } else if (leg && leg.kind === 'errand') {
    t.rest = state.rng.range(1.5, 5);
  }
  t.leg++;
  t.path = null;
  if (t.leg >= t.legs.length) {
    if (t.resident) residentErrand(state, t);
    else t.done = true;
  }
}

export function updateTraveler(state, t, dt) {
  if (t.rest > 0) {
    t.rest -= dt;
    t.walked += dt * 0.6;             // keeps the idle sway ticking over
    return;
  }
  if (!t.legs || t.leg >= t.legs.length) {
    if (t.resident) residentErrand(state, t);
    else { t.done = true; return; }
  }
  const leg = t.legs[t.leg];
  if (!leg) { t.done = true; return; }

  if (!t.path) {
    repath(state, t);
    if (!t.path) {
      // A* gave up (rare — usually a traveller boxed in by water). Beeline it;
      // the map is small enough that this always resolves.
      t.path = null;
      const dx = leg.x - t.x, dy = leg.y - t.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < 6) { arriveLeg(state, t); return; }
      step(state, t, dx / d, dy / d, dt, 0.6);
      return;
    }
  }

  // Aim at the next tile centre, with a small fixed sideways offset per person
  // so a busy road looks like a road and not a tightrope.
  let target = null;
  while (t.pi < t.path.length) {
    const idx = t.path[t.pi];
    const c = tileCentre(idx % MAP.w, (idx / MAP.w) | 0);
    if (Math.hypot(c.x - t.x, c.y - t.y) < TILE * 0.9) { t.pi++; continue; }
    target = c;
    break;
  }
  if (!target) {
    const d = Math.hypot(leg.x - t.x, leg.y - t.y);
    if (d < TILE * 1.6) { arriveLeg(state, t); return; }
    target = leg;
  }

  const dx = target.x - t.x, dy = target.y - t.y;
  const d = Math.hypot(dx, dy) || 1;
  step(state, t, dx / d, dy / d, dt, 1);
}

function step(state, t, nx, ny, dt, scale) {
  const i = tileIndex(
    Math.max(0, Math.min(MAP.w - 1, Math.floor(t.x / TILE))),
    Math.max(0, Math.min(MAP.h - 1, Math.floor(t.y / TILE))),
  );
  // Rough ground is slow to cross as well as expensive to choose. Without this
  // the cost field would be the only thing terrain affects, and mountains would
  // feel the same as meadow once a road existed.
  const c = moveCost(state.terrain, state.wear, i);
  const pace = Math.max(0.34, Math.min(1.15, 1.6 / Math.pow(c, 0.6)));
  const dist = t.speed * pace * scale * dt;

  t.x += nx * dist;
  t.y += ny * dist;
  t.vx = nx;
  t.vy = ny;
  t.walked += dist;
  depositTrail(state, t.x, t.y, dist * WEAR_PER_UNIT);
  state.stats.distance += dist;
}

/** Everyone, one tick. Returns the number removed. */
export function updateTravelers(state, dt) {
  let removed = 0;
  for (const t of state.travelers) updateTraveler(state, t, dt);
  for (let i = state.travelers.length - 1; i >= 0; i--) {
    const t = state.travelers[i];
    if (!t.done) continue;
    state.travelers.splice(i, 1);
    removed++;
  }
  return removed;
}

/** Credit towns for traffic simply passing through, not just stopping. */
export function creditPassers(state) {
  for (const t of state.travelers) {
    if (t.resident) continue;
    const town = townAt(state, t.x, t.y, 60);
    if (town) town.traffic += 0.25;
  }
}
