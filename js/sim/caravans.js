// caravans.js — the wagon trains, and the only thing on the map that chooses.
//
// A caravan is one pathing entity carrying a few dozen people. That single
// change is what fixes the scale of the game: a hundred souls crossing the map
// used to be a hundred little figures scattered over the grass, which read as
// a crowd milling about rather than as traffic. Bundled into wagons, the same
// hundred souls are five or six objects, each of which is legible at whole-map
// zoom and each of which lays down a road-sized amount of wear.
//
// The other thing a caravan has that a lone walker never did is a *decision*.
// Every leg it finishes, it scores its options — push on to the far border,
// stop at a town, or stop at an empty crossroads and start one — and takes the
// best. Towns therefore appear because somebody chose to stop, not because a
// global rule noticed a busy junction. See `docs/EMERGENCE.md`.
//
// Everything in here is plain data and deterministic. All randomness goes
// through `state.rng` or through `hash3`.

import { MAP, TILE, T, tileIndex, tileCentre, terrainCost } from './terrain.js';
import { depositTrail, moveCost } from './roads.js';
import { findPath } from './paths.js';
import { townAt, TOWN_SPACING, MAX_TOWNS, foundTown, housing, population } from './towns.js';

/** People in one covered wagon. Fixed, so `souls` and `wagons` never disagree. */
export const SOULS_PER_WAGON = 5;
export const MAX_WAGONS = 3;

/**
 * How many caravans may be on the road at once. Small on purpose — this is the
 * number that decides how busy the map *looks*, and a dozen wagon trains on a
 * 420x280 map is a trade route, not a crowd.
 *
 * Set a little above the steady state the spawn rates actually produce. When
 * this cap binds it stops being a safety limit and starts being policy: border
 * arrivals and emigrants both bail out at it, so a map saturated with trade
 * runs would quietly stop founding and filling towns altogether.
 */
export const MAX_CARAVANS = 22;

/**
 * Wear laid down per world unit, per wagon. A loaded wagon cuts ruts a walker
 * never would, which is what lets a handful of caravans wear in roads at the
 * same rate a few dozen individual travellers used to.
 */
const WEAR_PER_UNIT = 0.015;
const wearRate = (c) => WEAR_PER_UNIT * (1.4 + 0.6 * c.wagons);

const GOODS = ['wheat', 'bread', 'crate', 'basket', 'log'];

// ------------------------------------------------------------------- gates

/**
 * Places caravans enter and leave the world.
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
    for (let k = -5; k <= 5; k++) {
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

  // Sparse on purpose, and kept sparse as the map grew. Every extra gate is
  // another corridor for traffic to spread across, and a road network only
  // forms where traffic concentrates.
  const stride = 48;
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

// ------------------------------------------------------------ the objective
//
// One function, three kinds of option, all scored in the same made-up units so
// they can be compared directly. The weights below are the whole design: they
// are what decides whether this map ends up with two big cities or nine
// hamlets, and they are the first thing to reach for if the emergence needs
// adjusting.

const W = {
  /** Pull of an empty bed. The main reason a caravan joins a town at all. */
  vacancy: 0.85,
  /** Pull of a town that is visibly doing well. */
  prosperity: 0.30,
  /** What a thousand world units of travel costs you. */
  distance: 1.55,
  /** Value of each road arm past the second at a candidate crossroads. */
  arms: 0.95,
  /** Value of the wear already on that crossroads — somebody else's road. */
  wear: 0.80,
  /** Value of elbow room around a candidate site. */
  room: 1.20,
  /** Flat cost of founding anything at all. Keeps hamlets from sprouting. */
  founding: 1.95,
  /** How much the world's remaining appetite for settlement is worth. */
  frontier: 2.8,
  /** How much a caravan enjoys simply being on the road, before it tires. */
  wanderlust: 2.05,
};

/**
 * How keen the world still is on new settlement, 1 down to ~0.
 *
 * This is the dial that makes the map *converge*. Early on there is nowhere to
 * go, so founding is cheap and the first crossroads get claimed fast. As the
 * clock runs on, the same crossroads scores lower and lower, and caravans
 * increasingly prefer somewhere that already has a roof and a market. Without
 * it a long game slowly fills every junction with a village.
 *
 * The half-life has to outlast the *road network*, not the clock. Set to 1400
 * it decayed faster than junctions matured: a diagnostic run found a textbook
 * crossroads — three arms, well worn, 1288 units from the nearest town — that
 * no caravan would touch, because by the time it existed founding had already
 * been priced out. Two towns, and the map stopped. The frontier has to stay
 * open at least as long as it takes a third and fourth crossroads to form.
 */
const FRONTIER_HALFLIFE = 2600;
export function frontierPressure(state) {
  return Math.pow(0.5, state.time / FRONTIER_HALFLIFE);
}

/** Distance a caravan will happily keep travelling before it starts looking for a home. */
const ROAM_RANGE = 3400;

/** A caravan needs this many people aboard before it can start a town alone. */
const FOUND_SOULS = 11;

/** Everything a settlement offers, normalised to roughly 0..2. */
function townDraw(state, town) {
  const free = Math.max(0, housing(town) - population(town));
  return {
    vacancy: Math.min(2, free / 8),
    prosperity: Math.min(2, town.buildings.length / 9),
  };
}

const legCost = (from, to) => Math.hypot(to.x - from.x, to.y - from.y) / 1000;

/**
 * Score every option this caravan has and return the best one.
 *
 * Deliberately greedy and deliberately noisy. The jitter is per-caravan and
 * comes out of the seeded rng, so it is reproducible, and it is what stops
 * every caravan on the map making the same call at the same crossroads.
 */
export function chooseGoal(state, c) {
  const rng = state.rng;
  const here = { x: c.x, y: c.y };
  const options = [];

  // --- stop at a town that has room -----------------------------------------
  // A town with no spare beds is not an option at all, however close it is.
  // Scoring it low is not enough: a caravan standing in the middle of a full
  // town has a travel cost of zero, so "low" still wins, and it spends the rest
  // of the game arriving at a place that will not have it.
  for (const town of state.towns) {
    const d = townDraw(state, town);
    if (d.vacancy <= 0) continue;
    const score = d.vacancy * W.vacancy
      + d.prosperity * W.prosperity
      - legCost(here, town) * W.distance
      + rng.range(-0.25, 0.25);
    options.push({ kind: 'join', score, town });
  }

  // --- stop at an empty crossroads and start one ----------------------------
  // Only worth evaluating if this caravan is big enough to be a village on its
  // own; a single wagon that stops in the middle of nowhere is just lost.
  // `state.frontier` is the best unclaimed junction on the map, recomputed on
  // its own slow timer rather than here — scanning 29,000 tiles every time a
  // caravan finishes a leg would dominate the whole simulation.
  if (c.souls >= FOUND_SOULS && state.towns.length < MAX_TOWNS
      && state.time >= (c.noFoundUntil || 0)) {
    const spot = state.frontier;
    if (spot) {
      const room = Math.min(1, nearestTownDistance(state, spot) / (TOWN_SPACING * 1.6));
      const score = (spot.arms - 2) * W.arms
        + Math.min(1.5, spot.wear) * W.wear
        + room * W.room
        + frontierPressure(state) * W.frontier
        - legCost(here, spot) * W.distance
        - W.founding
        + rng.range(-0.3, 0.3);
      options.push({ kind: 'found', score, spot });
    }
  }

  // --- keep going, and leave by a far border --------------------------------
  // Wanderlust decays with distance already walked, so a caravan that has
  // crossed half the map is measurably more willing to stop than one that just
  // came through the gate. That is the whole reason the map fills in rather
  // than settling the first junction anybody trips over.
  const exit = farGate(state, here, rng);
  if (exit) {
    const tired = Math.exp(-c.walked / ROAM_RANGE);
    const score = W.wanderlust * tired
      - legCost(here, exit) * W.distance * 0.35
      + rng.range(-0.2, 0.2);
    options.push({ kind: 'cross', score, exit });
  }

  let best = null;
  for (const o of options) if (!best || o.score > best.score) best = o;
  return best;
}

function nearestTownDistance(state, at) {
  let best = Infinity;
  for (const t of state.towns) best = Math.min(best, Math.hypot(t.x - at.x, t.y - at.y));
  return best === Infinity ? TOWN_SPACING * 2 : best;
}

/** A gate a good way off, so "crossing the map" actually crosses some of it. */
function farGate(state, from, rng) {
  const far = state.gates.filter((g) => Math.hypot(g.x - from.x, g.y - from.y) > 900);
  const pool = far.length ? far : state.gates;
  return pool.length ? rng.pick(pool) : null;
}

// ------------------------------------------------------------------ spawning

function makeCaravan(state, x, y, wagons, origin) {
  const rng = state.rng;
  const c = {
    id: state.nextId++,
    seed: rng.int(100000),
    x,
    y,
    vx: 0,
    vy: 1,
    walked: 0,
    // Wagons are slower than the people who used to walk this map alone. Roads
    // matter more to something on wheels, which is the point.
    speed: rng.range(12, 16),
    wagons,
    souls: wagons * SOULS_PER_WAGON,
    carry: rng.pick(GOODS),
    goal: null,
    legs: null,
    leg: 0,
    path: null,
    pi: 0,
    rest: 0,
    origin,
    /** Town to return to. Set only on trade circuits; settlers have no home. */
    home: null,
    done: false,
  };
  state.caravans.push(c);
  state.stats.caravans++;
  state.stats.souls += c.souls;
  return c;
}

/**
 * Border immigration.
 *
 * Loud at the start and quiet later — see `borderInterval`. These are the
 * caravans that have never seen the map before, so they are the ones that carve
 * the first routes across virgin terrain.
 */
export function spawnBorderCaravan(state) {
  if (state.caravans.length >= MAX_CARAVANS) return null;
  const rng = state.rng;
  const gate = rng.pick(state.gates);
  if (!gate) return null;
  // Early arrivals travel in bigger trains: they are the ones expected to found
  // something, and `FOUND_SOULS` is two wagons' worth.
  const bias = frontierPressure(state);
  const wagons = 1 + (rng.chance(0.45 + 0.4 * bias) ? 1 : 0) + (rng.chance(0.18 + 0.3 * bias) ? 1 : 0);
  const c = makeCaravan(state, gate.x, gate.y, Math.min(MAX_WAGONS, wagons), 'border');
  retarget(state, c);
  return c;
}

/** Seconds between border arrivals, growing as the world fills up. */
const BORDER_BASE = [9, 19];
export function borderInterval(state, rng) {
  const slack = 1 + Math.pow(state.time / 900, 1.35);
  return rng.range(BORDER_BASE[0], BORDER_BASE[1]) * slack;
}

/**
 * A town sending its surplus away for good.
 *
 * This is the demographic pressure valve: a full town pushes people out, and
 * they go and fill or found somewhere else. It is capped by how fast a town can
 * actually grow, which is why it alone cannot keep the roads busy — that is
 * what trade circuits are for.
 */
export function spawnTownCaravan(state, town) {
  if (state.caravans.length >= MAX_CARAVANS) return null;
  const rng = state.rng;
  const wagons = Math.min(MAX_WAGONS, 1 + (rng.chance(0.4) ? 1 : 0) + (rng.chance(0.12) ? 1 : 0));
  const take = wagons * SOULS_PER_WAGON;
  if (town.pop - take < 6) return null;
  town.pop -= take;
  const c = makeCaravan(state, town.x, town.y, wagons, town.id);
  town.traffic += 1;
  retarget(state, c);
  return c;
}

/**
 * A town sending a trade run out and expecting it back.
 *
 * The difference from emigration is the whole point: these people return, so
 * the run costs the town nothing permanent and can therefore happen far more
 * often. Emigration is limited by how fast a town grows; trade is limited only
 * by how much there is to trade with. Once two towns exist this becomes the
 * bulk of the traffic on the map, and it is what wears in — and then keeps
 * alive — the roads *between* settlements, which no border-to-border journey
 * would ever have carved.
 */
export function spawnTradeCaravan(state, town) {
  if (state.caravans.length >= MAX_CARAVANS) return null;
  const rng = state.rng;
  const partners = state.towns.filter((t) => t.id !== town.id);
  if (!partners.length) return null;

  const wagons = Math.min(MAX_WAGONS, 1 + (rng.chance(0.35) ? 1 : 0));
  const take = wagons * SOULS_PER_WAGON;
  if (town.pop - take < 8) return null;
  town.pop -= take;

  const c = makeCaravan(state, town.x, town.y, wagons, town.id);
  c.home = town.id;
  c.goal = 'trade';
  // One or two stops, nearest-first, then home again.
  const stops = partners
    .map((t) => ({ t, d: Math.hypot(t.x - town.x, t.y - town.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, rng.chance(0.35) ? 2 : 1);
  c.legs = stops.map(({ t }) => ({ x: t.x, y: t.y, kind: 'market', townId: t.id }));
  c.legs.push({ x: town.x, y: town.y, kind: 'home', townId: town.id });
  town.traffic += 1;
  return c;
}

// ----------------------------------------------------------------- movement

/** Commit to whatever `chooseGoal` picked, and lay out the walk to get there. */
function retarget(state, c) {
  const goal = chooseGoal(state, c);
  c.goal = goal ? goal.kind : null;
  c.path = null;
  c.pi = 0;
  c.leg = 0;
  if (!goal) { c.legs = []; c.done = true; return; }

  if (goal.kind === 'join') {
    c.legs = [{ x: goal.town.x, y: goal.town.y, kind: 'join', townId: goal.town.id }];
  } else if (goal.kind === 'found') {
    c.legs = [{ x: goal.spot.x, y: goal.spot.y, kind: 'found' }];
  } else {
    // Crossing caravans call in at the towns roughly on their route. Those
    // calls are what pay for the next building, and — more importantly — they
    // are what puts traffic on the roads *between* settlements. A caravan that
    // beelines from one border to the opposite one only ever reinforces the
    // corridors that already exist.
    const legs = [];
    for (const via of waysides(state, c, goal.exit, 2)) {
      legs.push({ x: via.x, y: via.y, kind: 'market', townId: via.id });
    }
    legs.push({ x: goal.exit.x, y: goal.exit.y, kind: 'gate' });
    c.legs = legs;
  }
}

/**
 * Up to `limit` towns worth stopping at between here and the exit, in the order
 * they should be visited. "Worth" means the detour is small next to the trip.
 */
function waysides(state, c, exit, limit) {
  const at = { x: c.x, y: c.y };
  const picked = [];
  const seen = new Set();
  for (let n = 0; n < limit; n++) {
    const direct = Math.hypot(exit.x - at.x, exit.y - at.y);
    let best = null, bestDetour = Infinity;
    for (const t of state.towns) {
      if (seen.has(t.id)) continue;
      const out = Math.hypot(t.x - at.x, t.y - at.y);
      if (out < 150) continue;               // we are already standing in it
      const detour = out + Math.hypot(exit.x - t.x, exit.y - t.y) - direct;
      if (detour < bestDetour) { bestDetour = detour; best = t; }
    }
    if (!best || bestDetour > 520) break;
    picked.push(best);
    seen.add(best.id);
    at.x = best.x;
    at.y = best.y;
  }
  return picked;
}

function repath(state, c) {
  const leg = c.legs[c.leg];
  if (!leg) { c.done = true; return; }
  const sx = Math.max(0, Math.min(MAP.w - 1, Math.floor(c.x / TILE)));
  const sy = Math.max(0, Math.min(MAP.h - 1, Math.floor(c.y / TILE)));
  const gx = Math.max(0, Math.min(MAP.w - 1, Math.floor(leg.x / TILE)));
  const gy = Math.max(0, Math.min(MAP.h - 1, Math.floor(leg.y / TILE)));
  c.path = findPath(state, tileIndex(sx, sy), tileIndex(gx, gy), c.seed);
  c.pi = 0;
  state.stats.paths++;
}

/** Everyone aboard gets out and stays. The caravan itself is gone. */
function settle(state, c, town) {
  town.pop += c.souls;
  town.traffic += 2 + c.wagons;
  state.stats.settled += c.souls;
  state.events.push({
    type: 'settled', x: town.x, y: town.y, souls: c.souls, name: town.name,
  });
  c.done = true;
}

/**
 * Turned away, for whatever reason. Rest a while and pick again.
 *
 * The rest is not cosmetic — it is the thing that guarantees a caravan cannot
 * decide, arrive and be refused all within one tick, over and over. The walked
 * penalty is: a wasted journey makes a caravan measurably keener to settle for
 * whatever it can get next time.
 */
function turnedAway(state, c) {
  c.walked += 500;
  c.rest = state.rng.range(4, 10);
  retarget(state, c);
}

function arriveLeg(state, c) {
  const leg = c.legs[c.leg];

  if (leg && leg.kind === 'join') {
    const town = state.towns.find((t) => t.id === leg.townId);
    // The town may have filled up while this caravan was walking to it. Rather
    // than force the settlement, re-decide from where we now stand — which is
    // usually "carry on to the next town", and is why late-game roads get long.
    if (town && housing(town) - population(town) > 0) { settle(state, c, town); return; }
    if (town) town.traffic += 1;
    turnedAway(state, c);
    return;
  }

  if (leg && leg.kind === 'found') {
    // Somebody else may have taken the spot, or the junction may have faded.
    const clash = state.towns.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < TOWN_SPACING);
    if (!clash && state.towns.length < MAX_TOWNS) {
      const town = foundTown(state, c.x, c.y, c.souls);
      if (town) { settle(state, c, town); return; }
    }
    // The frontier is stale or taken. Stand down from founding for a while, or
    // this caravan re-picks the same doomed junction from where it stands and
    // never gets anywhere else.
    c.noFoundUntil = state.time + 240;
    turnedAway(state, c);
    return;
  }

  if (leg && leg.kind === 'home') {
    // A trade run coming back. Its people rejoin the town they left, so the
    // circuit costs the map nothing — unlike emigration, which is one-way.
    const town = state.towns.find((t) => t.id === leg.townId);
    if (town) {
      town.pop += c.souls;
      town.traffic += 2;
      state.stats.trades++;
    }
    c.done = true;
    return;
  }

  if (leg && leg.kind === 'market') {
    const town = state.towns.find((t) => t.id === leg.townId);
    if (town) {
      town.traffic += 2;
      state.stats.trades++;
      const give = c.carry;
      c.carry = state.rng.pick(GOODS);
      state.events.push({ type: 'trade', x: c.x, y: c.y, give: give || 'coin', get: c.carry });
    }
    c.rest = state.rng.range(2.5, 6);
  }

  c.leg++;
  c.path = null;
  if (c.leg >= c.legs.length) {
    // Reached the far border. A caravan that has crossed the whole map without
    // stopping leaves the world; its people are somebody else's problem now.
    c.done = true;
  }
}

export function updateCaravan(state, c, dt) {
  if (c.rest > 0) {
    c.rest -= dt;
    return;
  }
  const leg = c.legs && c.legs[c.leg];
  if (!leg) { c.done = true; return; }

  if (!c.path) {
    repath(state, c);
    if (!c.path) {
      // A* gave up — almost always a caravan hemmed in by water. Beeline it and
      // let the next repath sort things out.
      const dx = leg.x - c.x, dy = leg.y - c.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < 8) { arriveLeg(state, c); return; }
      advance(state, c, dx / d, dy / d, dt, 0.6);
      return;
    }
  }

  let target = null;
  while (c.pi < c.path.length) {
    const idx = c.path[c.pi];
    const p = tileCentre(idx % MAP.w, (idx / MAP.w) | 0);
    if (Math.hypot(p.x - c.x, p.y - c.y) < TILE * 0.9) { c.pi++; continue; }
    target = p;
    break;
  }
  if (!target) {
    const d = Math.hypot(leg.x - c.x, leg.y - c.y);
    if (d < TILE * 2) { arriveLeg(state, c); return; }
    target = leg;
  }

  const dx = target.x - c.x, dy = target.y - c.y;
  const d = Math.hypot(dx, dy) || 1;
  advance(state, c, dx / d, dy / d, dt, 1);
}

function advance(state, c, nx, ny, dt, scale) {
  const i = tileIndex(
    Math.max(0, Math.min(MAP.w - 1, Math.floor(c.x / TILE))),
    Math.max(0, Math.min(MAP.h - 1, Math.floor(c.y / TILE))),
  );
  // Rough ground is slow to cross as well as expensive to choose, and a wagon
  // suffers for it more than a walker did: the pace penalty is steeper.
  const cost = moveCost(state.terrain, state.wear, i);
  const pace = Math.max(0.28, Math.min(1.1, 1.5 / Math.pow(cost, 0.68)));
  const dist = c.speed * pace * scale * dt;

  c.x += nx * dist;
  c.y += ny * dist;
  c.vx = nx;
  c.vy = ny;
  c.walked += dist;
  depositTrail(state, c.x, c.y, dist * wearRate(c));
  state.stats.distance += dist;
}

/** Everyone, one tick. */
export function updateCaravans(state, dt) {
  for (const c of state.caravans) updateCaravan(state, c, dt);
  for (let i = state.caravans.length - 1; i >= 0; i--) {
    if (state.caravans[i].done) state.caravans.splice(i, 1);
  }
}

/** Credit towns for traffic simply passing through, not just stopping. */
export function creditPassers(state) {
  for (const c of state.caravans) {
    const town = townAt(state, c.x, c.y, 90);
    if (town) town.traffic += 0.2 * c.wagons;
  }
}
