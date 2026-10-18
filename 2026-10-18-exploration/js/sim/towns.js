// towns.js — settlements, and where they are allowed to appear.
//
// A town is never placed by the game. It is *chosen*: a caravan carrying enough
// people arrives at an unclaimed crossroads, decides that this is better than
// anywhere else it could be, and stops for good. Everything after that is
// downstream of what the town keeps: `traffic`, which is the labour and coin
// that passing trade brings; `stock`, which is the food, wood and stone it has
// gone out and got (see `economy.js`); and `pop`, which is who lives there and
// wants somewhere to sleep and something to eat.
//
// A town is plain data. It holds no sprites, no canvases and no colours; the
// renderer turns `kind` into a prop and that is the only place art enters.

import { MAP, TILE, T, buildable, tileIndex, regionAt, REGION_COUNT } from './terrain.js';
import { ROAD_MIN, armCount } from './roads.js';
import {
  emptyStock, stockOf, landOf, hasMaterials, payMaterials, needsStone, materialsFor,
  countKind, workingFields, foodCeiling, consumption, stoneCeiling, hasStoneNearby,
} from './economy.js';

/**
 * Minimum gap between town centres, in world units. Sized against the map
 * rather than against the buildings: towns on a 5040x3360 world want to be a
 * real journey apart, or the road between two of them never gets long enough to
 * grow a junction of its own.
 */
export const TOWN_SPACING = 780;

/**
 * The ceiling, and how it is shaped.
 *
 * `MAX_TOWNS` on its own is a blunt instrument on a map with regions in it: the
 * first territory to grow a road network would take every slot, and the far
 * side of the mountains would stay empty for the rest of the run — which is
 * exactly the outcome the regions exist to prevent, because a region with no
 * towns in it has nothing to trade.
 *
 * So the cap is per region as well as global, and the global one is set below
 * `REGION_COUNT × MAX_PER_REGION` on purpose. The regions compete for the last
 * few slots, and a well-connected territory can end up with five where a
 * mountainous one gets two — but no territory can take them all.
 */
export const MAX_PER_REGION = 5;
export const MAX_TOWNS = 14;

/** How many towns a region is already carrying. */
export function townsInRegion(state, region) {
  let n = 0;
  for (const t of state.towns) if (t.region === region) n++;
  return n;
}

/** Is there room in the world, and in this particular corner of it, for one more? */
export function canFound(state, x, y) {
  if (state.towns.length >= MAX_TOWNS) return false;
  const region = regionAt(state.terrain, Math.floor(x / TILE), Math.floor(y / TILE));
  return townsInRegion(state, region) < MAX_PER_REGION;
}

/** Regions that still have room. Used by the HUD, and by nothing that decides. */
export function openRegions(state) {
  let n = 0;
  for (let r = 0; r < REGION_COUNT; r++) if (townsInRegion(state, r) < MAX_PER_REGION) n++;
  return n;
}

/**
 * How many people sleep where.
 *
 * A tent is one unhitched wagon, so it holds exactly a wagon's souls — the
 * founding party pitches its own transport and that is the town's first
 * housing. `CAMP_BEDS` is the couple of people who will always sleep under a
 * cart whatever else is going on.
 */
const HOUSE_BEDS = 9;
const TENT_BEDS = 5;
const CAMP_BEDS = 3;

/**
 * What gets built, in order.
 *
 * The sequence is the story of a settlement: a stall for the traffic that's
 * already passing and a fingerpost to name the place, a lumberyard once there
 * is enough felling to be worth organising, then the well — which is the first
 * thing here made of *stone*, and therefore the first thing that needs a quarry
 * running before it can be started at all. That break in the middle of the list
 * is the tier line, and it is meant to be felt: everything above it a town can
 * put up with axes the week it arrives, everything below it has to be earned.
 *
 * Houses, farms and quarries are *not* in this list. They are demand-driven —
 * `nextBuild` splices them in when the town runs short of beds, food or stone —
 * which is what makes a settlement's shape reflect the ground it landed on
 * instead of following a script.
 */
export const TOWN_PLAN = [
  'stall', 'signpost', 'lumberyard', 'well', 'inn', 'lamp', 'stall',
  'bakery', 'cart', 'market', 'lamp', 'warehouse', 'smithy',
  'stall', 'haystack', 'lamp', 'cart', 'stall',
];

/** Kinds that come from the plan, so progress through it can be counted. */
const PLANNED = new Set(TOWN_PLAN);

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
  signpost: 14, haystack: 22, tent: 24, farm: 64, quarry: 46,
};

/**
 * How far out of the centre each kind wants to be, as a multiple of the normal
 * placement radius. Homes are happy on the edge; fields and quarries are *work*
 * and belong out past the last house, which is also what stops a town of five
 * buildings drawing a wheatfield through the middle of its own crossroads.
 */
const OUTSKIRTS = { house: 1.75, haystack: 1.75, farm: 2.4, quarry: 2.7, tent: 0.8 };

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

/**
 * Beds this town has. Tents count — they are where a new settlement's people
 * actually sleep, and a town that never gets round to replacing them is a town
 * that never grows past the size of the party that founded it.
 */
export function housing(town) {
  let beds = CAMP_BEDS;
  for (const b of town.buildings) {
    if (b.kind === 'house') beds += HOUSE_BEDS;
    else if (b.kind === 'tent') beds += TENT_BEDS;
  }
  return beds;
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

/** Is there rock within a few tiles — i.e. anything worth putting a quarry on? */
function nearRock(state, tx, ty) {
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = tx + dx, y = ty + dy;
      if (x < 0 || y < 0 || x >= MAP.w || y >= MAP.h) continue;
      const k = state.terrain.kind[tileIndex(x, y)];
      if (k === T.MOUNTAIN) return true;
    }
  }
  return state.terrain.kind[tileIndex(tx, ty)] === T.HILL;
}

/**
 * Can this kind of thing be built on this tile? Buildings want firm, dry,
 * off-road ground — being *next* to the road is the point, being *on* it is not.
 *
 * Two kinds argue with the terrain rather than merely tolerating it, and that is
 * the whole reason the economy is worth having: a field has to go on ground you
 * could plough (grass, or woodland you are willing to clear), and a quarry has
 * to go where there is actually stone to cut.
 */
function siteOk(state, tx, ty, kind) {
  if (tx < 2 || ty < 2 || tx >= MAP.w - 2 || ty >= MAP.h - 2) return false;
  const i = tileIndex(tx, ty);
  const k = state.terrain.kind[i];
  if (kind === 'farm') {
    if (k !== T.GRASS && k !== T.FOREST) return false;
  } else if (kind === 'quarry') {
    if (!buildable(k) || !nearRock(state, tx, ty)) return false;
  } else if (!buildable(k)) return false;
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
  const outskirts = OUTSKIRTS[kind] || 1;
  for (let attempt = 0; attempt < 110; attempt++) {
    const t = attempt / 110;
    const radius = (26 + t * (70 + town.buildings.length * 7)) * outskirts;
    const angle = rng.next() * Math.PI * 2;
    const x = town.x + Math.cos(angle) * radius;
    const y = town.y + Math.sin(angle) * radius * 0.74;   // squashed: reads better top-down
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (!siteOk(state, tx, ty, kind)) continue;
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
    return { x: Math.round(x), y: Math.round(y), tx, ty };
  }
  return null;
}

/** How far through the plan this town is. Tents, homes and works don't count. */
function planIndex(town) {
  let n = 0;
  for (const b of town.buildings) if (PLANNED.has(b.kind)) n++;
  return n;
}

/**
 * Is it time to break in another field?
 *
 * The test is about the *land*, not about today's dinner: a town asks whether
 * everything it could possibly hunt, fish and farm still covers what it eats,
 * with a margin. A settlement in deep forest can put that off for a long time;
 * one on open grass has to plough almost immediately, which is exactly the
 * difference the terrain ought to make.
 *
 * One at a time, always. Two half-cleared plots is two plots feeding nobody.
 */
function wantsField(state, town) {
  const pop = population(town);
  if (pop < 8) return false;
  // Nothing ploughable in reach — a town in the middle of the waste. Asking for
  // a field it can never site would be worse than useless: `growTown` banks
  // traffic against a plot that `findPlot` refuses to find, and the settlement
  // would spend the rest of the game unable to afford anything else. A desert
  // town does not farm. It buys its dinner, or it shrinks.
  const land = landOf(state, town);
  if (land.open + land.forest < 40) return false;
  const fields = countKind(town, 'farm');
  if (fields > workingFields(town)) return false;
  if (fields >= Math.ceil(pop / 12) + 1) return false;
  return foodCeiling(state, town) < consumption(town) * 1.35;
}

/**
 * What this town wants next.
 *
 * Read top to bottom, it is a list of things that beat the build plan, in the
 * order a settlement would actually feel them: nobody lays out a market while
 * the town is starving, and nobody starts a well before there is anywhere to
 * put the stone-cutters.
 *
 * Housing pressure sits below food but above everything else, and is still
 * capped against the working buildings — left uncapped, a busy town becomes a
 * housing estate with a well in it.
 */
function nextBuild(state, town) {
  const free = housing(town) - population(town);
  const homes = countKind(town, 'house') + countKind(town, 'tent');
  const trades = town.buildings.length - homes - countKind(town, 'farm');

  // 1. Somewhere to grow food, if the country around can't keep up.
  if (wantsField(state, town)) return 'farm';

  // 2. Somewhere to sleep. A tent counts, so a founding party's own wagons buy
  //    the town its first few minutes.
  //
  //    The cap against working buildings is the load-bearing half. Without it a
  //    busy town becomes a housing estate with a well in it, and — now that a
  //    settlement can be *blocked* on a material it has no way to get — a town
  //    that will never afford its next building would otherwise spend the rest
  //    of the game building homes instead. Better that it stops.
  const canHouse = homes <= trades + 2;
  if (free < 4 && canHouse) return 'house';

  const plan = TOWN_PLAN[planIndex(town)];
  if (!plan) return free < 10 && canHouse ? 'house' : null;

  // 3. Somewhere to cut stone, if the plan has reached masonry and none is
  //    coming in. A town with rock in reach digs; a town without any waits for
  //    a trade run to bring some, and gets on with what housing it is allowed
  //    in the meantime.
  if (needsStone(plan) && stockOf(town).stone < materialsFor(plan).stone
      && stoneCeiling(state, town) <= 0) {
    if (hasStoneNearby(state, town)) return 'quarry';
    return free < 10 && canHouse ? 'house' : null;
  }
  return plan;
}

/** Arms of road meeting at a town centre, for the HUD and for founding. */
function armsAt(state, x, y) {
  return armCount(state.wear, Math.floor(x / TILE), Math.floor(y / TILE));
}

/**
 * Add the next building, if there's room, labour to raise it and material to
 * make it of.
 *
 * Traffic is the labour and the coin, and still escalates with the size of the
 * place so towns slow down rather than exploding once a trunk road runs through
 * them. Materials are flat per kind and come out of the stores — which is what
 * makes *where* a town is matter as much as how busy its road is.
 */
export function growTown(state, town) {
  const kind = nextBuild(state, town);
  if (!kind) return false;
  // What the escalation counts is the *town*: the buildings that make it a
  // place. Tents were paid for long ago by whoever bought the wagon, and fields
  // and quarries are outlying works that the town has already paid for twice
  // over in timber and in the hands it took to break them in. Charging the
  // escalation on those as well would mean a settlement that invested in
  // feeding itself could never afford a market.
  const n = town.buildings.length - countKind(town, 'tent')
    - countKind(town, 'farm') - countKind(town, 'quarry');
  // Homes and fields are the cheap half: a town should never be unable to
  // shelter or feed the people who already live in it.
  const humble = kind === 'house' || kind === 'farm';
  const cost = humble ? 6 + n * 1.6 : kind === 'quarry' ? 10 + n * 2.5 : 10 + n * 4.5;
  if (town.traffic < cost) return false;
  if (!hasMaterials(town, kind)) return false;

  // A new house replaces a tent wherever there is one to replace: the family
  // that has been sleeping under wagon canvas since the town was founded gets
  // walls, on the same patch of ground. That is the visible payoff of the first
  // load of timber, and it is why a maturing town stops looking like a camp.
  const tentAt = kind === 'house' ? town.buildings.findIndex((b) => b.kind === 'tent') : -1;
  const tent = tentAt >= 0 ? town.buildings[tentAt] : null;
  const plot = tent
    ? { x: tent.x, y: tent.y, tx: Math.floor(tent.x / TILE), ty: Math.floor(tent.y / TILE) }
    : findPlot(state, town, kind, state.rng);
  if (!plot) { town.traffic = cost * 0.8; return false; }   // hemmed in; try later

  town.traffic -= cost;
  payMaterials(town, kind);
  if (tent) town.buildings.splice(tentAt, 1);

  const b = {
    kind,
    x: plot.x,
    y: plot.y,
    variant: state.rng.int(3),
    born: state.time,
  };
  if (kind === 'farm') {
    // Nothing grows here yet. `growth` is how far through breaking the plot in
    // the town has got; woodland plots are slower and pay out timber when the
    // stumps finally come out (see `advanceClearing` in economy.js).
    b.growth = 0;
    b.stumps = state.terrain.kind[tileIndex(plot.tx, plot.ty)] === T.FOREST ? 1 : 0;
  }
  town.buildings.push(b);
  // Outlying works don't make the town itself any bigger.
  if (kind !== 'farm' && kind !== 'quarry') {
    town.radius = Math.max(town.radius, Math.hypot(plot.x - town.x, plot.y - town.y) + 18);
  }
  state.events.push({ type: 'built', x: plot.x, y: plot.y, kind, town: town.id });
  return true;
}

/**
 * Unhitch a founding party's wagons and pitch them as tents.
 *
 * This is where a town's first housing comes from, and it costs nothing but the
 * wagons — which is the point. A caravan that stops for good has just given up
 * its transport, and the shape that transport makes on the ground is a camp.
 */
export function pitchTents(state, town, wagons) {
  for (let i = 0; i < wagons; i++) {
    const plot = findPlot(state, town, 'tent', state.rng);
    if (!plot) return;
    town.buildings.push({
      kind: 'tent',
      x: plot.x,
      y: plot.y,
      variant: state.rng.int(3),
      born: state.time,
    });
    state.events.push({ type: 'built', x: plot.x, y: plot.y, kind: 'tent', town: town.id });
  }
}

/** How many seconds of food in hand a town wants before it grows at all. */
const LARDER_SECONDS = 25;
/** How fast a town that has run out of food loses people, per second. */
const HUNGER_LOSS = 0.06;

/**
 * Natural growth — now gated on the larder as well as on the beds.
 *
 * People arrive to fill beds that exist and are fed, and not otherwise. A town
 * that stops building houses stops growing; a town that outruns its fields
 * stops too, and if the stores actually empty it starts shrinking. That last
 * clause is what turns the economy into something a town can *lose* at, and it
 * is the pressure that pushes hungry settlements to export people (see
 * `considerEmigration`) rather than sit there starving.
 */
export function growPopulation(state, town, dt) {
  const stock = stockOf(town);
  if (town.starving) {
    town.pop = Math.max(0, town.pop - HUNGER_LOSS * dt);
    return;
  }
  const free = housing(town) - population(town);
  if (free <= 0) return;
  if (stock.food < consumption(town) * LARDER_SECONDS) return;
  const rate = 0.005 * Math.min(free, 12) * (0.4 + Math.min(1, town.buildings.length / 10));
  town.pop = Math.min(housing(town), town.pop + rate * dt);
}

// ----------------------------------------------------------------- founding

/**
 * Start a settlement here. Called by a caravan that has decided to stop.
 * The founding party's `pop` is added by the caller's `settle`, not here, so
 * founding and joining credit population through exactly one code path.
 */
export function foundTown(state, x, y) {
  if (!canFound(state, x, y)) return null;
  const town = {
    id: state.nextId++,
    name: townName(state.rng, state.towns.map((t) => t.name)),
    x: Math.round(x),
    y: Math.round(y),
    // Which territory this is in. Stored rather than looked up every time it is
    // wanted — the town cannot move, and the answer is wanted once per trade
    // decision per town per second.
    region: regionAt(state.terrain, Math.floor(x / TILE), Math.floor(y / TILE)),
    founded: state.time,
    traffic: 6,
    pop: 0,          // the founding caravan's souls are added by `settle`
    // Empty stores. Everything in them arrives with the settlers or comes off
    // the ground around the site; nothing is granted.
    stock: emptyStock(),
    radius: 38,
    arms: armsAt(state, x, y),
    buildings: [],
  };
  state.towns.push(town);
  landOf(state, town);      // survey the country while we're here
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
