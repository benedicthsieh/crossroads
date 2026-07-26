// towns.js — settlements, and where they are allowed to appear.
//
// A town is never placed by the game. It is *chosen*: a caravan carrying enough
// people arrives at an unclaimed crossroads, decides that this is better than
// anywhere else it could be, and stops for good. Everything after that is
// downstream of two numbers the town keeps — `traffic`, which pays for
// buildings, and `pop`, which is who lives there and wants somewhere to sleep.
//
// A town is plain data. It holds no sprites, no canvases and no colours; the
// renderer turns `kind` into a prop and that is the only place art enters.

import { MAP, TILE, buildable, tileIndex } from './terrain.js';
import { ROAD_MIN, armCount } from './roads.js';

/**
 * Minimum gap between town centres, in world units. Sized against the map
 * rather than against the buildings: five towns on a 2520x1680 world want to be
 * a real journey apart, or the road between two of them never gets long enough
 * to grow a junction of its own.
 */
export const TOWN_SPACING = 470;
export const MAX_TOWNS = 5;

/** How many people one house sleeps, and how many the founding camp holds. */
const HOUSE_BEDS = 9;
const CAMP_BEDS = 12;

/**
 * What gets built, in order.
 *
 * The sequence is the story of a settlement: a well and a stall for the traffic
 * that's already passing, an inn once people stay the night, then the trades
 * that only make sense with a market to sell into. Houses are *not* in this
 * list — housing is demand-driven, and `nextBuild` splices a house in whenever
 * the town is running out of beds. That is what makes a busy town sprawl into
 * a ring of homes around a working centre instead of following a script.
 */
export const TOWN_PLAN = [
  'well', 'stall', 'signpost', 'inn', 'lamp', 'stall',
  'bakery', 'cart', 'market', 'lamp', 'warehouse', 'smithy',
  'lumberyard', 'stall', 'haystack', 'lamp', 'cart', 'stall',
];

/**
 * How much room each kind needs to itself, in world units.
 *
 * Generous relative to the sprites on purpose. A town that packs its buildings
 * shoulder to shoulder reads as one big blob at any zoom; leaving gaps lets the
 * roads run *between* the buildings, which is what makes it look like a place
 * that grew around a crossroads.
 */
const FOOTPRINT = {
  well: 22, stall: 26, inn: 42, house: 34, bakery: 38, market: 46,
  warehouse: 44, smithy: 38, lumberyard: 42, lamp: 18, cart: 20,
  signpost: 14, haystack: 22,
};

const SYL_A = ['Ash', 'Bram', 'Cold', 'Dun', 'Elm', 'Fen', 'Grey', 'Har', 'Ink', 'Kel', 'Mor', 'Oak', 'Pell', 'Raven', 'Stone', 'Thorn', 'Wold'];
const SYL_B = ['ford', 'bridge', 'cross', 'gate', 'market', 'reach', 'stead', 'wick', 'hollow', 'bury', 'mere', 'row'];

export function townName(rng, used) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const name = rng.pick(SYL_A) + rng.pick(SYL_B);
    if (!used.includes(name)) return name;
  }
  return `Crossing ${used.length + 1}`;
}

// ------------------------------------------------------------------ housing

/** Beds this town has built. The founding camp counts for a few. */
export function housing(town) {
  let houses = 0;
  for (const b of town.buildings) if (b.kind === 'house') houses++;
  return CAMP_BEDS + houses * HOUSE_BEDS;
}

/** Who lives here. Kept as a number; the renderer only ever draws a sample. */
export function population(town) {
  return Math.round(town.pop);
}

/** Total settled population across the map, for the HUD. */
export function totalPopulation(state) {
  let n = 0;
  for (const t of state.towns) n += Math.round(t.pop);
  return n;
}

// ----------------------------------------------------------------- building

/**
 * Can something be built on this tile? Buildings want firm, dry, off-road
 * ground — being *next* to the road is the point, being *on* it is not.
 */
function siteOk(state, tx, ty) {
  if (tx < 2 || ty < 2 || tx >= MAP.w - 2 || ty >= MAP.h - 2) return false;
  const i = tileIndex(tx, ty);
  if (!buildable(state.terrain.kind[i])) return false;
  if (state.wear[i] > ROAD_MIN * 0.9) return false;
  return true;
}

function nearestOtherTown(state, town, x, y) {
  let best = Infinity;
  for (const t of state.towns) {
    if (t.id === town.id) continue;
    best = Math.min(best, Math.hypot(t.x - x, t.y - y));
  }
  return best;
}

/**
 * Find somewhere in town for one more building, or null if it's hemmed in.
 *
 * The radius grows faster than the building count, so a town spreads out along
 * its roads rather than densifying. Houses are pushed further out than trades
 * are: the working buildings want the crossroads, the homes are happy on the
 * edge, and the result is a recognisable centre with outskirts.
 */
function findPlot(state, town, kind, rng) {
  const need = FOOTPRINT[kind] || 28;
  const outskirts = kind === 'house' || kind === 'haystack' ? 1.75 : 1;
  for (let attempt = 0; attempt < 110; attempt++) {
    const t = attempt / 110;
    const radius = (26 + t * (70 + town.buildings.length * 7)) * outskirts;
    const angle = rng.next() * Math.PI * 2;
    const x = town.x + Math.cos(angle) * radius;
    const y = town.y + Math.sin(angle) * radius * 0.74;   // squashed: reads better top-down
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (!siteOk(state, tx, ty)) continue;
    // Don't build into the neighbours. The spiral reaches a long way out for a
    // big town — further than `TOWN_SPACING` in the worst case — and nothing
    // else stops one settlement's outskirts landing in the middle of another's.
    if (nearestOtherTown(state, town, x, y) < Math.hypot(x - town.x, y - town.y)) continue;
    let clear = true;
    for (const b of town.buildings) {
      const gap = (need + (FOOTPRINT[b.kind] || 28)) * 0.5;
      if (Math.hypot(b.x - x, (b.y - y) * 1.3) < gap) { clear = false; break; }
    }
    if (!clear) continue;
    return { x: Math.round(x), y: Math.round(y) };
  }
  return null;
}

/**
 * What this town wants next.
 *
 * Housing pressure beats the plan. A town whose beds are nearly full builds a
 * house even if the plan says it is due a smithy, so the shape of a settlement
 * ends up reflecting how many people actually chose to stop there.
 */
function nextBuild(state, town) {
  // The well comes first, always. It is the thing that makes a patch of worn
  // ground read as a settlement rather than as a wide spot in the road.
  if (!town.buildings.length) return 'well';
  const free = housing(town) - population(town);
  const trades = town.buildings.filter((b) => b.kind !== 'house').length;
  const houses = town.buildings.length - trades;
  // Housing pressure wins, but only up to a point. Left uncapped a busy town
  // becomes a housing estate with a well in it: people keep arriving, beds keep
  // running short, and the plan never gets a look in. Capping houses against
  // trades means a town that wants to grow has to build something worth
  // visiting first — and a town that can't afford to stops growing instead.
  if (free < 4 && houses <= trades + 1) return 'house';
  if (trades >= TOWN_PLAN.length) return free < 10 ? 'house' : null;
  return TOWN_PLAN[trades];
}

/** Arms of road meeting at a town centre, for the HUD and for founding. */
function armsAt(state, x, y) {
  return armCount(state.wear, Math.floor(x / TILE), Math.floor(y / TILE));
}

/** Add the next building, if there's room and traffic to pay for it. */
export function growTown(state, town) {
  const kind = nextBuild(state, town);
  if (!kind) return false;
  const n = town.buildings.length;
  // Each building is dearer than the last, so towns slow down rather than
  // exploding once a trunk road runs through them. Houses are cheap: a town
  // should never be unable to shelter the people who already live in it.
  const cost = kind === 'house' ? 6 + n * 1.6 : 10 + n * 4.5;
  if (town.traffic < cost) return false;
  const plot = findPlot(state, town, kind, state.rng);
  if (!plot) { town.traffic = cost * 0.8; return false; }   // hemmed in; try later
  town.traffic -= cost;
  town.buildings.push({
    kind,
    x: plot.x,
    y: plot.y,
    variant: state.rng.int(3),
    born: state.time,
  });
  town.radius = Math.max(town.radius, Math.hypot(plot.x - town.x, plot.y - town.y) + 18);
  state.events.push({ type: 'built', x: plot.x, y: plot.y, kind, town: town.id });
  return true;
}

/**
 * Natural growth.
 *
 * People only arrive to fill beds that exist, so a town that stops building
 * houses stops growing — and a town that keeps building them keeps generating
 * the surplus that leaves again as caravans. This is the loop that turns one
 * lucky crossroads into the busiest node on the map.
 */
export function growPopulation(state, town, dt) {
  const free = housing(town) - population(town);
  if (free <= 0) return;
  const rate = 0.005 * Math.min(free, 12) * (0.4 + Math.min(1, town.buildings.length / 10));
  town.pop = Math.min(housing(town), town.pop + rate * dt);
}

// ----------------------------------------------------------------- founding

/** Start a settlement here. Called by a caravan that has decided to stop. */
export function foundTown(state, x, y, souls) {
  if (state.towns.length >= MAX_TOWNS) return null;
  const town = {
    id: state.nextId++,
    name: townName(state.rng, state.towns.map((t) => t.name)),
    x: Math.round(x),
    y: Math.round(y),
    founded: state.time,
    traffic: 6,
    pop: 0,          // the founding caravan's souls are added by `settle`
    radius: 38,
    arms: armsAt(state, x, y),
    buildings: [],
  };
  state.towns.push(town);
  state.events.push({ type: 'founded', x: town.x, y: town.y, name: town.name });
  return town;
}

/** Nearest town to a world point, within `within` units. */
export function townAt(state, x, y, within = 120) {
  let best = null, bestD = within;
  for (const t of state.towns) {
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}
