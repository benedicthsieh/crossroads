// paths.js — A* over the tile grid.
//
// Two details here are doing narrative work rather than algorithmic work:
//
//   1. The cost field includes road wear, so a traveller who "just takes the
//      cheapest route" is automatically following the roads other travellers
//      wore in. Nobody is told to prefer roads.
//   2. Each traveller perturbs the cost field slightly with their own seed.
//      Without that, identical journeys produce byte-identical paths and roads
//      come out one tile wide and unnaturally straight — a hairline, not a
//      road. The jitter lets the first crossings fan out and the traffic
//      consolidate them afterwards.
//
// Scratch buffers are allocated once and reused. Clearing 38k entries per
// search would dwarf the search itself, so visited state is versioned with a
// generation counter instead.

import { MAP } from './terrain.js';
import { moveCost } from './roads.js';
import { hash3 } from './rng.js';

const N = MAP.w * MAP.h;
const gScore = new Float64Array(N);
const cameFrom = new Int32Array(N);
const stamp = new Int32Array(N);
const closed = new Uint8Array(N);
let generation = 0;

// Binary heap, kept as two parallel arrays so pushing doesn't allocate.
const heapNode = new Int32Array(N + 1);
const heapKey = new Float64Array(N + 1);
let heapSize = 0;

function heapPush(node, key) {
  let i = ++heapSize;
  heapNode[i] = node;
  heapKey[i] = key;
  while (i > 1) {
    const p = i >> 1;
    if (heapKey[p] <= heapKey[i]) break;
    const tn = heapNode[p], tk = heapKey[p];
    heapNode[p] = heapNode[i]; heapKey[p] = heapKey[i];
    heapNode[i] = tn; heapKey[i] = tk;
    i = p;
  }
}

function heapPop() {
  const top = heapNode[1];
  heapNode[1] = heapNode[heapSize];
  heapKey[1] = heapKey[heapSize];
  heapSize--;
  let i = 1;
  for (;;) {
    const l = i << 1, r = l + 1;
    let m = i;
    if (l <= heapSize && heapKey[l] < heapKey[m]) m = l;
    if (r <= heapSize && heapKey[r] < heapKey[m]) m = r;
    if (m === i) break;
    const tn = heapNode[m], tk = heapKey[m];
    heapNode[m] = heapNode[i]; heapKey[m] = heapKey[i];
    heapNode[i] = tn; heapKey[i] = tk;
    i = m;
  }
  return top;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const STEP = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/**
 * What the heuristic assumes a tile costs.
 *
 * The textbook value here is the cheapest a tile can *possibly* be — a fully
 * worn road, 0.6 — which keeps A* admissible and therefore optimal. That was
 * affordable on a map of 117,000 tiles and is not affordable on one of 470,000:
 * an estimate two and a half times below what the ground actually charges makes
 * the search fan out into a disc, and a border-to-border journey explored three
 * hundred thousand tiles and then gave up.
 *
 * So the estimate is raised to just under the cost of open grass. It is still
 * admissible everywhere except on made road, which is a small fraction of the
 * map, and measuring it on a fresh world the routes come out within 0.2% of the
 * optimal ones while the search does *half* the work. The number that matters:
 * the longest path on the doubled map now costs about what the longest path on
 * the old map used to.
 */
const MIN_COST = 0.95;

/**
 * When to give up. Raised with the map: a border-to-border journey is now over
 * a thousand tiles of octile distance, and at the old ceiling a caravan trying
 * to cross the world would have run out of budget somewhere in the middle and
 * beelined the rest — through a mountain range, in a straight line, laying wear
 * where no road should ever be.
 */
const MAX_EXPANSIONS = 320000;

/**
 * Cheapest route from one tile to another.
 * @returns {number[]|null} tile indices from start to goal, or null if the
 *   search gave up (the caller is expected to fall back to walking straight).
 */
export function findPath(state, startIdx, goalIdx, seed = 0) {
  if (startIdx === goalIdx) return [startIdx];
  const { terrain, wear } = state;
  const gx = goalIdx % MAP.w, gy = (goalIdx / MAP.w) | 0;

  const gen = ++generation;
  heapSize = 0;
  stamp[startIdx] = gen;
  gScore[startIdx] = 0;
  cameFrom[startIdx] = -1;
  closed[startIdx] = 0;

  const h = (x, y) => {
    const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
    // Octile distance at the assumed per-tile cost. See `MIN_COST`: the small
    // overshoot on road tiles buys a large speed-up and, if anything, makes
    // routes look more decisive.
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * MIN_COST;
  };

  heapPush(startIdx, h(startIdx % MAP.w, (startIdx / MAP.w) | 0));
  let expansions = 0;

  while (heapSize > 0) {
    const cur = heapPop();
    if (closed[cur] === 1 && stamp[cur] === gen) continue;
    closed[cur] = 1;
    if (cur === goalIdx) break;
    if (++expansions > MAX_EXPANSIONS) return null;

    const cx = cur % MAP.w, cy = (cur / MAP.w) | 0;
    const gCur = gScore[cur];

    for (let d = 0; d < 8; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= MAP.w || ny >= MAP.h) continue;
      const ni = ny * MAP.w + nx;
      if (stamp[ni] === gen && closed[ni] === 1) continue;

      // Per-traveller jitter: ±12%, stable for a given tile and traveller.
      const jitter = seed ? 0.88 + hash3(nx, ny, seed) * 0.24 : 1;
      const step = moveCost(terrain, wear, ni) * STEP[d] * jitter;
      const tentative = gCur + step;

      if (stamp[ni] !== gen) {
        stamp[ni] = gen;
        closed[ni] = 0;
        gScore[ni] = tentative;
        cameFrom[ni] = cur;
        heapPush(ni, tentative + h(nx, ny));
      } else if (tentative < gScore[ni]) {
        gScore[ni] = tentative;
        cameFrom[ni] = cur;
        heapPush(ni, tentative + h(nx, ny));
      }
    }
  }

  if (stamp[goalIdx] !== gen || closed[goalIdx] !== 1) return null;

  const out = [];
  let n = goalIdx;
  while (n !== -1) {
    out.push(n);
    n = cameFrom[n];
  }
  out.reverse();
  return out;
}
