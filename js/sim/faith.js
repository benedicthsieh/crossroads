// faith.js — the game on top of the simulation.
//
// Everything below this file is a world that runs itself: roads, towns, trade.
// This is the one place the player gets a hand in it, and the design rule is
// that the hand is small. The player does not place towns, steer caravans or
// build anything. They do two things — read omens and choose rites — and the
// faith then has to travel the same way everything else on the map travels:
// in wagons, along roads, at the pace of trade.
//
// So the whole thing is a contagion model riding on the caravan network, with
// a rival doing the same thing from the other side of the map:
//
//   - A town's faith is a pair of fractions, one per creed; the rest are
//     unbelievers. Inside a town each creed grows logistically into the
//     unbelievers, lapses slowly, and pushes against the other one.
//   - A caravan leaving a town carries that town's mix. Wherever it calls it
//     preaches, and wherever it settles its people are mixed in. A town that
//     trades a lot is a town that converts a lot, which is exactly the
//     property Plague Inc. gets from its airports and that this map already had.
//   - Omens are the player's income and their only direct reach. Each one is a
//     brief chance to put a meaning on something that happened — a storm, an
//     eclipse, a flood — and whoever speaks first gets the converts. The rival
//     speaks for any omen its own people witness. That is what keeps the
//     tapping from being chores: an omen you ignore is not simply lost, it goes
//     to the other side.
//
// Like the rest of js/sim/, this is plain data and plain functions. Every roll
// goes through `state.rng`, and the player's only commands (`beginFaith`,
// `claimOmen`, `buyPerk`) are ordinary functions of the state.

import { MAP, TILE, WORLD, T, tileIndex } from './terrain.js';

export const PLAYER = 0;
export const RIVAL = 1;
export const CREEDS = [
  { name: 'the Lantern', color: '#f2c14b', dark: '#9a6f1c' },
  { name: 'the Veiled Choir', color: '#b77ce0', dark: '#5f3b84' },
];

// ------------------------------------------------------------------ pacing

/**
 * When the prologue is over. The world needs enough towns to be worth
 * converting, and in enough regions that the far side of the map exists — but
 * every second spent waiting here is a second the player is watching rather
 * than playing, so the bar is "a map", not "a settled map".
 */
const READY_TOWNS = 5;
const READY_REGIONS = 3;
/** The player may cut the prologue short once there are this many. */
export const EARLY_TOWNS = 3;

/** Seconds after the first sermon before the rival prophet appears. */
const RIVAL_DELAY = 75;
/** The rival's foothold in the town it starts from. */
const RIVAL_SEED = 0.4;
/**
 * What the rival gets for never reading an omen. It is an older, better
 * organised church: its believers spread a little faster and give more. Without
 * this a player who taps diligently meets no opposition at all, because the
 * rival's only income would be the omens it wins off a player who is not
 * paying attention.
 */
const RIVAL_GROWTH = 1.35;
const RIVAL_TITHE = 2.2;
/** The player's foothold in the town they pick. */
const ORIGIN_SEED = 0.3;

// ---------------------------------------------------------------- dynamics

/**
 * In-town growth into the unbelievers, per second. Logistic, so a creed with
 * a handful of believers in a town spreads slowly and one with half the town
 * spreads fast. 0.012 takes a town from a tenth to nine tenths in about six
 * minutes, which is the timescale the whole game is built around: slower than
 * a trade run, so the roads matter; faster than a session, so a town visibly
 * turns.
 */
const GROWTH = 0.006;
/**
 * Lapse, per second, as a fraction of believers. Against GROWTH it sets the
 * ceiling a town settles at on its own: growth into the remaining unbelievers
 * balances lapse at about nine tenths. A town never quite goes all the way
 * without help, which is what makes Feast Days worth buying.
 */
const LAPSE = 0.0006;
/**
 * How hard two creeds in one town push on each other. Low on purpose: the
 * creeds mostly race for unbelievers, and converting someone who already
 * believes something else is slow unless a rite is bought for it.
 */
const CONTEST = 0.004;
/** How much a calling caravan's believers move a town, scaled by headcount. */
const TRANSMIT = 0.16;
/** How far a caravan's own mix drifts toward the town it is calling at. */
const LISTEN = 0.2;
/** Per-second weight of a caravan merely passing through, against a full call. */
const PASSING = 0.12;
/** Devotion per believer per second. */
const TITHE = 0.0032;

// ------------------------------------------------------------------- omens

/** Seconds between omens, before Watchful Eyes. */
const OMEN_GAP = [7, 13];
/** How long an omen waits to be interpreted. */
const OMEN_LIFE = 15;
/** Towns within this many world units witnessed it. */
const OMEN_REACH = 380;
/** Caravans within this many world units witnessed it. */
const OMEN_REACH_CARAVAN = 220;
/** How far through its life an omen is before the rival tries to speak for it. */
const RIVAL_SPEAKS_AT = 0.55;

/**
 * What can happen, and where. The kind is picked by the ground the omen lands
 * on, so a map's omens describe its terrain: a wet map floods, a forested one
 * burns, a desert sees things in the heat.
 */
export const OMENS = {
  fire: { label: 'A tree struck by lightning burns and is not consumed' },
  wave: { label: 'The river rises and spares the ford' },
  bolt: { label: 'Thunder speaks on the heights' },
  eye: { label: 'A pillar of dust walks the waste' },
  comet: { label: 'A star falls in daylight' },
  calf: { label: 'A calf is born with a star on its brow' },
  eclipse: { label: 'The sun goes dark at noon', everywhere: true },
};

// ------------------------------------------------------------------- perks

/**
 * The rites. Three branches, after Plague Inc.'s transmission / symptoms /
 * abilities split: how the word travels, how it holds a town, and how it reads
 * the sky. Costs are fixed rather than escalating — there are few enough of
 * these that order matters more than count.
 */
export const PERKS = [
  { id: 'hymns', branch: 'Word', name: 'Wayside Hymns', cost: 40,
    desc: 'Believers on the road preach twice as hard wherever they call.' },
  { id: 'pilgrims', branch: 'Word', name: 'Pilgrimage', req: 'hymns', cost: 90,
    desc: 'Faithful towns send out more trade runs — more wagons, more sermons.' },
  { id: 'missions', branch: 'Word', name: 'Missions', req: 'pilgrims', cost: 160,
    desc: 'Caravans leaving a faithful town carry far more believers than stay behind.' },

  { id: 'hearth', branch: 'Rite', name: 'Hearth Shrines', cost: 40,
    desc: 'Faith spreads faster inside a town.' },
  { id: 'feasts', branch: 'Rite', name: 'Feast Days', req: 'hearth', cost: 80,
    desc: 'Believers seldom lapse, and hold their ground against the rival.' },
  { id: 'tithes', branch: 'Rite', name: 'Tithes', req: 'hearth', cost: 70,
    desc: 'Every believer gives more devotion.' },
  { id: 'zeal', branch: 'Rite', name: 'Zeal', req: 'feasts', cost: 200,
    desc: 'Your believers win converts from the rival creed, not just from the unbelieving.' },

  { id: 'portents', branch: 'Wonder', name: 'Watchful Eyes', cost: 30,
    desc: 'Omens come half again as often.' },
  { id: 'signs', branch: 'Wonder', name: 'Lasting Signs', req: 'portents', cost: 60,
    desc: 'Omens linger longer and are worth more.' },
  { id: 'preachers', branch: 'Wonder', name: 'Wandering Preachers', req: 'portents', cost: 120,
    desc: 'Caravans that are mostly believers interpret the omens they pass, without you.' },
  { id: 'seers', branch: 'Wonder', name: 'Seers', req: 'preachers', cost: 220,
    desc: 'Devout towns interpret any omen within sight of them.' },
];

const PERK = Object.fromEntries(PERKS.map((p) => [p.id, p]));

/**
 * The order the rival buys in. It has no use for the Wonder branch — it never
 * taps anything — so it is a pure Word-and-Rite build, which is also the build
 * a player who ignores omens is choosing.
 */
const RIVAL_PLAN = ['hearth', 'hymns', 'feasts', 'pilgrims', 'tithes', 'zeal', 'missions'];

// ------------------------------------------------------------------ victory

/** Share of all settled souls that wins. */
export const WIN_SHARE = 0.75;
/** Share the rival needs to win instead. */
export const LOSE_SHARE = 0.6;

// -------------------------------------------------------------------- state

export function createFaith() {
  return {
    // 'prologue' → 'choose' → 'play' → 'over'. The renderer pauses the clock
    // in 'choose'; the sim does not care.
    phase: 'prologue',
    origin: null,
    rivalOrigin: null,
    started: null,
    rivalAt: null,
    devotion: [0, 0],
    perks: [[], []],
    omens: [],
    nextOmen: 0,
    outcome: null,
    endedAt: null,
    claimed: [0, 0],
    missed: 0,
    prophets: [0, 0],
  };
}

export const has = (state, k, id) => state.faith.perks[k].includes(id);

/** A town's pair of shares. Created on demand, so older code paths need not know. */
export function faithOf(town) {
  if (!town.faith) town.faith = [0, 0];
  return town.faith;
}

function free(f) {
  return Math.max(0, 1 - f[0] - f[1]);
}

/** Keep a pair inside the simplex after any update. */
function tidy(f) {
  for (let k = 0; k < 2; k++) {
    if (!(f[k] > 1e-4)) f[k] = 0;
    if (f[k] > 1) f[k] = 1;
  }
  const sum = f[0] + f[1];
  if (sum > 1) { f[0] /= sum; f[1] /= sum; }
  return f;
}

// ---------------------------------------------------------------- the roads

/**
 * Who sets out from a town. Without Missions a caravan is a fair sample of the
 * town; with it, the believers are the ones volunteering for the road.
 */
export function emigrantFaith(state, town) {
  const f = [...faithOf(town)];
  for (let k = 0; k < 2; k++) {
    if (f[k] > 0 && has(state, k, 'missions')) f[k] = Math.min(1, f[k] * 1.8 + 0.1);
  }
  return tidy(f);
}

/** A caravan's people joining a town for good (founding, settling, coming home). */
export function mixFaith(town, souls, carried) {
  const f = faithOf(town);
  const pop = Math.max(0, town.pop);
  const total = pop + souls;
  if (total <= 0 || !carried) return;
  for (let k = 0; k < 2; k++) f[k] = (f[k] * pop + (carried[k] || 0) * souls) / total;
  tidy(f);
}

/**
 * A caravan calling at a town, or (with a small `weight`) passing through it.
 *
 * Both sides talk. The town's unbelievers hear the caravan's believers in
 * proportion to how many of them there are, and the caravan's own mix drifts
 * toward the town's — which is how a trade run that left an unbelieving town
 * comes home carrying the word.
 */
export function preach(state, town, c, weight = 1) {
  if (state.faith.phase !== 'play' || !c.faith) return;
  const f = faithOf(town);
  const share = c.souls / (Math.max(0, town.pop) + c.souls);
  const room = free(f);
  for (let k = 0; k < 2; k++) {
    if (!(c.faith[k] > 0)) continue;
    const hymn = has(state, k, 'hymns') ? 2 : 1;
    f[k] += TRANSMIT * weight * hymn * c.faith[k] * share * room;
  }
  tidy(f);
  for (let k = 0; k < 2; k++) c.faith[k] += (f[k] - c.faith[k]) * LISTEN * weight;
  tidy(c.faith);
}

/** Pilgrimage: how much more often a town sends a trade run out. */
export function tradeBoost(state, town) {
  if (state.faith.phase !== 'play') return 1;
  const f = faithOf(town);
  let m = 1;
  for (let k = 0; k < 2; k++) if (has(state, k, 'pilgrims')) m += 1.4 * f[k];
  return m;
}

// --------------------------------------------------------------- commands

/** The player chooses where the word is first spoken. */
export function beginFaith(state, townId) {
  const fs = state.faith;
  if (fs.phase !== 'choose' && fs.phase !== 'prologue') return false;
  const town = state.towns.find((t) => t.id === townId);
  if (!town) return false;
  const f = faithOf(town);
  f[PLAYER] = Math.max(f[PLAYER], ORIGIN_SEED);
  tidy(f);
  fs.phase = 'play';
  fs.origin = town.id;
  fs.started = state.time;
  fs.rivalAt = state.time + RIVAL_DELAY;
  fs.nextOmen = state.time + 3;
  // A small purse so the first rite is a decision in the first minute, not a
  // wait.
  fs.devotion[PLAYER] = 8;
  state.events.push({ type: 'faithBegun', x: town.x, y: town.y, name: town.name });
  return true;
}

export function canBuy(state, id, k = PLAYER) {
  const p = PERK[id];
  if (!p || has(state, k, id)) return false;
  if (p.req && !has(state, k, p.req)) return false;
  return state.faith.devotion[k] >= p.cost;
}

export function buyPerk(state, id, k = PLAYER) {
  if (!canBuy(state, id, k)) return false;
  state.faith.devotion[k] -= PERK[id].cost;
  state.faith.perks[k].push(id);
  state.events.push({ type: 'perk', faith: k, id });
  return true;
}

/**
 * A prophet sent to one town: the player's only way to point the faith at a
 * particular place rather than waiting for the roads to take it there.
 *
 * It exists as the devotion sink. Rites are a fixed list, and once both creeds
 * own all of theirs the contest settles into a standing split that nothing can
 * move; the prophet is what devotion is for after that. The price climbs with
 * every one sent so it cannot simply be spammed down the town list.
 */
const PROPHET_BASE = 60;
const PROPHET_STEP = 0.5;
const PROPHET_PULL = 0.3;

export function prophetCost(state, k = PLAYER) {
  return Math.round(PROPHET_BASE * (1 + PROPHET_STEP * state.faith.prophets[k]));
}

export function sendProphet(state, townId, k = PLAYER) {
  const fs = state.faith;
  if (fs.phase !== 'play') return false;
  const town = state.towns.find((t) => t.id === townId);
  const cost = prophetCost(state, k);
  if (!town || fs.devotion[k] < cost) return false;
  const f = faithOf(town);
  // Converts from the unbelievers first and the other creed second: a prophet
  // preaches to whoever will listen.
  let want = PROPHET_PULL * (1 - f[k]);
  const fromFree = Math.min(want, free(f));
  f[k] += fromFree;
  want -= fromFree;
  const other = 1 - k;
  const fromOther = Math.min(want, f[other]);
  f[other] -= fromOther;
  f[k] += fromOther;
  tidy(f);
  fs.devotion[k] -= cost;
  fs.prophets[k]++;
  state.events.push({ type: 'prophet', x: town.x, y: town.y, faith: k, name: town.name });
  return true;
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

/** What an omen is worth to whoever interprets it, in devotion. */
export function omenValue(state, o, k = PLAYER) {
  const { towns, caravans } = witnesses(state, o);
  let souls = 0;
  for (const { t, w } of towns) souls += t.pop * w;
  for (const c of caravans) souls += c.souls;
  const signs = has(state, k, 'signs') ? 1.35 : 1;
  const big = OMENS[o.kind] && OMENS[o.kind].everywhere ? 1.6 : 1;
  return Math.round(Math.min(20, 2 + souls * 0.03) * signs * big * 10) / 10;
}

/**
 * Speak for an omen. The player calls this by tapping one; the rival, preachers
 * and seers call it from `tickFaith`. Whoever gets there first takes it.
 */
export function claimOmen(state, omenId, k = PLAYER, by = 'hand') {
  const fs = state.faith;
  if (fs.phase !== 'play') return false;
  const i = fs.omens.findIndex((o) => o.id === omenId);
  if (i < 0) return false;
  const o = fs.omens[i];
  fs.omens.splice(i, 1);

  const value = omenValue(state, o, k);
  fs.devotion[k] += value;
  fs.claimed[k]++;

  const { towns, caravans } = witnesses(state, o);
  for (const { t, w } of towns) {
    const f = faithOf(t);
    // The faithful are the ones who can explain what everyone just saw, so an
    // omen does far more where a creed already has a voice. Where it has none
    // it still plants something — that is how the word reaches a town no
    // caravan has brought it to.
    f[k] += (0.012 + 0.05 * f[k]) * w * free(f);
    tidy(f);
  }
  for (const c of caravans) {
    if (!c.faith) c.faith = [0, 0];
    c.faith[k] += (0.05 + 0.15 * c.faith[k]) * free(c.faith);
    tidy(c.faith);
  }
  state.events.push({
    type: 'omenClaimed', x: o.x, y: o.y, faith: k, value, kind: o.kind, by,
  });
  return true;
}

// ------------------------------------------------------------------- ticking

function ready(state) {
  const regions = new Set(state.towns.map((t) => t.region));
  if (state.towns.length >= READY_TOWNS && regions.size >= READY_REGIONS) return true;
  // A seed whose third region is slow to settle should not hold the game
  // hostage; by now there is plenty to convert.
  return state.towns.length >= READY_TOWNS + 2;
}

/** Can the player cut the prologue short yet? */
export function canBeginEarly(state) {
  return state.faith.phase === 'prologue' && state.towns.length >= EARLY_TOWNS;
}

/** The player cutting the prologue short. A command, like the others. */
export function endPrologue(state) {
  if (!canBeginEarly(state)) return false;
  state.faith.phase = 'choose';
  state.events.push({ type: 'chooseOrigin' });
  return true;
}

/** Called once per upkeep second from `step`. */
export function tickFaith(state, dt) {
  const fs = state.faith;
  if (fs.phase === 'prologue') {
    if (ready(state)) {
      fs.phase = 'choose';
      state.events.push({ type: 'chooseOrigin' });
    }
    return;
  }
  if (fs.phase !== 'play') return;

  growTowns(state, dt);
  passers(state);
  tithe(state, dt);
  omens(state);
  rival(state);
  judge(state);
}

function growTowns(state, dt) {
  const power = [0, 1].map((k) => 1
    + (has(state, k, 'zeal') ? 1.2 : 0)
    + (has(state, k, 'feasts') ? 0.5 : 0));
  for (const town of state.towns) {
    const f = faithOf(town);
    const room = free(f);
    const add = [0, 0];
    for (let k = 0; k < 2; k++) {
      if (!(f[k] > 0)) continue;
      const hearth = (has(state, k, 'hearth') ? 1.6 : 1) * (k === RIVAL ? RIVAL_GROWTH : 1);
      const feast = has(state, k, 'feasts') ? 0.15 : 1;
      add[k] = GROWTH * hearth * f[k] * room - LAPSE * feast * f[k];
    }
    // The two creeds pushing on each other. Whichever has more rites behind it
    // wins converts from the other; equal, they hold.
    const push = CONTEST * f[0] * f[1] * (power[0] - power[1]);
    f[0] += (add[0] + push) * dt;
    f[1] += (add[1] - push) * dt;
    tidy(f);
  }
}

/** Caravans rolling through a town without stopping still talk to it a little. */
function passers(state) {
  for (const c of state.caravans) {
    if (!c.faith || !(c.faith[0] > 0 || c.faith[1] > 0)) continue;
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
  const n = [0, 0];
  for (const t of state.towns) {
    const f = faithOf(t);
    n[0] += t.pop * f[0];
    n[1] += t.pop * f[1];
  }
  for (const c of state.caravans) {
    if (!c.faith) continue;
    n[0] += c.souls * c.faith[0];
    n[1] += c.souls * c.faith[1];
  }
  return n;
}

/** Shares of all *settled* souls, which is what victory is judged on. */
export function shares(state) {
  let pop = 0, a = 0, b = 0;
  for (const t of state.towns) {
    const f = faithOf(t);
    pop += t.pop;
    a += t.pop * f[0];
    b += t.pop * f[1];
  }
  return pop > 0 ? [a / pop, b / pop] : [0, 0];
}

function tithe(state, dt) {
  const n = believers(state);
  for (let k = 0; k < 2; k++) {
    const rate = (has(state, k, 'tithes') ? 1.7 : 1) * (k === RIVAL ? RIVAL_TITHE : 1);
    state.faith.devotion[k] += n[k] * TITHE * rate * dt;
  }
}

/** Where the next omen lands: near people, because an omen nobody saw is weather. */
function placeOmen(state) {
  const rng = state.rng;
  let ax = WORLD.w / 2, ay = WORLD.h / 2;
  if (state.caravans.length && rng.chance(0.3)) {
    const c = rng.pick(state.caravans);
    ax = c.x; ay = c.y;
  } else if (state.towns.length) {
    // Weighted by population, with a floor so a hamlet still sees the odd sign.
    let total = 0;
    for (const t of state.towns) total += 10 + t.pop;
    let r = rng.next() * total;
    for (const t of state.towns) {
      r -= 10 + t.pop;
      if (r <= 0) { ax = t.x; ay = t.y; break; }
    }
  }
  const a = rng.next() * Math.PI * 2;
  const d = rng.range(50, 220);
  const x = Math.max(40, Math.min(WORLD.w - 40, ax + Math.cos(a) * d));
  const y = Math.max(40, Math.min(WORLD.h - 40, ay + Math.sin(a) * d));
  return { x, y };
}

function omenKind(state, x, y) {
  const rng = state.rng;
  if (rng.chance(0.05)) return 'eclipse';
  const tx = Math.min(MAP.w - 1, Math.floor(x / TILE));
  const ty = Math.min(MAP.h - 1, Math.floor(y / TILE));
  const k = state.terrain.kind[tileIndex(tx, ty)];
  if (k === T.WATER) return 'wave';
  if (k === T.FOREST) return 'fire';
  if (k === T.MOUNTAIN || k === T.HILL) return 'bolt';
  if (k === T.DESERT) return 'eye';
  return rng.chance(0.5) ? 'comet' : 'calf';
}

function omens(state) {
  const fs = state.faith;
  const rng = state.rng;

  if (state.time >= fs.nextOmen && state.towns.length) {
    const { x, y } = placeOmen(state);
    const kind = omenKind(state, x, y);
    const life = OMEN_LIFE * (has(state, PLAYER, 'signs') ? 1.4 : 1);
    const o = {
      id: state.nextId++, kind, x: Math.round(x), y: Math.round(y),
      born: Math.round(state.time * 10) / 10, life, tried: false,
    };
    fs.omens.push(o);
    state.events.push({ type: 'omen', id: o.id, x: o.x, y: o.y, kind });
    const gap = rng.range(OMEN_GAP[0], OMEN_GAP[1]);
    fs.nextOmen = state.time + gap / (has(state, PLAYER, 'portents') ? 1.5 : 1);
  }

  // Iterate over a copy: claiming removes from the live list.
  for (const o of [...fs.omens]) {
    const age = state.time - o.born;

    if (autoClaimer(state, o)) { claimOmen(state, o.id, PLAYER, 'preacher'); continue; }

    if (!o.tried && fs.rivalOrigin != null && age >= o.life * RIVAL_SPEAKS_AT) {
      o.tried = true;
      // The rival speaks where its own people saw the thing. An omen in the
      // middle of a town that is half Choir is very likely to go to the Choir;
      // one out in your own country almost never does.
      const { towns } = witnesses(state, o);
      let wsum = 0, presence = 0;
      for (const { t, w } of towns) { wsum += w; presence += w * faithOf(t)[RIVAL]; }
      const p = Math.min(0.85, 0.08 + 1.8 * (wsum > 0 ? presence / wsum : 0));
      if (rng.chance(p)) { claimOmen(state, o.id, RIVAL, 'rival'); continue; }
    }

    if (age >= o.life) {
      fs.omens.splice(fs.omens.indexOf(o), 1);
      fs.missed++;
      state.events.push({ type: 'omenFaded', x: o.x, y: o.y });
    }
  }
}

/** Is a preacher or a seer close enough to read this omen for the player? */
function autoClaimer(state, o) {
  if (has(state, PLAYER, 'seers')) {
    for (const t of state.towns) {
      if (faithOf(t)[PLAYER] >= 0.6 && Math.hypot(t.x - o.x, t.y - o.y) < 320) return true;
    }
  }
  if (has(state, PLAYER, 'preachers')) {
    for (const c of state.caravans) {
      if (c.faith && c.faith[PLAYER] >= 0.5 && Math.hypot(c.x - o.x, c.y - o.y) < 160) return true;
    }
  }
  return false;
}

/** The rival prophet: appears on a timer, as far from you as the map allows. */
function rival(state) {
  const fs = state.faith;
  if (fs.rivalOrigin == null) {
    if (state.time < fs.rivalAt) return;
    const origin = state.towns.find((t) => t.id === fs.origin) || state.towns[0];
    if (!origin) return;
    let best = null, bestScore = -Infinity;
    for (const t of state.towns) {
      if (t.id === fs.origin) continue;
      const score = Math.hypot(t.x - origin.x, t.y - origin.y)
        + (t.region !== origin.region ? 1500 : 0)
        + Math.min(60, t.pop) * 4
        - faithOf(t)[PLAYER] * 3000;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (!best) return;
    const f = faithOf(best);
    f[RIVAL] = Math.max(f[RIVAL], Math.min(RIVAL_SEED, free(f) + f[RIVAL]));
    tidy(f);
    fs.rivalOrigin = best.id;
    state.events.push({ type: 'rivalRises', x: best.x, y: best.y, name: best.name });
    return;
  }
  for (const id of RIVAL_PLAN) {
    if (has(state, RIVAL, id)) continue;
    buyPerk(state, id, RIVAL);
    return;         // one at a time, in order, like someone saving up
  }
  // Rites all bought: prophets into the biggest town it is losing but has a
  // voice in. Only with something in hand, so a prophet is never its last coin.
  if (fs.devotion[RIVAL] < prophetCost(state, RIVAL) * 1.3) return;
  let target = null, best = 0;
  for (const t of state.towns) {
    const f = faithOf(t);
    const score = t.pop * (1 - f[RIVAL]) * (f[RIVAL] > 0.05 ? 1 : 0.3);
    if (score > best) { best = score; target = t; }
  }
  if (target) sendProphet(state, target.id, RIVAL);
}

function judge(state) {
  const fs = state.faith;
  const [mine, theirs] = shares(state);
  let outcome = null;
  if (mine >= WIN_SHARE && state.towns.length >= READY_TOWNS) outcome = 'won';
  else if (theirs >= LOSE_SHARE) outcome = 'lost';
  else if (believers(state)[PLAYER] < 0.5) outcome = 'extinct';
  if (!outcome) return;
  fs.outcome = outcome;
  fs.phase = 'over';
  fs.endedAt = state.time;
  fs.omens.length = 0;
  state.events.push({ type: 'faithOver', outcome });
}

// ------------------------------------------------------------- persistence

const r4 = (v) => Math.round(v * 10000) / 10000;

export function snapshotFaith(fs) {
  return {
    ...fs,
    devotion: fs.devotion.map((v) => Math.round(v * 100) / 100),
    perks: fs.perks.map((p) => [...p]),
    omens: fs.omens.map((o) => ({ ...o })),
    claimed: [...fs.claimed],
    prophets: [...fs.prophets],
  };
}

export function restoreFaith(snap) {
  const fs = { ...createFaith(), ...(snap || {}) };
  fs.devotion = [...fs.devotion];
  fs.perks = fs.perks.map((p) => [...p]);
  fs.omens = fs.omens.map((o) => ({ ...o }));
  fs.claimed = [...fs.claimed];
  fs.prophets = [...fs.prophets];
  return fs;
}

/** Rounded copy of a share pair for a save. Four places is well below anything visible. */
export function packShares(f) {
  return f ? [r4(f[0]), r4(f[1])] : undefined;
}
