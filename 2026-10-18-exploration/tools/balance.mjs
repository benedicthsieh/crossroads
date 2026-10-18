// balance.mjs — play the faith game headlessly, with a scripted player.
//
//   node tools/balance.mjs <seed> <policy> [minutes]
//
// The sim has no DOM in it, so a whole game runs under plain node in a few
// seconds. Policies:
//
//   idle      never reads an omen, buys rites as they become affordable
//   greedy    reads every omen it has insight for, the moment it appears
//   patient   reads only portents and up, unless insight is about to overflow
//
// There is no losing any more, so what this reports is pace: how much of the
// map keeps the Lantern after so many minutes of *wall-clock* play (the game
// runs at a locked `SIM_RATE` sim seconds per real second), and when each page
// of the chronicle was written. Patient should beat greedy, and both should
// clearly beat idle; if greedy wins, insight is too plentiful and the decision
// has gone out of the game.

import { createState, step } from '../js/sim/state.js';
import {
  beginFaith, chooseAspect, claimOmen, buyPerk, sendProphet, prophetCost, faithOf, shares,
  insightCap, perkCost, marksFor,
} from '../js/sim/faith.js';

const SIM_RATE = 2;
const seed = +(process.argv[2] || 1);
const policy = process.argv[3] || 'patient';
const minutes = +(process.argv[4] || 30);

const s = createState(seed);
while (s.faith.phase === 'prologue') { step(s, 0.05); s.events.length = 0; }
const origin = [...s.towns].sort((a, b) => b.pop - a.pop)[0];
beginFaith(s, origin.id);
chooseAspect(s, s.faith.aspectOffer[0]);
const t0 = s.time;

const seenAt = new Map();
let lastPrint = -1;
let fires = 0, floods = 0;
const real = () => (s.time - t0) / SIM_RATE / 60;
while (real() < minutes) {
  step(s, 0.05);
  for (const e of s.events) {
    if (e.type === 'fire') fires++;
    if (e.type === 'flood') floods++;
  }
  s.events.length = 0;
  const fs = s.faith;
  for (const o of [...fs.omens]) {
    if (!seenAt.has(o.id)) seenAt.set(o.id, s.time + 2 * SIM_RATE);   // two seconds to react
    if (s.time < seenAt.get(o.id) || fs.insight < 1) continue;
    const full = fs.insight >= insightCap(s) - 0.15;
    if (policy === 'greedy' || (policy === 'patient' && (o.tier >= 2 || full))) claimOmen(s, o.id);
  }
  const cheapest = [...fs.hand].sort((a, b) => perkCost(s, a) - perkCost(s, b))[0];
  if (cheapest && fs.devotion >= perkCost(s, cheapest)) buyPerk(s, cheapest);
  else if (!cheapest && policy !== 'idle' && fs.devotion > prophetCost(s) * 1.5) {
    const t = [...s.towns].sort((a, b) => b.pop * (1 - faithOf(b)[0]) - a.pop * (1 - faithOf(a)[0]))[0];
    sendProphet(s, t.id);
  }
  const m = Math.floor(real() / 5);
  if (m !== lastPrint) {
    lastPrint = m;
    const sh = shares(s);
    console.log(`${String(m * 5).padStart(3)}m  towns ${s.towns.length}  lantern ${(sh[0] * 100).toFixed(0)}%`
      + `  choir ${(sh[1] * 100).toFixed(0)}%  oldways ${(sh[2] * 100).toFixed(0)}%`
      + `  devotion ${Math.round(fs.devotion)}  rites ${fs.perks.length}  read ${fs.claimed} passed ${fs.passed}`);
  }
}
const sh = shares(s);
const pages = marksFor(s).filter((m) => s.faith.marks[m.id] != null)
  .map((m) => `${((s.faith.marks[m.id] - t0) / SIM_RATE / 60).toFixed(1)}m ${m.id}`);
console.log(`seed ${seed} ${policy} aspect ${s.faith.aspect}: lantern ${(sh[0] * 100).toFixed(0)}% after ${minutes} min;`
  + ` fires ${fires} floods ${floods}; scars ${s.nature.scars.length / 2}`);
console.log(`  chronicle: ${pages.join(', ')}`);
