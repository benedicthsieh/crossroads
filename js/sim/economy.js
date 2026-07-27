// economy.js — what a town is made of, and what it has to go and get.
//
// Before this file a town paid for everything with `traffic`: one abstract
// number that stood for "trade has been good lately". That is still here and
// still does its job — it is the *labour and coin* half of a building — but it
// used to be the whole story, which meant a settlement on bare grassland grew
// exactly like one in a river valley under a forest. The map had terrain and the
// economy did not.
//
// So buildings now also cost materials, and materials come off the ground the
// town happens to be standing on:
//
//   wood    cut from forest (and, slowly, from scrub on open ground)
//   stone   quarried from mountain and hill — but only once a quarry exists
//   food    hunted in the forest, fished from the rivers, or farmed from fields
//
// The three are deliberately not symmetrical. Wood is always available somewhere
// so nothing hard-stalls; stone takes a deliberate investment before the first
// block appears, which is what makes tier-two buildings feel earned; and food is
// consumed every second by everybody, so it is the one a town can *lose* at.
//
// Wild food is capped by terrain and is poor per pair of hands. Farmed food is
// three times the yield per worker and scales with how many fields you have —
// but a field has to be cleared first, and clearing takes the same hands that
// would otherwise be feeding people. That trade is the whole point of farms: a
// town gets hungrier before it gets fed.
//
// Everything here is plain arithmetic on plain numbers. No randomness, so two
// clients stepping the same state produce byte-identical stock levels.

import { MAP, TILE, T, tileIndex } from './terrain.js';

// ------------------------------------------------------------------ the land

/**
 * How far out a town works its surroundings, in tiles. Generous — 30 tiles is
 * 180 world units, a good walk past the edge of even a sprawling settlement —
 * because the alternative is that a town two tiles from a forest counts as
 * having no forest at all.
 */
const WORK_RADIUS = 30;

/**
 * Count what is within reach of a town.
 *
 * Pure function of the seed and the town's position, so it is *derived* rather
 * than stored — same rule as terrain and gates. `landOf` caches it on the town
 * for the rest of the session; a restore simply surveys again.
 */
export function surveyLand(state, town) {
  const cx = Math.floor(town.x / TILE), cy = Math.floor(town.y / TILE);
  const r = WORK_RADIUS;
  const land = { forest: 0, water: 0, mountain: 0, hill: 0, open: 0 };
  for (let ty = cy - r; ty <= cy + r; ty++) {
    if (ty < 0 || ty >= MAP.h) continue;
    for (let tx = cx - r; tx <= cx + r; tx++) {
      if (tx < 0 || tx >= MAP.w) continue;
      const dx = tx - cx, dy = ty - cy;
      if (dx * dx + dy * dy > r * r) continue;
      switch (state.terrain.kind[tileIndex(tx, ty)]) {
        case T.FOREST: land.forest++; break;
        case T.WATER: land.water++; break;
        case T.MOUNTAIN: land.mountain++; break;
        case T.HILL: land.hill++; break;
        default: land.open++;
      }
    }
  }
  return land;
}

export function landOf(state, town) {
  if (!town.land) town.land = surveyLand(state, town);
  return town.land;
}

// ------------------------------------------------------------------- stores

export function emptyStock() {
  return { food: 0, wood: 0, stone: 0 };
}

/** A town's stores, created on demand so a restored save can't be caught out. */
export function stockOf(town) {
  if (!town.stock) town.stock = emptyStock();
  return town.stock;
}

/**
 * How much of anything a town can keep. Small to start with — a camp has a few
 * sacks and a woodpile — and this is what the warehouse is *for*: without one, a
 * prosperous town simply stops accumulating and its surplus goes to waste.
 */
const STORE_BASE = 70;
const STORE_PER_WAREHOUSE = 110;
export function storeCapacity(town) {
  return STORE_BASE + countKind(town, 'warehouse') * STORE_PER_WAREHOUSE;
}

// ---------------------------------------------------------------- what things cost
//
// Two tiers, and the tier is legible straight off the table: anything with no
// stone in it can be put up by people with axes, and anything with stone in it
// needs a quarry running first. Traffic is charged separately (and escalates
// with the size of the town) in `growTown` — these are materials only.

export const MATERIALS = {
  // tier 0 — a wagon, unhitched and pitched. The founding party's own shelter.
  tent: { wood: 0, stone: 0 },

  // tier 1 — timber. What a town can build the week it arrives.
  house: { wood: 16, stone: 0 },
  farm: { wood: 12, stone: 0 },
  quarry: { wood: 22, stone: 0 },
  lumberyard: { wood: 20, stone: 0 },
  stall: { wood: 9, stone: 0 },
  signpost: { wood: 4, stone: 0 },
  cart: { wood: 8, stone: 0 },
  haystack: { wood: 4, stone: 0 },
  inn: { wood: 34, stone: 8 },

  // tier 2 — masonry. Nothing here is possible until stone is coming in, and
  // the amounts are deliberately large next to a town's shelf space: a big
  // building is a season of hauling, not an afternoon's shopping, and it is
  // what makes the warehouse (which is itself one of these) worth having.
  well: { wood: 6, stone: 24 },
  lamp: { wood: 3, stone: 8 },
  bakery: { wood: 20, stone: 22 },
  market: { wood: 38, stone: 32 },
  warehouse: { wood: 42, stone: 24 },
  smithy: { wood: 22, stone: 44 },
};

const NOTHING = { wood: 0, stone: 0 };
export function materialsFor(kind) {
  return MATERIALS[kind] || NOTHING;
}

/** Does this building need masonry? Used to decide when a quarry is overdue. */
export function needsStone(kind) {
  return materialsFor(kind).stone > 0;
}

export function hasMaterials(town, kind) {
  const cost = materialsFor(kind);
  const stock = stockOf(town);
  return stock.wood >= cost.wood && stock.stone >= cost.stone;
}

export function payMaterials(town, kind) {
  const cost = materialsFor(kind);
  const stock = stockOf(town);
  stock.wood -= cost.wood;
  stock.stone -= cost.stone;
}

// ------------------------------------------------------------------- yields
//
// Everything below is per simulated second. The upkeep pass runs at 1 Hz of sim
// time, so these are also "per upkeep tick" at normal speed.

/** What one person eats. The only outgoing every town has. */
export const FOOD_PER_PERSON = 0.018;

/** Fraction of a town's people who are out working rather than being fed. */
const WORKING_SHARE = 0.55;

/** Wild food. Capped hard: a forest feeds a hamlet, never a city. */
const HUNT_PER_TILE = 0.00055, HUNT_CEILING = 0.34;
const FISH_PER_TILE = 0.0045, FISH_CEILING = 0.30;

/** A field in full production. Worth roughly a whole forest's worth of hunting. */
const FIELD_YIELD = 0.30;

/** Timber. The scrub share is why a town on bare grass is slow, not stuck. */
const WOOD_PER_TILE = 0.0022, SCRUB_SHARE = 0.05, WOOD_CEILING = 0.9;
const LUMBERYARD_BONUS = 0.5;

/** Stone comes out of a quarry or it does not come out at all. */
const QUARRY_YIELD = 0.22;
const STONE_TILES_FULL = 90;

/**
 * Food per worker per second, by source.
 *
 * This table is the answer to "why bother farming". A farmer feeds three times
 * as many people as a hunter does, which is what makes clearing a field worth
 * the season it costs — and what lets a town outgrow the game its woods can
 * support.
 */
const PER_WORKER = { farm: 0.15, fish: 0.05, hunt: 0.045, wood: 0.05, stone: 0.06 };

/** Below this many seconds of food in hand, a town works flat out to eat. */
const LEAN_SECONDS = 40;

/** How much of each material a town tries to keep on the shelf. */
const WANT_WOOD = 45, WANT_STONE = 35;

// --------------------------------------------------------------- clearing
//
// A field is not built, it is *broken in*. The hands doing it are hands that are
// not hunting, so a town that decides to farm goes hungry for a while first.
// That is the investment the whole mechanic hangs on: farms are strictly better
// once they run, and strictly worse while they don't.

const CLEAR_HANDS = 3;
const CLEAR_RATE = 0.006;          // growth per worker per second, on open ground
const STUMP_PENALTY = 0.55;        // clearing woodland is slower...
const CLEARED_TIMBER = 20;         // ...and pays for itself in felled trees

/** Where a plot is in its life, as far as the renderer is concerned: 0, 1 or 2. */
function clearStage(growth) {
  if (growth >= 1) return 2;
  return growth < 0.55 ? 0 : 1;
}

function advanceClearing(state, town, dt, hands) {
  const plot = town.buildings.find((b) => b.kind === 'farm' && (b.growth || 0) < 1);
  if (!plot || hands <= 0) return 0;
  const before = clearStage(plot.growth || 0);
  const rate = CLEAR_RATE * hands * (plot.stumps ? STUMP_PENALTY : 1);
  plot.growth = Math.min(1, (plot.growth || 0) + rate * dt);
  if (plot.growth >= 1 && plot.stumps) {
    stockOf(town).wood += CLEARED_TIMBER;
    plot.stumps = 0;
  }
  // The renderer draws a different sprite per stage and only rebuilds its
  // static list when the sim says something changed, so the crossing has to be
  // announced or a field stays scrub until the next building goes up.
  if (clearStage(plot.growth) !== before) {
    state.events.push({ type: 'field', x: plot.x, y: plot.y, town: town.id });
  }
  return hands;
}

// ------------------------------------------------------------------ queries

export function countKind(town, kind) {
  let n = 0;
  for (const b of town.buildings) if (b.kind === kind) n++;
  return n;
}

/** Fields that are actually producing. A half-cleared plot feeds nobody. */
export function workingFields(town) {
  let n = 0;
  for (const b of town.buildings) if (b.kind === 'farm' && (b.growth || 0) >= 1) n++;
  return n;
}

const people = (town) => Math.round(town.pop);

/** What this town eats per second. */
export function consumption(town) {
  return people(town) * FOOD_PER_PERSON;
}

/**
 * The most food this town could produce if it put everyone on it — the number
 * that decides whether it needs another field. Deliberately ignores labour: it
 * is a question about the *land*, not about today.
 */
export function foodCeiling(state, town) {
  const land = landOf(state, town);
  return workingFields(town) * FIELD_YIELD
    + Math.min(FISH_CEILING, FISH_PER_TILE * land.water)
    + Math.min(HUNT_CEILING, HUNT_PER_TILE * land.forest);
}

/** Can this town ever quarry, or is it stuck trading for its stone? */
export function hasStoneNearby(state, town) {
  const land = landOf(state, town);
  return land.mountain + land.hill * 0.35 >= 12;
}

export function woodCeiling(state, town) {
  const land = landOf(state, town);
  return Math.min(WOOD_CEILING, WOOD_PER_TILE * (land.forest + land.open * SCRUB_SHARE))
    * (1 + LUMBERYARD_BONUS * countKind(town, 'lumberyard'));
}

export function stoneCeiling(state, town) {
  const quarries = countKind(town, 'quarry');
  if (!quarries) return 0;
  const land = landOf(state, town);
  const rock = land.mountain + land.hill * 0.35;
  return QUARRY_YIELD * quarries * Math.min(1, rock / STONE_TILES_FULL);
}

// ------------------------------------------------------------------ the tick

/**
 * One town, one upkeep second: feed everyone, then get on with the work.
 *
 * Labour is allocated in a fixed order of priority — clearing, then eating, then
 * materials — and each stage takes only as many hands as it can use. That
 * ordering is the entire "AI" of a town's economy, and it produces the
 * behaviour you want without anything resembling a planner: a hungry town
 * abandons the woodpile, a fed one goes back to it, and a town with a field
 * being cleared does both a little worse until the field comes in.
 */
export function produce(state, town, dt) {
  const stock = stockOf(town);
  const pop = people(town);
  const hands = Math.max(1, pop * WORKING_SHARE);
  let free = hands;

  const clearing = advanceClearing(state, town, dt, Math.min(free, CLEAR_HANDS));
  free -= clearing;
  const afterClearing = free;

  // ---- eat ----------------------------------------------------------------
  const need = consumption(town);
  const lean = stock.food < need * LEAN_SECONDS;
  // A town with full stores works to replace what it eats. A town running low
  // throws everyone it can spare at food until the stores recover.
  let target = need * (lean ? 1.8 : 1.1);
  const sources = [
    { cap: workingFields(town) * FIELD_YIELD, per: PER_WORKER.farm },
    { cap: Math.min(FISH_CEILING, FISH_PER_TILE * landOf(state, town).water), per: PER_WORKER.fish },
    { cap: Math.min(HUNT_CEILING, HUNT_PER_TILE * landOf(state, town).forest), per: PER_WORKER.hunt },
  ];
  let food = 0;
  for (const src of sources) {
    if (free <= 0 || target <= 0) break;
    // Best source first, and never more hands than it can absorb.
    const use = Math.min(free, src.cap / src.per, target / src.per);
    if (!(use > 0)) continue;
    const got = use * src.per;
    food += got;
    target -= got;
    free -= use;
  }

  // ---- materials ----------------------------------------------------------
  // Split what's left between the woodpile and the quarry by which store is
  // furthest from where the town would like it. Hands a source can't use go to
  // the other one rather than idling.
  const store = storeCapacity(town);
  const woodCap = woodCeiling(state, town);
  const stoneCap = stoneCeiling(state, town);
  const woodShort = Math.max(0, WANT_WOOD - stock.wood);
  const stoneShort = stoneCap > 0 ? Math.max(0, WANT_STONE - stock.stone) : 0;
  // While either store is below where the town would like it, hands go to
  // whichever is further behind. Once both are comfortable they go on filling
  // whatever there is still shelf room for — and when the stores are full, they
  // stop, because a woodpile nobody can put anywhere is not work.
  const short = woodShort + stoneShort;
  const woodPull = short > 0 ? woodShort : Math.max(0, store - stock.wood);
  const stonePull = short > 0 ? stoneShort
    : (stoneCap > 0 ? Math.max(0, store - stock.stone) : 0);
  const pull = woodPull + stonePull;
  let onWood = pull > 0 ? free * (woodPull / pull) : 0;
  let onStone = pull > 0 ? free - onWood : 0;
  const woodHandsMax = woodCap / PER_WORKER.wood;
  const stoneHandsMax = stoneCap > 0 ? stoneCap / PER_WORKER.stone : 0;
  if (onWood > woodHandsMax) { onStone += onWood - woodHandsMax; onWood = woodHandsMax; }
  if (onStone > stoneHandsMax) { onWood = Math.min(woodHandsMax, onWood + onStone - stoneHandsMax); onStone = stoneHandsMax; }
  const wood = Math.min(woodCap, onWood * PER_WORKER.wood);
  const stone = Math.min(stoneCap, onStone * PER_WORKER.stone);

  // ---- settle up ----------------------------------------------------------
  stock.food = Math.max(0, Math.min(store, stock.food + (food - need) * dt));
  stock.wood = Math.min(store, stock.wood + wood * dt);
  stock.stone = Math.min(store, stock.stone + stone * dt);

  // Derived, for the HUD and for the decisions in towns.js and state.js. Never
  // serialised — it is rebuilt within one upkeep tick of any restore.
  town.starving = stock.food <= 0 && food < need;
  town.rates = {
    food: food - need, wood, stone,
    hands, clearing, onFood: afterClearing - free,
  };
  return town.rates;
}

// --------------------------------------------------------------- caravan loads
//
// What a caravan does with what it is carrying. Trade runs move real material
// between towns, which is the only reason a settlement with no rock in reach can
// ever put up a market — and it is what makes the trade roads worth more than
// the animation of traffic on them.

/** What one wagon can carry. */
export const WAGON_LOAD = 14;

/** What a wagon is worth once it stops for good and gets broken up. */
export const WAGON_TIMBER = 10;

/** What each soul brings with them when they settle: a few days of food. */
export const PROVISIONS = 2.2;

/** Keep this much of everything at home; only the surplus goes on the road. */
const TRADE_RESERVE = 25;

/**
 * Load a departing trade run with whatever the home town has most to spare.
 * Returns the cargo, which is plain `{wood, stone, food}` and serialisable.
 */
export function loadCargo(town, wagons) {
  const stock = stockOf(town);
  const cargo = { food: 0, wood: 0, stone: 0 };
  let room = WAGON_LOAD * wagons;
  // Richest store first, so a lumber town exports timber and a quarry town rock.
  const order = ['wood', 'stone', 'food'].sort((a, b) => stock[b] - stock[a]);
  for (const res of order) {
    if (room <= 0) break;
    const spare = Math.max(0, stock[res] - TRADE_RESERVE);
    const take = Math.min(room, spare);
    if (take <= 0) continue;
    stock[res] -= take;
    cargo[res] += take;
    room -= take;
  }
  return cargo;
}

/** Hand over part of a load, and pick up whatever this town can spare in return. */
export function tradeAt(town, cargo, share = 0.6) {
  const stock = stockOf(town);
  const cap = storeCapacity(town);
  let given = 0, gained = 0;
  for (const res of ['food', 'wood', 'stone']) {
    const drop = cargo[res] * share;
    if (drop > 0) {
      stock[res] = Math.min(cap, stock[res] + drop);
      cargo[res] -= drop;
      given += drop;
    }
  }
  // Take on this town's surplus for the next leg — that is what makes a circuit
  // worth running rather than a one-way delivery.
  let room = Math.max(0, WAGON_LOAD - (cargo.food + cargo.wood + cargo.stone));
  for (const res of ['wood', 'stone', 'food']) {
    if (room <= 0) break;
    const spare = Math.max(0, stock[res] - TRADE_RESERVE);
    const take = Math.min(room, spare);
    if (take <= 0) continue;
    stock[res] -= take;
    cargo[res] += take;
    room -= take;
    gained += take;
  }
  return { given, gained };
}

/** Unload everything, at the end of a circuit. */
export function unloadCargo(town, cargo) {
  const stock = stockOf(town);
  const cap = storeCapacity(town);
  let total = 0;
  for (const res of ['food', 'wood', 'stone']) {
    if (!cargo[res]) continue;
    stock[res] = Math.min(cap, stock[res] + cargo[res]);
    total += cargo[res];
    cargo[res] = 0;
  }
  return total;
}

/** The icon a load should show as it changes hands. */
export function cargoIcon(cargo) {
  if (!cargo) return null;
  const { food = 0, wood = 0, stone = 0 } = cargo;
  if (food + wood + stone <= 0.01) return null;
  if (wood >= food && wood >= stone) return 'log';
  if (stone >= food) return 'stone';
  return 'wheat';
}
