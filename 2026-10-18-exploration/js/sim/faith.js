// faith.js — the game on top of the simulation.
//
// Everything below this file is a world that runs itself: roads, towns, trade,
// and now the odd fire or flood. This is the one place the player gets a hand
// in it, and the design rule is that the hand is small. The player does not
// place towns, steer caravans or build anything. They choose where the word is
// first spoken and what it is the word *of*, they spend a scarce attention on
// the omens worth spending it on, and they choose rites as they are revealed.
// The faith then has to travel the way everything else on the map travels: in
// wagons, along roads, at the pace of trade.
//
// This version is not a race. The map already believes something when the
// player arrives: two old faiths, the Veiled Choir and the Old Ways, come in
// with the settlers from opposite sides of the world and settle into a rough
// balance before the first sermon. The player's creed is the insurgent. The
// old faiths do not hunt it, buy rites or read omens; they hold what they have,
// fill the empty ground slowly, and win back the wavering. There is nothing to
// lose to. There is a chronicle of firsts to fill in instead (`MARKS`), and
// most of them are about *reaching* somewhere: a new region, a town that is
// wholly yours, the far side of a range.
//
// The pieces:
//
//   - A town's faith is a vector of shares, one per creed; the remainder
//     believe nothing. Each caravan carries the same vector.
//   - Omens are the news. Some are weather; most are things that actually
//     happened — a town founded, a hungry winter, strange goods arriving, a
//     forest burning down (see nature.js). Every omen is read eventually: the
//     faithful explain it in their own way when it fades, for a fraction of its
//     worth. Reading one yourself is worth far more and costs *insight*, which
//     is scarce and slow to return, so the game is choosing which omens matter.
//   - Rites are dealt, not listed. Three are on offer at a time, some come in
//     mutually exclusive pairs, and the creed's aspect — chosen at the start
//     from what the land around its first town offers — adds rites of its own.
//
// Like the rest of js/sim/, this is plain data and plain functions. Every roll
// goes through `state.rng`, and the player's commands (`beginFaith`,
// `chooseAspect`, `claimOmen`, `buyPerk`, `sendProphet`, `endPrologue`) are
// ordinary functions of the state.

import { MAP, TILE, WORLD, T, tileIndex } from './terrain.js';
import { hash3 } from './rng.js';
import { landOf, countKind, stockOf } from './economy.js';
import { heldLuxuries } from './luxuries.js';

export const PLAYER = 0;
export const CHOIR = 1;
export const OLDWAYS = 2;
export const OLD = [CHOIR, OLDWAYS];
export const NC = 3;
export const CREEDS = [
  { name: 'the Lantern', short: 'Lantern', color: '#f2c14b', dark: '#9a6f1c' },
  { name: 'the Veiled Choir', short: 'Choir', color: '#b77ce0', dark: '#5f3b84' },
  { name: 'the Old Ways', short: 'Old Ways', color: '#6cc0a4', dark: '#2f6b5e' },
];

// ------------------------------------------------------------------ pacing

const READY_TOWNS = 5;
const READY_REGIONS = 3;
/** The player may cut the prologue short once there are this many. */
export const EARLY_TOWNS = 3;
/** The player's foothold in the town they pick. */
const ORIGIN_SEED = 0.3;
/** The first congregation never quite forgets. */
const ORIGIN_FLOOR = 0.08;

// ---------------------------------------------------------------- dynamics

/**
 * In-town growth into the unbelievers, per second. Logistic, so a handful of
 * believers spreads slowly and half a town spreads fast.
 */
const GROWTH = 0.0018;
const LAPSE = 0.00026;
/**
 * Converting somebody who already believes something is the slow half of the
 * game, and it is meant to be. A town founded by Choir settlers is a Choir
 * town; the Lantern gets the unbelievers quickly and the faithful only by
 * grinding, by omens, and by rites bought for it.
 */
const CONVERT = 0.00033;
/** The old faiths winning back the wavering. Just under CONVERT, so the grind is slow but real. */
const RECLAIM = 0.0008;
/** The old faiths fill empty ground, but slowly — they are not trying very hard. */
const OLD_GROWTH = 0.0016;
const OLD_LAPSE = 0.0002;
/** Within a town, the larger of the two old faiths slowly absorbs the smaller. */
const OLD_DRIFT = 0.0008;
/** How much a calling caravan's believers move a town, scaled by headcount. */
const TRANSMIT = 0.11;
const TRANSMIT_OLD = 0.06;
/** How far a caravan's own mix drifts toward the town it is calling at. */
const LISTEN = 0.2;
/** Per-second weight of a caravan merely passing through, against a full call. */
const PASSING = 0.12;
/** Devotion per believer per second. */
const TITHE = 0.0012;

// ------------------------------------------------------------------ insight

/**
 * Insight is the player's attention, made scarce. One point reads one omen in
 * full. It comes back slowly and the purse is small, so the decision every
 * time a bubble appears is "is this the one?" — spend it on a calf with a star
 * on its brow and you may not have it when the forest catches fire.
 */
export const INSIGHT_CAP = 3;
const INSIGHT_TIME = 70;
/** What an omen you let pass is still worth: your faithful explain it themselves. */
const PASSIVE = 0.3;

// ------------------------------------------------------------------- omens

/** Seconds between ambient omens, before Watchful Eyes. */
const OMEN_GAP = [16, 28];
/** Towns within this many world units witnessed it. */
const OMEN_REACH = 380;
/** Caravans within this many world units witnessed it. */
const OMEN_REACH_CARAVAN = 220;
/** No more than this many omens on the map at once. */
const OMEN_MAX = 6;
/** A town does not raise more than one omen of its own in this many seconds. */
const TOWN_OMEN_GAP = 50;

/**
 * Tiers. A sign is weather and is everywhere; a wonder is the forest burning
 * down. The multiplier is on what reading one is worth, in devotion and in
 * converts; how long it lingers rises with it, so the big ones can be reached.
 */
export const TIERS = [
  null,
  { name: 'sign', mult: 1, life: 22 },
  { name: 'portent', mult: 2.4, life: 32 },
  { name: 'marvel', mult: 4.5, life: 42 },
  { name: 'wonder', mult: 8, life: 56 },
];

/**
 * What can happen. `aspect` ties an omen to one of the creed's aspects, which
 * doubles what it is worth to a creed of that aspect. The ambient ones are
 * picked by the ground they land on; the rest are raised by the world.
 */
export const OMENS = {
  comet: { label: 'A star falls in daylight', icon: 'comet', tier: 1 },
  calf: { label: 'A calf is born with a star on its brow', icon: 'calf', tier: 1 },
  bolt: { label: 'Thunder speaks on the heights', icon: 'bolt', tier: 1, aspect: 'stone' },
  eye: { label: 'A pillar of dust walks the waste', icon: 'eye', tier: 1, aspect: 'sand' },
  tide: { label: 'The river runs backward for an hour', icon: 'water', tier: 1, aspect: 'river' },
  bloom: { label: 'A tree blooms out of season', icon: 'herb', tier: 1, aspect: 'grove' },
  eclipse: { label: 'The sun goes dark at noon', icon: 'eclipse', tier: 4, everywhere: true },
  hearth: { label: 'A new hearth is lit', icon: 'heart', tier: 2, aspect: 'road' },
  hunger: { label: 'Hunger', icon: 'wheat', tier: 2, hungry: true },
  goods: { label: 'Strange goods arrive', icon: 'spice', tier: 2, aspect: 'road' },
  market: { label: 'A market is raised', icon: 'coin', tier: 1, aspect: 'road' },
  wildfire: { label: 'The forest burns', icon: 'fire', tier: 4, aspect: 'grove' },
  flood: { label: 'The river breaks its banks', icon: 'wave', tier: 3, aspect: 'river' },
};

// ----------------------------------------------------------------- aspects

/**
 * What the creed is the creed *of*. Chosen once, from three offered, and the
 * three are read off the land around the town it started in — a creed born on
 * a riverbank is offered the river. Each one makes the faith stronger in towns
 * that stand on its kind of ground, doubles the worth of its kind of omen, and
 * adds two rites to the deck that nobody else gets.
 */
export const ASPECTS = {
  river: { name: 'the River', desc: 'Strong in towns by water. Floods and river signs are yours.' },
  sand: { name: 'the Waste', desc: 'Strong in towns on the sand. What walks the desert speaks for you.' },
  stone: { name: 'the Heights', desc: 'Strong in hill and mountain towns. Thunder is yours.' },
  grove: { name: 'the Grove', desc: 'Strong in forest towns. When the woods burn, they burn for you.' },
  road: { name: 'the Road', desc: 'Strong in busy towns. New hearths, markets and strange goods are yours.' },
};

/** How much of an aspect's kind of ground a town stands on, 0..1. */
export function affinity(state, town, aspect) {
  if (!aspect) return 0;
  const land = landOf(state, town);
  switch (aspect) {
    case 'river': return Math.min(1, land.water / 140);
    case 'sand': return Math.min(1, land.desert / 500);
    case 'stone': return Math.min(1, (land.mountain + land.hill) / 550);
    case 'grove': return Math.min(1, land.forest / 650);
    case 'road': return Math.min(1, town.buildings.length / 22);
    default: return 0;
  }
}

/** How strongly the creed's aspect pulls in a town: a multiplier on growth and conversion. */
const ASPECT_PULL = 0.7;
const aspectBoost = (state, town) => 1 + ASPECT_PULL * affinity(state, town, state.faith.aspect);

// ------------------------------------------------------------------- perks

/**
 * The deck of rites. Three are face up at a time; buying one deals the next.
 * `excl` pairs are a fork in the road: buy one and the other leaves the deck
 * for good. `aspect` rites are only in the deck of a creed of that aspect.
 * `mark` rites are only dealt once that page of the chronicle is written.
 */
export const PERKS = [
  { id: 'hymns', name: 'Wayside Hymns', cost: 30,
    desc: 'Believers on the road preach twice as hard wherever they call.' },
  { id: 'hearth', name: 'Hearth Shrines', cost: 30,
    desc: 'The word spreads half again as fast inside a town.' },
  { id: 'portents', name: 'Watchful Eyes', cost: 25,
    desc: 'Omens come half again as often.' },
  { id: 'signs', name: 'Lasting Signs', cost: 40,
    desc: 'Omens linger longer, and the ones you let pass are worth half, not a third.' },
  { id: 'feasts', name: 'Feast Days', cost: 50,
    desc: 'Believers seldom lapse.' },
  { id: 'tithes', name: 'Tithes', cost: 55,
    desc: 'Every believer gives more devotion.' },
  { id: 'pilgrims', name: 'Pilgrimage', cost: 70, req: 'hymns',
    desc: 'Believing towns send out more trade runs: more wagons, more sermons.' },
  { id: 'missions', name: 'Missions', cost: 100, req: 'pilgrims',
    desc: 'Caravans leaving a believing town carry far more believers than stay behind.' },
  { id: 'open', name: 'The Open Door', cost: 80, excl: 'narrow',
    desc: 'Win the old faiths’ people twice as fast.' },
  { id: 'narrow', name: 'The Narrow Gate', cost: 80, excl: 'open',
    desc: 'The old faiths almost never win anyone back from you.' },
  { id: 'deep', name: 'A Deep Well', cost: 60, excl: 'quick',
    desc: 'Hold five insight instead of three.' },
  { id: 'quick', name: 'A Quick Tongue', cost: 60, excl: 'deep',
    desc: 'Insight returns twice as fast.' },
  { id: 'seers', name: 'Seers', cost: 140, mark: 'stronghold',
    desc: 'Towns that are mostly yours read any omen near them, in full, without spending insight.' },

  { id: 'ford', name: 'Ford Baptisms', cost: 50, aspect: 'river',
    desc: 'Caravans calling at a river town preach twice as hard there.' },
  { id: 'floodtide', name: 'Floodtide', cost: 90, aspect: 'river',
    desc: 'Floods come twice as often, and every flood is read for you in full.' },
  { id: 'psalms', name: 'Spice Psalms', cost: 50, aspect: 'sand',
    desc: 'Caravans carrying spice preach twice as hard.' },
  { id: 'mirage', name: 'Mirage Seers', cost: 90, aspect: 'sand',
    desc: 'Omens on the sand are worth three times as much and last twice as long.' },
  { id: 'cairns', name: 'Cairn Wardens', cost: 50, aspect: 'stone',
    desc: 'In hill and mountain towns, the old faiths cannot win your people back.' },
  { id: 'quarry', name: 'Quarry Chapels', cost: 70, aspect: 'stone',
    desc: 'Towns with a quarry give twice the devotion.' },
  { id: 'ash', name: 'Ash and Seed', cost: 60, aspect: 'grove',
    desc: 'A burning forest preaches to every town that can see the smoke.' },
  { id: 'kindling', name: 'Kindling', cost: 90, aspect: 'grove',
    desc: 'Lightning finds the forest twice as often.' },
  { id: 'wayshrines', name: 'Wayshrines', cost: 50, aspect: 'road',
    desc: 'Caravans passing a believing town pick up the word three times as fast.' },
  { id: 'heralds', name: 'Heralds', cost: 80, aspect: 'road',
    desc: 'Every new town is founded with a few of your believers among its first settlers.' },
];

const PERK = Object.fromEntries(PERKS.map((p) => [p.id, p]));
/** Face-up rites at once. */
const HAND = 3;

// --------------------------------------------------------------- the chronicle

/**
 * Firsts. Nothing is lost by not writing one; each is worth a refill of
 * insight and a little devotion when it is, and a couple of them deal rites
 * that are not in the deck before. Region marks are made per map, below.
 */
const MARKS = [
  { id: 'foothold', text: 'The word takes root beyond its first town' },
  { id: 'stronghold', text: 'A town is mostly yours' },
  { id: 'wonder', text: 'You read a wonder with your own eyes' },
  { id: 'tenth', text: 'One soul in ten keeps the Lantern' },
  { id: 'quarter', text: 'One soul in four' },
  { id: 'choir', text: 'More keep the Lantern than the Choir' },
  { id: 'oldways', text: 'More keep the Lantern than the Old Ways' },
  { id: 'everywhere', text: 'A believer in every town' },
  { id: 'half', text: 'Half of all souls' },
  { id: 'most', text: 'Three souls in four' },
];

export function marksFor(state) {
  const regions = state.terrain.regions.map((r) => ({
    id: `region${r.id}`, text: `The word reaches the ${r.name}`,
  }));
  return [...MARKS.slice(0, 2), ...regions, ...MARKS.slice(2)];
}

// -------------------------------------------------------------------- state

export function createFaith() {
  return {
    // 'prologue' → 'choose' → 'aspect' → 'play'. The renderer holds the clock
    // in 'choose' and 'aspect'; the sim does not care.
    phase: 'prologue',
    origin: null,
    started: null,
    aspect: null,
    aspectOffer: [],
    devotion: 0,
    insight: 0,
    perks: [],
    hand: [],
    gone: [],
    marks: {},
    omens: [],
    nextOmen: 0,
    claimed: 0,
    passed: 0,
    prophets: 0,
    // What each town looked like last second, so the world's own news can be
    // noticed: a town founded, a larder empty, a luxury seen for the first time.
    watch: {},
  };
}

export const has = (state, id) => state.faith.perks.includes(id);

/** A town's vector of shares. Created on demand, so older code paths need not know. */
export function faithOf(town) {
  if (!town.faith || town.faith.length !== NC) {
    const old = town.faith || [];
    town.faith = [0, 0, 0].map((_, k) => old[k] || 0);
  }
  return town.faith;
}

function free(f) {
  return Math.max(0, 1 - f[0] - f[1] - f[2]);
}

/** Keep a vector inside the simplex after any update. */
function tidy(f) {
  let sum = 0;
  for (let k = 0; k < NC; k++) {
    if (!(f[k] > 1e-4)) f[k] = 0;
    if (f[k] > 1) f[k] = 1;
    sum += f[k];
  }
  if (sum > 1) for (let k = 0; k < NC; k++) f[k] /= sum;
  return f;
}

/** Move `amount` of share from the old faiths to the player, in proportion to what each holds. */
function takeFromOld(f, amount) {
  const old = f[CHOIR] + f[OLDWAYS];
  if (old <= 0 || amount <= 0) return;
  const a = Math.min(amount, old);
  f[CHOIR] -= a * (f[CHOIR] / old);
  f[OLDWAYS] -= a * (f[OLDWAYS] / old);
  f[PLAYER] += a;
}

/** And back again: the wavering returning to whichever old faith is stronger here. */
function giveToOld(f, amount) {
  const a = Math.min(amount, f[PLAYER]);
  if (a <= 0) return;
  const old = f[CHOIR] + f[OLDWAYS];
  const toChoir = old > 0 ? f[CHOIR] / old : 0.5;
  f[PLAYER] -= a;
  f[CHOIR] += a * toChoir;
  f[OLDWAYS] += a * (1 - toChoir);
}

// ---------------------------------------------------------------- strangers

/**
 * What a caravan arriving from off the map believes.
 *
 * The two old faiths come from opposite sides of the world, along an axis
 * picked by the seed: settlers from one edge are mostly Choir, from the other
 * mostly Old Ways, and the middle of the map gets both. So the balance the
 * player walks into is geography, not a number — and the frontier between the
 * old faiths is a real place, usually somewhere around the middle regions.
 */
export function strangerFaith(state, x, y) {
  const rng = state.rng;
  const a = hash3(state.seed, 1, 77) * Math.PI * 2;
  const proj = (x / WORLD.w - 0.5) * Math.cos(a) + (y / WORLD.h - 0.5) * Math.sin(a);
  const lean = Math.max(0.04, Math.min(0.96, 0.5 + 1.3 * proj + (rng.next() - 0.5) * 0.4));
  const devout = rng.range(0.55, 0.85);
  return [0, devout * lean, devout * (1 - lean)];
}

// ---------------------------------------------------------------- the roads

/**
 * Who sets out from a town. Without Missions a caravan is a fair sample of the
 * town; with it, the believers are the ones volunteering for the road.
 */
export function emigrantFaith(state, town) {
  const f = [...faithOf(town)];
  if (f[PLAYER] > 0 && has(state, 'missions')) f[PLAYER] = Math.min(1, f[PLAYER] * 1.8 + 0.1);
  return tidy(f);
}

/** A caravan's people joining a town for good (founding, settling, coming home). */
export function mixFaith(town, souls, carried) {
  const f = faithOf(town);
  const pop = Math.max(0, town.pop);
  const total = pop + souls;
  if (total <= 0 || !carried) return;
  for (let k = 0; k < NC; k++) f[k] = (f[k] * pop + (carried[k] || 0) * souls) / total;
  tidy(f);
}

/**
 * A caravan calling at a town, or (with a small `weight`) passing through it.
 *
 * Both sides talk. The old faiths preach only into the unbelievers; the
 * Lantern preaches into them and, more slowly, into the old faiths' people.
 * The caravan's own mix drifts toward the town's, which is how a trade run
 * that left a Choir town can come home carrying the word.
 */
export function preach(state, town, c, weight = 1) {
  if (!c.faith) return;
  if (c.faith.length !== NC) c.faith = [0, 0, 0].map((_, k) => c.faith[k] || 0);
  const fs = state.faith;
  const f = faithOf(town);
  const share = c.souls / (Math.max(0, town.pop) + c.souls);
  const room = free(f);
  const playing = fs.phase === 'play';

  if (playing && c.faith[PLAYER] > 0) {
    let hymn = has(state, 'hymns') ? 2 : 1;
    if (has(state, 'ford') && affinity(state, town, 'river') > 0.3) hymn *= 2;
    if (has(state, 'psalms') && c.cargo && c.cargo.spice > 0.2) hymn *= 2;
    const push = TRANSMIT * weight * hymn * c.faith[PLAYER] * share * aspectBoost(state, town);
    const open = has(state, 'open') ? 2 : 1;
    f[PLAYER] += push * room;
    takeFromOld(f, push * 0.12 * open * (f[CHOIR] + f[OLDWAYS]));
  }
  for (const k of OLD) {
    if (c.faith[k] > 0) f[k] += TRANSMIT_OLD * weight * c.faith[k] * share * room;
  }
  tidy(f);
  const listen = LISTEN * weight * (has(state, 'wayshrines') ? 3 : 1);
  for (let k = 0; k < NC; k++) c.faith[k] += (f[k] - c.faith[k]) * Math.min(1, listen);
  tidy(c.faith);
}

/** Pilgrimage: how much more often a town sends a trade run out. */
export function tradeBoost(state, town) {
  if (state.faith.phase !== 'play' || !has(state, 'pilgrims')) return 1;
  return 1 + 1.4 * faithOf(town)[PLAYER];
}

// --------------------------------------------------------------- commands

/** The player chooses where the word is first spoken. Then they choose what it is the word of. */
export function beginFaith(state, townId) {
  const fs = state.faith;
  if (fs.phase !== 'choose' && fs.phase !== 'prologue') return false;
  const town = state.towns.find((t) => t.id === townId);
  if (!town) return false;
  fs.origin = town.id;
  fs.phase = 'aspect';
  // Offer the three aspects the land around this town favours most. The Road is
  // always in contention, scored as if every town were a little busy, so a
  // town on featureless grass still gets three real choices.
  const scored = Object.keys(ASPECTS).map((id) => ({
    id, s: id === 'road' ? 0.3 + affinity(state, town, 'road') * 0.4 : affinity(state, town, id),
  }));
  scored.sort((a, b) => b.s - a.s);
  fs.aspectOffer = scored.slice(0, 3).map((a) => a.id);
  state.events.push({ type: 'chooseAspect', x: town.x, y: town.y, name: town.name });
  return true;
}

export function chooseAspect(state, id) {
  const fs = state.faith;
  if (fs.phase !== 'aspect' || !fs.aspectOffer.includes(id)) return false;
  const town = state.towns.find((t) => t.id === fs.origin);
  if (!town) return false;
  const f = faithOf(town);
  // The foothold is carved out of everyone, unbelievers first.
  const room = free(f);
  const fromFree = Math.min(ORIGIN_SEED, room);
  f[PLAYER] += fromFree;
  takeFromOld(f, ORIGIN_SEED - fromFree);
  tidy(f);
  fs.aspect = id;
  fs.phase = 'play';
  fs.started = state.time;
  fs.nextOmen = state.time + 4;
  fs.devotion = 10;
  fs.insight = 2;
  // Start watching the towns as they are now, so the ones that already exist
  // are not all announced as news in the first second.
  for (const t of state.towns) fs.watch[t.id] = watchOf(state, t);
  // The opening hand is cheap on purpose: the first rite should be a decision
  // in the first minute, not a wait.
  fs.hand = [];
  deal(state, 25);
  deal(state, 30);
  deal(state, 30);
  state.events.push({ type: 'faithBegun', x: town.x, y: town.y, name: town.name, aspect: id });
  return true;
}

/**
 * What a rite costs now. Each one bought makes the next dearer, so the deck is
 * worked through over a session rather than emptied in the first ten minutes
 * by a creed whose tithes compound.
 */
const COST_STEP = 0.3;
export function perkCost(state, id) {
  const p = PERK[id];
  return p ? Math.round(p.cost * (1 + COST_STEP * state.faith.perks.length)) : Infinity;
}

export function canBuy(state, id) {
  const p = PERK[id];
  const fs = state.faith;
  if (!p || has(state, id) || !fs.hand.includes(id)) return false;
  return fs.devotion >= perkCost(state, id);
}

export function buyPerk(state, id) {
  if (!canBuy(state, id)) return false;
  const fs = state.faith;
  const p = PERK[id];
  fs.devotion -= perkCost(state, id);
  fs.perks.push(id);
  fs.hand = fs.hand.filter((h) => h !== id);
  if (p.excl) {
    fs.gone.push(p.excl);
    fs.hand = fs.hand.filter((h) => h !== p.excl);
  }
  while (fs.hand.length < HAND && deal(state)) { /* deal until full or the deck is empty */ }
  if (id === 'deep') fs.insight = Math.min(insightCap(state), fs.insight + 1);
  state.events.push({ type: 'perk', id, name: p.name });
  return true;
}

/** Whether a rite could be dealt now. */
function dealable(state, p) {
  const fs = state.faith;
  if (has(state, p.id) || fs.gone.includes(p.id) || fs.hand.includes(p.id)) return false;
  if (p.aspect && p.aspect !== fs.aspect) return false;
  if (p.req && !has(state, p.req)) return false;
  if (p.mark && !fs.marks[p.mark]) return false;
  return true;
}

/**
 * Turn one more rite face up. Aspect rites are dealt twice as readily: they
 * are the reason the aspect was worth choosing. `maxCost` keeps the opening
 * hand affordable.
 */
function deal(state, maxCost = Infinity) {
  const fs = state.faith;
  const pool = PERKS.filter((p) => dealable(state, p) && p.cost <= maxCost);
  if (!pool.length) return false;
  let total = 0;
  for (const p of pool) total += p.aspect ? 2 : 1;
  let r = state.rng.next() * total;
  for (const p of pool) {
    r -= p.aspect ? 2 : 1;
    if (r <= 0) { fs.hand.push(p.id); return true; }
  }
  fs.hand.push(pool[pool.length - 1].id);
  return true;
}

/**
 * A preacher sent to one town: the player's only way to point the faith at a
 * particular place rather than waiting for the roads to take it there. The
 * price climbs with every one sent.
 */
const PROPHET_BASE = 60;
const PROPHET_STEP = 0.5;
const PROPHET_PULL = 0.25;

export function prophetCost(state) {
  return Math.round(PROPHET_BASE * (1 + PROPHET_STEP * state.faith.prophets));
}

export function sendProphet(state, townId) {
  const fs = state.faith;
  if (fs.phase !== 'play') return false;
  const town = state.towns.find((t) => t.id === townId);
  const cost = prophetCost(state);
  if (!town || fs.devotion < cost) return false;
  const f = faithOf(town);
  // Converts the unbelievers first and the old faiths' people second.
  let want = PROPHET_PULL * (1 - f[PLAYER]);
  const fromFree = Math.min(want, free(f));
  f[PLAYER] += fromFree;
  want -= fromFree;
  takeFromOld(f, want);
  tidy(f);
  fs.devotion -= cost;
  fs.prophets++;
  state.events.push({ type: 'prophet', x: town.x, y: town.y, name: town.name });
  return true;
}

// -------------------------------------------------------------------- omens

export function insightCap(state) {
  return INSIGHT_CAP + (has(state, 'deep') ? 2 : 0);
}

/** Seconds until the next point of insight, for the HUD. */
export function insightEta(state) {
  const fs = state.faith;
  if (fs.insight >= insightCap(state)) return 0;
  return (1 - (fs.insight % 1)) * INSIGHT_TIME / (has(state, 'quick') ? 2 : 1);
}

/** Who saw an omen, and how well. Read at the moment it is interpreted. */
function witnesses(state, o) {
  const towns = [];
  const caravans = [];
  const everywhere = OMENS[o.kind] && OMENS[o.kind].everywhere;
  for (const t of state.towns) {
    const d = Math.hypot(t.x - o.x, t.y - o.y);
    if (everywhere) towns.push({ t, w: 0.5 });
    else if (d < OMEN_REACH) towns.push({ t, w: 1 - (d / OMEN_REACH) * 0.7 });
  }
  if (!everywhere) {
    for (const c of state.caravans) {
      if (Math.hypot(c.x - o.x, c.y - o.y) < OMEN_REACH_CARAVAN) caravans.push(c);
    }
  }
  return { towns, caravans };
}

function omenBonus(state, o) {
  const def = OMENS[o.kind] || {};
  let m = TIERS[o.tier].mult;
  if (def.aspect && def.aspect === state.faith.aspect) m *= 2;
  if (has(state, 'mirage') && o.sand) m *= 3;
  return m;
}

/** What an omen is worth if you read it yourself, in devotion. */
export function omenValue(state, o) {
  const { towns, caravans } = witnesses(state, o);
  let souls = 0;
  for (const { t, w } of towns) souls += t.pop * w;
  for (const c of caravans) souls += c.souls;
  const base = Math.min(12, 1.5 + souls * 0.02);
  return Math.round(base * omenBonus(state, o) * 10) / 10;
}

/** What it is worth if you let it pass. */
export function passiveValue(state, o) {
  return Math.round(omenValue(state, o) * passiveShare(state) * 10) / 10;
}

const passiveShare = (state) => (has(state, 'signs') ? 0.5 : PASSIVE);

/**
 * Read an omen. `by` is 'hand' when the player taps it (and it costs insight),
 * 'seer' or 'tide' when a rite reads it for them in full, and 'faithful' when
 * it faded and the believers made what they could of it.
 */
export function claimOmen(state, omenId, by = 'hand') {
  const fs = state.faith;
  if (fs.phase !== 'play') return false;
  const i = fs.omens.findIndex((o) => o.id === omenId);
  if (i < 0) return false;
  const o = fs.omens[i];
  if (by === 'hand') {
    if (fs.insight < 1) return false;
    fs.insight -= 1;
  }
  fs.omens.splice(i, 1);

  const full = by !== 'faithful';
  const strength = Math.pow(omenBonus(state, o), 0.6) * (full ? 1 : passiveShare(state))
    * (OMENS[o.kind] && OMENS[o.kind].hungry ? 1.5 : 1);
  const value = full ? omenValue(state, o) : passiveValue(state, o);
  fs.devotion += value;
  if (full) fs.claimed++; else fs.passed++;
  if (by === 'hand' && o.tier >= 4) mark(state, 'wonder');

  const { towns, caravans } = witnesses(state, o);
  for (const { t, w } of towns) {
    const f = faithOf(t);
    // The faithful are the ones who can explain what everyone just saw, so an
    // omen does far more where the creed already has a voice. Where it has none
    // it still plants something: that is how the word reaches a town no
    // caravan has carried it to. A big enough sign shakes the old certainties
    // too, which is most of what the Lantern has against them.
    const boost = aspectBoost(state, t);
    f[PLAYER] += (0.008 + 0.033 * f[PLAYER]) * w * strength * boost * free(f);
    takeFromOld(f, (0.0065 + 0.026 * f[PLAYER]) * w * strength * boost * (f[CHOIR] + f[OLDWAYS]));
    tidy(f);
  }
  for (const c of caravans) {
    if (!c.faith || c.faith.length !== NC) c.faith = [0, 0, 0].map((_, k) => (c.faith || [])[k] || 0);
    c.faith[PLAYER] += Math.min(1, (0.05 + 0.15 * c.faith[PLAYER]) * strength) * free(c.faith);
    tidy(c.faith);
  }
  state.events.push({
    type: 'omenClaimed', x: o.x, y: o.y, value, kind: o.kind, tier: o.tier, by, label: o.label,
  });
  return true;
}

/** Put an omen on the map. */
function raise(state, kind, x, y, extra = {}) {
  const fs = state.faith;
  if (fs.omens.length >= OMEN_MAX) {
    // A crowded sky drops its least important sign to make room for a big one.
    const def = OMENS[kind];
    let worst = -1;
    for (let i = 0; i < fs.omens.length; i++) {
      if (fs.omens[i].tier < def.tier && (worst < 0 || fs.omens[i].tier < fs.omens[worst].tier)) worst = i;
    }
    if (worst < 0) return null;
    fs.omens.splice(worst, 1);
  }
  const def = OMENS[kind];
  const tx = Math.max(0, Math.min(MAP.w - 1, Math.floor(x / TILE)));
  const ty = Math.max(0, Math.min(MAP.h - 1, Math.floor(y / TILE)));
  const sand = state.terrain.kind[tileIndex(tx, ty)] === T.DESERT;
  let life = TIERS[def.tier].life * (has(state, 'signs') ? 1.4 : 1);
  if (sand && has(state, 'mirage')) life *= 2;
  const o = {
    id: state.nextId++, kind, tier: def.tier, icon: extra.icon || def.icon,
    label: extra.label || def.label,
    x: Math.round(x), y: Math.round(y),
    born: Math.round(state.time * 10) / 10, life: Math.round(life), sand,
    fire: extra.fire,
  };
  fs.omens.push(o);
  state.events.push({ type: 'omen', id: o.id, x: o.x, y: o.y, kind, tier: o.tier, label: o.label });
  return o;
}

// ------------------------------------------------------------------- ticking

function ready(state) {
  const regions = new Set(state.towns.map((t) => t.region));
  if (state.towns.length >= READY_TOWNS && regions.size >= READY_REGIONS) return true;
  return state.towns.length >= READY_TOWNS + 2;
}

export function canBeginEarly(state) {
  return state.faith.phase === 'prologue' && state.towns.length >= EARLY_TOWNS;
}

export function endPrologue(state) {
  if (!canBeginEarly(state)) return false;
  state.faith.phase = 'choose';
  state.events.push({ type: 'chooseOrigin' });
  return true;
}

/** Called once per upkeep second from `step`. */
export function tickFaith(state, dt) {
  const fs = state.faith;
  // The old faiths live whether or not anybody is playing: the balance the
  // player walks into is one the prologue actually built.
  growOld(state, dt);
  if (fs.phase === 'prologue') {
    if (ready(state)) {
      fs.phase = 'choose';
      state.events.push({ type: 'chooseOrigin' });
    }
    state.nature.news.length = 0;
    return;
  }
  if (fs.phase !== 'play') { state.nature.news.length = 0; return; }

  growLantern(state, dt);
  passers(state);
  tithe(state, dt);
  const rate = has(state, 'quick') ? 2 : 1;
  fs.insight = Math.min(insightCap(state), fs.insight + (dt / INSIGHT_TIME) * rate);
  news(state);
  omens(state);
  fires(state);
  chronicle(state);
}

function growOld(state, dt) {
  for (const town of state.towns) {
    const f = faithOf(town);
    const room = free(f);
    const a = f[CHOIR], b = f[OLDWAYS];
    f[CHOIR] += (OLD_GROWTH * a * room - OLD_LAPSE * a) * dt;
    f[OLDWAYS] += (OLD_GROWTH * b * room - OLD_LAPSE * b) * dt;
    // Consolidation: a town settles toward being one old faith's or the other's.
    const drift = OLD_DRIFT * a * b * Math.sign(a - b) * dt;
    f[CHOIR] += drift;
    f[OLDWAYS] -= drift;
    tidy(f);
  }
}

function growLantern(state, dt) {
  const fs = state.faith;
  const hearth = has(state, 'hearth') ? 1.5 : 1;
  const feast = has(state, 'feasts') ? 0.2 : 1;
  const open = has(state, 'open') ? 2 : 1;
  const narrow = has(state, 'narrow') ? 0.15 : 1;
  for (const town of state.towns) {
    const f = faithOf(town);
    if (!(f[PLAYER] > 0)) continue;
    const boost = aspectBoost(state, town) * hearth;
    const room = free(f);
    const old = f[CHOIR] + f[OLDWAYS];
    const cairn = has(state, 'cairns') && affinity(state, town, 'stone') > 0.3 ? 0 : 1;
    const p = f[PLAYER];
    f[PLAYER] += (GROWTH * boost * p * room - LAPSE * feast * p) * dt;
    takeFromOld(f, CONVERT * boost * open * p * old * dt);
    giveToOld(f, RECLAIM * narrow * cairn * p * old * (1 + old) * dt);
    if (town.id === fs.origin && f[PLAYER] < ORIGIN_FLOOR) takeFromOld(f, ORIGIN_FLOOR - f[PLAYER]);
    tidy(f);
  }
}

/** Caravans rolling through a town without stopping still talk to it a little. */
function passers(state) {
  for (const c of state.caravans) {
    if (!c.faith) continue;
    let best = null, bestD = 90;
    for (const t of state.towns) {
      const d = Math.hypot(t.x - c.x, t.y - c.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) preach(state, best, c, PASSING);
  }
}

/** Believers, per creed, in towns and on the road. */
export function believers(state) {
  const n = [0, 0, 0];
  for (const t of state.towns) {
    const f = faithOf(t);
    for (let k = 0; k < NC; k++) n[k] += t.pop * f[k];
  }
  for (const c of state.caravans) {
    if (!c.faith) continue;
    for (let k = 0; k < NC; k++) n[k] += c.souls * (c.faith[k] || 0);
  }
  return n;
}

/** Shares of all *settled* souls. */
export function shares(state) {
  let pop = 0;
  const s = [0, 0, 0];
  for (const t of state.towns) {
    const f = faithOf(t);
    pop += t.pop;
    for (let k = 0; k < NC; k++) s[k] += t.pop * f[k];
  }
  return pop > 0 ? s.map((v) => v / pop) : s;
}

function tithe(state, dt) {
  const rate = has(state, 'tithes') ? 1.7 : 1;
  let n = believers(state)[PLAYER];
  if (has(state, 'quarry')) {
    for (const t of state.towns) if (countKind(t, 'quarry') > 0) n += t.pop * faithOf(t)[PLAYER];
  }
  state.faith.devotion += n * TITHE * rate * dt;
}

// ----------------------------------------------------------------- the news

/** A cheap fingerprint of a town, to notice when something about it changes. */
function watchOf(state, t) {
  return {
    s: t.starving ? 1 : 0,
    l: heldLuxuries(stockOf(t), 1).map((x) => x.kind).sort().join(','),
    m: countKind(t, 'market') > 0 ? 1 : 0,
    at: -999,
  };
}

/**
 * Turn what the world did this second into omens. The interesting thing about
 * this map is that it changes, and the omens are how the player is told where.
 */
function news(state) {
  const fs = state.faith;
  for (const n of state.nature.news) {
    if (n.kind === 'fire') raise(state, 'wildfire', n.x, n.y, { fire: n.fire });
    else if (n.kind === 'flood') {
      const o = raise(state, 'flood', n.x, n.y);
      if (o && has(state, 'floodtide')) claimOmen(state, o.id, 'tide');
    }
  }
  state.nature.news.length = 0;

  for (const t of state.towns) {
    const now = watchOf(state, t);
    const was = fs.watch[t.id];
    if (!was) {
      now.at = state.time;
      fs.watch[t.id] = now;
      if (has(state, 'heralds')) {
        const f = faithOf(t);
        f[PLAYER] = Math.max(f[PLAYER], 0.12);
        tidy(f);
      }
      raise(state, 'hearth', t.x, t.y, { label: `A new hearth is lit at ${t.name}` });
      continue;
    }
    let kind = null, extra = {};
    if (now.s && !was.s) {
      kind = 'hunger';
      extra = { label: `Hunger in ${t.name}` };
    }
    // Luxuries are remembered as the set ever seen, not the set held now: stock
    // hovers round the "has some" line, and a town is only surprised once.
    const before = new Set(was.l.split(',').filter(Boolean));
    const fresh = now.l.split(',').filter((x) => x && !before.has(x));
    now.l = [...new Set([...before, ...fresh])].sort().join(',');
    if (!kind && fresh.length) {
      kind = 'goods';
      extra = { label: `Strange goods reach ${t.name}`, icon: fresh[0] };
    } else if (!kind && now.m && !was.m) {
      kind = 'market';
      extra = { label: `${t.name} raises a market` };
    }
    now.at = was.at;
    if (kind && state.time - was.at >= TOWN_OMEN_GAP) {
      now.at = state.time;
      const a = state.rng.next() * Math.PI * 2;
      raise(state, kind, t.x + Math.cos(a) * 40, t.y + Math.sin(a) * 30, extra);
    }
    fs.watch[t.id] = now;
  }
}

/**
 * Where the next ambient omen lands: near people, because an omen nobody saw is
 * weather, and nearer the towns that are *growing*, because that is where
 * there is something to look at.
 */
function placeOmen(state) {
  const rng = state.rng;
  let ax = WORLD.w / 2, ay = WORLD.h / 2;
  if (state.caravans.length && rng.chance(0.25)) {
    const c = rng.pick(state.caravans);
    ax = c.x; ay = c.y;
  } else if (state.towns.length) {
    const weight = (t) => {
      let fresh = 0;
      for (const b of t.buildings) if (b.born > state.time - 180) fresh++;
      return (10 + t.pop) * (1 + 0.5 * Math.min(6, fresh));
    };
    let total = 0;
    for (const t of state.towns) total += weight(t);
    let r = rng.next() * total;
    for (const t of state.towns) {
      r -= weight(t);
      if (r <= 0) { ax = t.x; ay = t.y; break; }
    }
  }
  const a = rng.next() * Math.PI * 2;
  const d = rng.range(50, 220);
  const x = Math.max(40, Math.min(WORLD.w - 40, ax + Math.cos(a) * d));
  const y = Math.max(40, Math.min(WORLD.h - 40, ay + Math.sin(a) * d));
  return { x, y };
}

function ambientKind(state, x, y) {
  const rng = state.rng;
  if (rng.chance(0.03)) return 'eclipse';
  const tx = Math.min(MAP.w - 1, Math.floor(x / TILE));
  const ty = Math.min(MAP.h - 1, Math.floor(y / TILE));
  const k = state.terrain.kind[tileIndex(tx, ty)];
  if (k === T.WATER) return 'tide';
  if (k === T.FOREST) return 'bloom';
  if (k === T.MOUNTAIN || k === T.HILL) return 'bolt';
  if (k === T.DESERT) return 'eye';
  return rng.chance(0.5) ? 'comet' : 'calf';
}

function omens(state) {
  const fs = state.faith;
  const rng = state.rng;

  if (state.time >= fs.nextOmen && state.towns.length) {
    const { x, y } = placeOmen(state);
    raise(state, ambientKind(state, x, y), x, y);
    const gap = rng.range(OMEN_GAP[0], OMEN_GAP[1]);
    fs.nextOmen = state.time + gap / (has(state, 'portents') ? 1.5 : 1);
  }

  for (const o of [...fs.omens]) {
    if (seen(state, o)) { claimOmen(state, o.id, 'seer'); continue; }
    // A wildfire omen lasts as long as the fire does, within reason.
    const burning = o.fire != null && state.nature.fires.some((f) => f.id === o.fire);
    const age = state.time - o.born;
    if (age >= o.life && !(burning && age < o.life * 2)) claimOmen(state, o.id, 'faithful');
  }
}

/** Is a seer close enough to read this omen for the player? */
function seen(state, o) {
  if (!has(state, 'seers')) return false;
  for (const t of state.towns) {
    if (faithOf(t)[PLAYER] >= 0.6 && Math.hypot(t.x - o.x, t.y - o.y) < 320) return true;
  }
  return false;
}

/** Ash and Seed: a forest fire preaching to every town that can see the smoke. */
function fires(state) {
  if (!has(state, 'ash')) return;
  for (const fire of state.nature.fires) {
    for (const t of state.towns) {
      const d = Math.hypot(t.x - fire.x, t.y - fire.y);
      if (d > 600) continue;
      const f = faithOf(t);
      const w = 1 - d / 600;
      f[PLAYER] += 0.004 * w * free(f);
      takeFromOld(f, 0.0015 * w * (f[CHOIR] + f[OLDWAYS]));
      tidy(f);
    }
  }
}

// ------------------------------------------------------------- the chronicle

function mark(state, id) {
  const fs = state.faith;
  if (fs.marks[id]) return false;
  fs.marks[id] = Math.round(state.time);
  // A page of the chronicle is worth a clear head and a little coin.
  fs.insight = Math.max(fs.insight, insightCap(state));
  fs.devotion += 15;
  const text = marksFor(state).find((m) => m.id === id);
  state.events.push({ type: 'mark', id, text: text ? text.text : id });
  // A mark may unlock rites; make sure the hand is full if one just became dealable.
  while (fs.hand.length < HAND && deal(state)) { /* refill */ }
  return true;
}

function chronicle(state) {
  const fs = state.faith;
  const s = shares(state);
  let reached = 0;
  for (const t of state.towns) {
    const p = faithOf(t)[PLAYER];
    if (t.id !== fs.origin && p >= 0.2) mark(state, 'foothold');
    if (p >= 0.6) mark(state, 'stronghold');
    if (p >= 0.1) mark(state, `region${t.region}`);
    if (p >= 0.02) reached++;
  }
  if (state.towns.length >= 6 && reached === state.towns.length) mark(state, 'everywhere');
  if (s[PLAYER] >= 0.1) mark(state, 'tenth');
  if (s[PLAYER] >= 0.25) mark(state, 'quarter');
  if (s[PLAYER] >= 0.5) mark(state, 'half');
  if (s[PLAYER] >= 0.75) mark(state, 'most');
  if (s[PLAYER] > s[CHOIR] && s[CHOIR] > 0.02) mark(state, 'choir');
  if (s[PLAYER] > s[OLDWAYS] && s[OLDWAYS] > 0.02) mark(state, 'oldways');
}

// ------------------------------------------------------------- persistence

const r4 = (v) => Math.round(v * 10000) / 10000;

export function snapshotFaith(fs) {
  return {
    ...fs,
    devotion: Math.round(fs.devotion * 100) / 100,
    insight: Math.round(fs.insight * 1000) / 1000,
    perks: [...fs.perks],
    hand: [...fs.hand],
    gone: [...fs.gone],
    aspectOffer: [...fs.aspectOffer],
    marks: { ...fs.marks },
    omens: fs.omens.map((o) => ({ ...o })),
    watch: Object.fromEntries(Object.entries(fs.watch).map(([k, v]) => [k, { ...v }])),
  };
}

export function restoreFaith(snap) {
  const fs = { ...createFaith(), ...(snap || {}) };
  fs.perks = [...fs.perks];
  fs.hand = [...fs.hand];
  fs.gone = [...fs.gone];
  fs.aspectOffer = [...fs.aspectOffer];
  fs.marks = { ...fs.marks };
  fs.omens = fs.omens.map((o) => ({ ...o }));
  fs.watch = Object.fromEntries(Object.entries(fs.watch).map(([k, v]) => [k, { ...v }]));
  return fs;
}

/** Rounded copy of a share vector for a save. Four places is well below anything visible. */
export function packShares(f) {
  return f ? f.map(r4) : undefined;
}
