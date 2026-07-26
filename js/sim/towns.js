// towns.js — settlements, and where they are allowed to appear.
//
// A town is never placed. It is *found*: once the wear field grows a junction
// with three or more arms and enough traffic through it, somebody builds a well
// there, and the buildings accumulate from the traffic that keeps arriving.
// Everything about a town is therefore downstream of the road network, which is
// downstream of the terrain — which is the whole thesis of the game.
//
// A town is plain data. It holds no sprites, no canvases and no colours; the
// renderer turns `kind` into a prop and that is the only place art enters.

import { MAP, TILE, buildable, tileIndex } from './terrain.js';
import { ROAD_MIN, bestJunction } from './roads.js';

/** Minimum gap between town centres, in world units. Four towns need room. */
export const TOWN_SPACING = 320;
export const MAX_TOWNS = 5;

/** Traffic a junction must have seen before anybody settles it. */
const FOUND_WEAR = 1.05;
const FOUND_ARMS = 3;

/**
 * What gets built, in order. The sequence is the story of a settlement: a well
 * and a stall for the traffic that's already passing, an inn once people stay
 * the night, then homes, then the trades that only make sense with a market to
 * sell into.
 */
export const TOWN_PLAN = [
  'well', 'stall', 'signpost', 'house', 'inn', 'lamp',
  'stall', 'house', 'bakery', 'cart', 'house', 'market',
  'lamp', 'warehouse', 'house', 'smithy', 'house', 'lumberyard',
  'house', 'stall', 'house', 'lamp', 'house', 'haystack', 'house',
];

/** How much room each kind needs to itself, in world units. */
const FOOTPRINT = {
  well: 16, stall: 20, inn: 34, house: 26, bakery: 30, market: 36,
  warehouse: 36, smithy: 30, lumberyard: 34, lamp: 12, cart: 14,
  signpost: 10, haystack: 16,
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

/** Find somewhere in town for one more building, or null if it's hemmed in. */
function findPlot(state, town, kind, rng) {
  const need = FOOTPRINT[kind] || 24;
  for (let attempt = 0; attempt < 90; attempt++) {
    // Spiral outward: early buildings hug the crossroads, later ones sprawl.
    const t = attempt / 90;
    const radius = 14 + t * (34 + town.buildings.length * 3.2);
    const angle = rng.next() * Math.PI * 2;
    const x = town.x + Math.cos(angle) * radius;
    const y = town.y + Math.sin(angle) * radius * 0.78;   // squashed: reads better top-down
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (!siteOk(state, tx, ty)) continue;
    let clear = true;
    for (const b of town.buildings) {
      const gap = (need + (FOOTPRINT[b.kind] || 24)) * 0.42;
      if (Math.hypot(b.x - x, (b.y - y) * 1.25) < gap) { clear = false; break; }
    }
    if (!clear) continue;
    return { x: Math.round(x), y: Math.round(y) };
  }
  return null;
}

/** Add the next building in the plan, if there's room and traffic to pay for it. */
export function growTown(state, town) {
  const n = town.buildings.length;
  if (n >= TOWN_PLAN.length) return false;
  // Each building is dearer than the last, so towns slow down rather than
  // exploding once a trunk road runs through them.
  const cost = 8 + n * 5;
  if (town.traffic < cost) return false;
  const kind = TOWN_PLAN[n];
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
  town.radius = Math.max(town.radius, Math.hypot(plot.x - town.x, plot.y - town.y) + 14);
  state.events.push({ type: 'built', x: plot.x, y: plot.y, kind, town: town.id });
  return true;
}

/** Look for a junction worth settling. Called occasionally, not every frame. */
export function considerFounding(state) {
  if (state.towns.length >= MAX_TOWNS) return null;
  const spot = bestJunction(state, FOUND_ARMS, FOUND_WEAR, TOWN_SPACING);
  if (!spot) return null;
  // The junction itself is road; the town centre is the junction, but the first
  // building will land beside it.
  const town = {
    id: state.nextId++,
    name: townName(state.rng, state.towns.map((t) => t.name)),
    x: spot.x,
    y: spot.y,
    founded: state.time,
    traffic: 0,
    radius: 30,
    arms: spot.arms,
    buildings: [],
  };
  state.towns.push(town);
  state.events.push({ type: 'founded', x: town.x, y: town.y, name: town.name });
  return town;
}

/** Nearest town to a world point, within `within` units. */
export function townAt(state, x, y, within = 90) {
  let best = null, bestD = within;
  for (const t of state.towns) {
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}
