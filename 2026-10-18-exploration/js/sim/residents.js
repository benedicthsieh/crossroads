// residents.js — the people you only see when you go and look.
//
// A town's population is a number, not a list of bodies. `town.pop` can be
// eighty and the sim will still only ever walk a dozen figures around, because
// the rest are indoors, asleep, or simply not worth the pathfinding. That gap
// between "how many live here" and "how many are drawn" is the whole reason the
// map stopped feeling like an ant farm: population can grow without the screen
// filling up.
//
// Residents never leave their town. Anyone actually going somewhere is aboard a
// caravan, which is a different file and a different kind of object entirely.

import { MAP, TILE, tileIndex } from './terrain.js';
import { findPath } from './paths.js';
import { population } from './towns.js';

const ROLES = ['villager', 'matron', 'farmer', 'kid', 'guard', 'baker', 'peddler'];
const GOODS = ['wheat', 'bread', 'crate', 'basket', 'log'];

/**
 * How many of a town's people are actually walking about, given its population.
 * Sub-linear and hard-capped: a town of eighty shows a dozen, not eighty.
 */
const SHOWN_CAP = 12;
export function shownResidents(town) {
  return Math.min(SHOWN_CAP, Math.round(Math.sqrt(population(town)) * 1.5));
}

export function spawnResident(state, town) {
  const rng = state.rng;
  const r = {
    id: state.nextId++,
    seed: rng.int(100000),
    role: rng.pick(ROLES),
    town: town.id,
    x: town.x + rng.range(-24, 24),
    y: town.y + rng.range(-18, 18),
    vx: 0,
    vy: 1,
    walked: 0,
    speed: rng.range(11, 17),
    carry: null,
    goal: null,
    path: null,
    pi: 0,
    rest: rng.range(0, 4),
    done: false,
  };
  state.residents.push(r);
  return r;
}

/**
 * Pick somewhere to be.
 *
 * Weighted toward buildings, because a villager standing at a door reads as
 * somebody who lives here and a villager standing in a field reads as a bug.
 */
function errand(state, r) {
  const town = state.towns.find((t) => t.id === r.town);
  if (!town) { r.done = true; return; }
  const rng = state.rng;
  const spot = town.buildings.length && rng.chance(0.82)
    ? rng.pick(town.buildings)
    : { x: town.x + rng.range(-40, 40), y: town.y + rng.range(-30, 30) };
  r.goal = { x: spot.x, y: spot.y + 10 };
  r.path = null;
  r.pi = 0;
  r.carry = rng.chance(0.3) ? rng.pick(GOODS) : null;
}

export function updateResident(state, r, dt) {
  if (r.rest > 0) {
    r.rest -= dt;
    r.walked += dt * 0.6;              // keeps the idle sway ticking over
    return;
  }
  if (!r.goal) { errand(state, r); if (!r.goal) return; }

  // Residents move within one town, so a full A* is overkill for most trips.
  // Only bother when the direct line is long enough to matter.
  const dx = r.goal.x - r.x, dy = r.goal.y - r.y;
  const far = Math.hypot(dx, dy);
  if (far < 5) {
    r.rest = state.rng.range(2, 7);
    r.goal = null;
    return;
  }

  let tx = r.goal.x, ty = r.goal.y;
  if (far > 90) {
    if (!r.path) {
      const s = tileIndex(
        Math.max(0, Math.min(MAP.w - 1, Math.floor(r.x / TILE))),
        Math.max(0, Math.min(MAP.h - 1, Math.floor(r.y / TILE))),
      );
      const g = tileIndex(
        Math.max(0, Math.min(MAP.w - 1, Math.floor(r.goal.x / TILE))),
        Math.max(0, Math.min(MAP.h - 1, Math.floor(r.goal.y / TILE))),
      );
      r.path = findPath(state, s, g, r.seed) || [];
      r.pi = 0;
    }
    while (r.pi < r.path.length) {
      const idx = r.path[r.pi];
      const cx = (idx % MAP.w + 0.5) * TILE, cy = (((idx / MAP.w) | 0) + 0.5) * TILE;
      if (Math.hypot(cx - r.x, cy - r.y) < TILE) { r.pi++; continue; }
      tx = cx; ty = cy;
      break;
    }
  }

  const ax = tx - r.x, ay = ty - r.y;
  const d = Math.hypot(ax, ay) || 1;
  const dist = r.speed * dt;
  r.x += (ax / d) * dist;
  r.y += (ay / d) * dist;
  r.vx = ax / d;
  r.vy = ay / d;
  r.walked += dist;
  // Residents deliberately lay down no wear. A town would otherwise scuff a
  // solid disc of road around itself that no traveller ever chose to walk.
}

export function updateResidents(state, dt) {
  for (const r of state.residents) updateResident(state, r, dt);
  for (let i = state.residents.length - 1; i >= 0; i--) {
    if (state.residents[i].done) state.residents.splice(i, 1);
  }
}

/** Keep each town's visible crowd in step with how many people live there. */
export function balanceResidents(state) {
  const counts = new Map();
  for (const r of state.residents) counts.set(r.town, (counts.get(r.town) || 0) + 1);
  for (const town of state.towns) {
    const want = shownResidents(town);
    const have = counts.get(town.id) || 0;
    if (have < want) spawnResident(state, town);
    else if (have > want + 1) {
      const victim = state.residents.find((r) => r.town === town.id);
      if (victim) victim.done = true;
    }
  }
}
