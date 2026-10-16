// balance.mjs — play the faith game headlessly, with a scripted player.
//
//   node tools/balance.mjs <seed> <tapRate> <reactSeconds> [perk,order,...]
//
// The sim has no DOM in it, so a whole game runs under plain node in a few
// seconds. The "player" here interprets each omen with probability `tapRate`,
// after roughly `reactSeconds` of sim time, buys rites in the given order and
// spends anything left over on prophets. Running it at 0, 0.5 and 0.9 across a
// handful of seeds is how the constants in js/sim/faith.js were set: an idle
// player should lose, a diligent one should win, and a half-attentive one
// should be a real contest.

import { createState, step } from '../js/sim/state.js';
import {
  beginFaith, claimOmen, buyPerk, sendProphet, prophetCost, faithOf, shares,
} from '../js/sim/faith.js';
import { Rng } from '../js/sim/rng.js';

const seed = +(process.argv[2] || 1);
const tapRate = +(process.argv[3] || 0.9);
const delay = +(process.argv[4] || 3);
const plan = (process.argv[5]
  || 'portents,hearth,hymns,signs,feasts,preachers,pilgrims,tithes,zeal,missions,seers').split(',');

const s = createState(seed);
const bot = new Rng(seed * 7 + 1);
while (s.faith.phase === 'prologue') step(s, 0.05);
const origin = [...s.towns].sort((a, b) => b.pop - a.pop)[0];
const t0 = s.time;
beginFaith(s, origin.id);

const seen = new Map();
let lastPrint = -1;
while (s.faith.phase === 'play' && s.time - t0 < 3600) {
  step(s, 0.05);
  s.events.length = 0;
  for (const o of s.faith.omens) {
    if (!seen.has(o.id)) seen.set(o.id, bot.chance(tapRate) ? s.time + delay * (0.5 + bot.next()) : Infinity);
    if (s.time >= seen.get(o.id)) claimOmen(s, o.id);
  }
  let pending = false;
  for (const id of plan) {
    if (!s.faith.perks[0].includes(id)) { buyPerk(s, id); pending = true; break; }
  }
  if (!pending && tapRate > 0 && s.faith.devotion[0] > prophetCost(s)) {
    const t = [...s.towns].sort((a, b) => b.pop * (1 - faithOf(b)[0]) - a.pop * (1 - faithOf(a)[0]))[0];
    sendProphet(s, t.id);
  }
  const m = Math.floor((s.time - t0) / 120);
  if (m !== lastPrint) {
    lastPrint = m;
    const [a, b] = shares(s);
    console.log(`t+${m * 2}m  towns ${s.towns.length}  yours ${(a * 100).toFixed(0)}%  rival ${(b * 100).toFixed(0)}%`
      + `  devotion ${s.faith.devotion.map(Math.round)}  rites ${s.faith.perks[0].length}/${s.faith.perks[1].length}`
      + `  omens read ${s.faith.claimed}  forgotten ${s.faith.missed}`);
  }
}
console.log(`seed ${seed}: ${s.faith.outcome || 'undecided'} after ${((s.time - t0) / 60).toFixed(1)} min`
  + ` (prologue ${(t0 / 60).toFixed(1)} min)`);
