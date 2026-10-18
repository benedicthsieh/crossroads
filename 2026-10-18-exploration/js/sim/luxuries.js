// luxuries.js — the things a town cannot get at home.
//
// Food, wood and stone are *staples*: every town needs them, and almost every
// town can get them somewhere in its own country. That is fine for building
// things and useless as a reason to travel. A trade run that carries timber to
// a town with a forest in it is moving numbers around.
//
// Luxuries are the other half. There are three families, and each is scarce in
// a different geometry, on purpose:
//
//   spice   only grows on desert — one region in four is arid, so most of the
//           map cannot produce a grain of it at any price
//   herbs   grow almost anywhere, but *which* herb depends on latitude, so a
//           northern town and a southern one have different jars and each
//           wants the other's
//   gems    come out of a handful of placed lodes, and only once somebody has
//           dug a quarry to work one. Most towns will never have any
//
// Between them those three cover the three shapes scarcity comes in: one place
// has it, everywhere has a *different* one, and hardly anywhere has it. A town
// that wants all three has to trade in three directions, and the roads that
// falls out of are roads no staple would ever have justified.
//
// What luxuries actually *do* is deliberately indirect. They are not a currency
// and they are not a building material — nothing hard-stalls on them, because a
// settlement that can never buy spice should be poorer, not stuck. Instead they
// raise a town's **standing**: a place with a full larder, a warm inn and
// something worth smelling attracts more traffic and turns that traffic into
// buildings faster. And standing rewards *variety* far more than quantity, so a
// desert town sitting on a mountain of its own spice is worth less than one that
// swapped half of it away for herbs and gems.

import { herbAt, TILE } from './terrain.js';

/**
 * Everything a caravan can carry that isn't a staple.
 *
 * `family` is what makes the herbs work: three separate goods that a town reads
 * as one need, so holding any one of them counts once toward variety and
 * holding all three is worth barely more than holding one. Otherwise the
 * north-south herb trade would be worth three times a gem run, which is exactly
 * backwards.
 */
export const LUXURIES = {
  spice: { label: 'spice', family: 'spice', icon: 'spice' },
  mosswort: { label: 'mosswort', family: 'herb', icon: 'herb' },
  wildbay: { label: 'wildbay', family: 'herb', icon: 'herb' },
  sunbalm: { label: 'sunbalm', family: 'herb', icon: 'herb' },
  gems: { label: 'gems', family: 'gems', icon: 'gem' },
};

export const LUXURY_KINDS = Object.keys(LUXURIES);
export const STAPLES = ['food', 'wood', 'stone'];
/** Everything that can sit in a store or in a wagon. Order matters for saves. */
export const RESOURCES = [...STAPLES, ...LUXURY_KINDS];

const FAMILIES = ['spice', 'herb', 'gems'];

/**
 * How much of one luxury a town can hold.
 *
 * Small, and *not* shared with the staple store: the warehouse exists to bank
 * timber toward a smithy, and a town that could stockpile four hundred jars of
 * spice would trade once and then never need to again. Keeping the shelf short
 * is what makes the trade a standing arrangement rather than a single delivery.
 */
export const LUXURY_CAP = 14;

/** Held amount at which a town counts as fully supplied with something. */
const SATED = 4.5;

/** Below this a jar is a curiosity, not a supply — it doesn't count as variety. */
const PRESENT = 0.8;

/** How much a second luxury family compounds the value of the first. */
const VARIETY_BONUS = 0.4;

/** What a town gets through, per person per second. Luxuries are *consumed*. */
const USE_PER_PERSON = 0.0000135;

// ------------------------------------------------------------------ yields
//
// All three trickle in without being budgeted for in `produce`'s labour split,
// and that is a decision rather than an oversight: picking spice pods and
// digging herbs out of a hedge is what a town's children and its old people do,
// not work it takes hands off the woodpile for. Gems are the exception in
// spirit — they need a quarry — but they come out *with* the stone, so the
// hands were already paid for.

const SPICE_PER_TILE = 0.0000135, SPICE_CEILING = 0.020;
const HERB_PER_TILE = 0.0000042, HERB_CEILING = 0.011;
const GEMS_PER_LODE = 0.0055, GEM_LODES_FULL = 2;

/** Which herb grows around a town. Pure function of where it happens to be. */
export function herbOf(town) {
  return herbAt(Math.floor(town.y / TILE));
}

/**
 * What this town can gather per second, by kind. `land` is the survey from
 * `economy.js`; `quarries` gates the gems and nothing else.
 */
export function luxuryYields(town, land, quarries) {
  const out = {};
  if (land.desert > 0) {
    out.spice = Math.min(SPICE_CEILING, SPICE_PER_TILE * land.desert);
  }
  // Herbs come off hedgerow and woodland edge — anything wild and green. Sand
  // and bare rock give nothing, which is the other half of why a desert town is
  // poor: it has the spice and almost nothing else.
  const wild = land.forest + land.open + land.hill;
  if (wild > 0) {
    out[herbOf(town)] = Math.min(HERB_CEILING, HERB_PER_TILE * wild);
  }
  if (land.lodes > 0 && quarries > 0) {
    out.gems = GEMS_PER_LODE * Math.min(1, land.lodes / GEM_LODES_FULL);
  }
  return out;
}

// ---------------------------------------------------------------- standing

/**
 * How well supplied a town is, roughly 0..5.
 *
 * The shape is the design: each family contributes how full its shelf is, and
 * then the whole lot is multiplied by how many *different* families are on it.
 * One family fully stocked scores 1; three families fully stocked score 3 × 1.8
 * rather than 3. That gap is the entire reason a town bothers sending a caravan
 * somewhere it could not walk to in an afternoon.
 */
export function standing(stock) {
  if (!stock) return 0;
  let held = 0, kinds = 0;
  for (const family of FAMILIES) {
    let best = 0;
    for (const kind of LUXURY_KINDS) {
      if (LUXURIES[kind].family !== family) continue;
      best = Math.max(best, stock[kind] || 0);
    }
    held += Math.min(1, best / SATED);
    if (best >= PRESENT) kinds++;
  }
  if (kinds === 0) return 0;
  return held * (1 + VARIETY_BONUS * (kinds - 1));
}

/** Everything a town is short of, as a fraction. Used to aim a trade run. */
export function wants(stock) {
  const out = {};
  for (const kind of LUXURY_KINDS) {
    out[kind] = Math.max(0, 1 - (stock[kind] || 0) / SATED);
  }
  return out;
}

/**
 * How much two towns have to say to each other, 0..3ish.
 *
 * Counts families rather than goods, and counts both directions: a run is worth
 * making if they have something we lack *or* we have something they lack —
 * a caravan that arrives empty still comes home loaded.
 */
export function complement(a, b) {
  let score = 0;
  for (const family of FAMILIES) {
    let mine = 0, theirs = 0;
    for (const kind of LUXURY_KINDS) {
      if (LUXURIES[kind].family !== family) continue;
      mine = Math.max(mine, a[kind] || 0);
      theirs = Math.max(theirs, b[kind] || 0);
    }
    if (theirs >= PRESENT && mine < SATED * 0.5) score += 1;
    if (mine >= PRESENT && theirs < SATED * 0.5) score += 0.6;
  }
  return score;
}

/**
 * A luxury tick: gather what the land gives, and get through what the people
 * enjoy. Returns the standing that came out of it, which is what `produce`
 * turns into traffic.
 */
export function tickLuxuries(stock, yields, pop, dt) {
  for (const kind of LUXURY_KINDS) {
    const gained = (yields[kind] || 0) * dt;
    const used = (stock[kind] || 0) > 0 ? USE_PER_PERSON * pop * dt : 0;
    const next = (stock[kind] || 0) + gained - used;
    stock[kind] = Math.max(0, Math.min(LUXURY_CAP, next));
  }
  return standing(stock);
}

/** The luxuries a town actually holds, for the panel. Sorted, heaviest first. */
export function heldLuxuries(stock, min = 0.5) {
  const out = [];
  for (const kind of LUXURY_KINDS) {
    if ((stock[kind] || 0) >= min) out.push({ kind, label: LUXURIES[kind].label, n: stock[kind] });
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}
