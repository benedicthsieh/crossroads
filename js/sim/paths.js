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
//
// None of this is optimal, on purpose. A long search is guided by a coarse map
// of the world (see `coarseGuide`) that knows where the ranges and lakes are,
// and it trusts that map a little more than it should. Routes come out a tenth
// or so dearer than the cheapest possible one, which is inside the ±12% every
// traveller's jitter already adds, and the search does a fifth of the work.

import { MAP, terrainCost } from './terrain.js';
import { moveCost, roadFrac, ROAD_COST } from './roads.js';
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
 * When to give up. With the coarse guide a border-to-border search settles in
 * ten to thirty thousand expansions, so this is a backstop rather than a
 * budget. It used to be 320,000, and on the early map close to half of all
 * long searches hit it: plain octile distance has no idea a range is in the
 * way, so the search filled the whole valley in front of it before giving up —
 * the single most expensive thing the sim did, and the reason the prologue
 * took half a minute on some seeds.
 */
const MAX_EXPANSIONS = 150000;

// ------------------------------------------------------------ coarse guide
//
// The map, shrunk by eight on each axis. Each block is priced at what its
// cheaper quarter of ground costs — the price of crossing it if you pick your
// way, which is what a traveller does — or at road prices if a road runs
// through it. A Dijkstra from the goal's block over those 7,000-odd blocks then
// says, roughly, how far the goal *really* is from anywhere: around the lake,
// over the pass, along the trunk road. That is a far better guess than a
// straight line, and A* with a good guess goes nearly straight to the answer.
//
// The guide is inflated by `GUIDE_TRUST`, which is the corner being cut. An
// honest (admissible) guide still spends most of its time proving there is no
// cheaper route; an overconfident one commits to the first decent route it
// finds. Measured on the slow seeds: an honest guide halves the work, 1.25 cuts
// it by five to ten times, and routes come out about 10% dearer than optimal.
//
// The terrain half of a block's price never changes and is computed once per
// map. The road half is one pass over the wear field every `GUIDE_REFRESH`
// seconds of sim time, done lazily by the first search after it goes stale.
// Both live in WeakMaps off to the side rather than on the state: they are
// derived, they are not saved, and a restored game rebuilds them on its first
// search — which two clients restoring the same snapshot do at the same sim
// time, so lockstep holds.

const BLOCK = 8;
const BW = Math.ceil(MAP.w / BLOCK);
const BH = Math.ceil(MAP.h / BLOCK);
const BN = BW * BH;
const GUIDE_TRUST = 1.25;
const GUIDE_REFRESH = 10;
/** Searches shorter than this (in tiles) don't bother with the guide. */
const GUIDE_MIN_SPAN = 40;
/** How many goals' distance fields to remember between refreshes. */
const GUIDE_GOALS = 48;

const groundPrices = new WeakMap();
const guides = new WeakMap();

/** Per block: the cost of its cheaper quarter of tiles, roads aside. */
function groundPrice(terrain) {
  let out = groundPrices.get(terrain);
  if (out) return out;
  out = new Float32Array(BN);
  const tiles = new Float32Array(BLOCK * BLOCK);
  for (let by = 0; by < BH; by++) {
    for (let bx = 0; bx < BW; bx++) {
      let n = 0;
      const y1 = Math.min(MAP.h, by * BLOCK + BLOCK), x1 = Math.min(MAP.w, bx * BLOCK + BLOCK);
      for (let y = by * BLOCK; y < y1; y++) {
        for (let x = bx * BLOCK; x < x1; x++) tiles[n++] = terrainCost(terrain, y * MAP.w + x);
      }
      out[by * BW + bx] = tiles.subarray(0, n).sort()[n >> 2];
    }
  }
  groundPrices.set(terrain, out);
  return out;
}

/** Ground price, blended toward road price by the best road in the block. */
function blockCosts(state) {
  const ground = groundPrice(state.terrain);
  const best = new Float32Array(BN);
  const { wear } = state;
  for (let y = 0; y < MAP.h; y++) {
    const row = ((y / BLOCK) | 0) * BW;
    for (let x = 0; x < MAP.w; x++) {
      const w = wear[y * MAP.w + x];
      const b = row + ((x / BLOCK) | 0);
      if (w > best[b]) best[b] = w;
    }
  }
  for (let b = 0; b < BN; b++) {
    const f = roadFrac(best[b]);
    best[b] = ground[b] * (1 - f) + ROAD_COST * f;
  }
  return best;
}

// A second, small heap for the block Dijkstra, so it can't disturb the tile one.
const bHeapNode = new Int32Array(BN * 8 + 1);
const bHeapKey = new Float64Array(BN * 8 + 1);

function blockDistances(cost, goalBlock) {
  const dist = new Float32Array(BN).fill(Infinity);
  const done = new Uint8Array(BN);
  let size = 0;
  const push = (node, key) => {
    let i = ++size;
    bHeapNode[i] = node; bHeapKey[i] = key;
    while (i > 1) {
      const p = i >> 1;
      if (bHeapKey[p] <= bHeapKey[i]) break;
      const tn = bHeapNode[p], tk = bHeapKey[p];
      bHeapNode[p] = bHeapNode[i]; bHeapKey[p] = bHeapKey[i];
      bHeapNode[i] = tn; bHeapKey[i] = tk;
      i = p;
    }
  };
  dist[goalBlock] = 0;
  push(goalBlock, 0);
  while (size > 0) {
    const cur = bHeapNode[1], key = bHeapKey[1];
    bHeapNode[1] = bHeapNode[size]; bHeapKey[1] = bHeapKey[size]; size--;
    for (let i = 1; ;) {
      const l = i << 1, r = l + 1;
      let m = i;
      if (l <= size && bHeapKey[l] < bHeapKey[m]) m = l;
      if (r <= size && bHeapKey[r] < bHeapKey[m]) m = r;
      if (m === i) break;
      const tn = bHeapNode[m], tk = bHeapKey[m];
      bHeapNode[m] = bHeapNode[i]; bHeapKey[m] = bHeapKey[i];
      bHeapNode[i] = tn; bHeapKey[i] = tk;
      i = m;
    }
    if (done[cur]) continue;
    done[cur] = 1;
    const cx = cur % BW, cy = (cur / BW) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= BW || ny >= BH) continue;
      const ni = ny * BW + nx;
      if (done[ni]) continue;
      const t = key + BLOCK * STEP[d] * (cost[cur] + cost[ni]) * 0.5;
      if (t < dist[ni]) { dist[ni] = t; push(ni, t); }
    }
  }
  return dist;
}

/** The coarse distance field toward one goal tile, built or fetched. */
function coarseGuide(state, gx, gy) {
  let g = guides.get(state);
  if (!g || state.time - g.built >= GUIDE_REFRESH || state.time < g.built) {
    g = { built: state.time, cost: blockCosts(state), goals: new Map() };
    guides.set(state, g);
  }
  const goalBlock = ((gy / BLOCK) | 0) * BW + ((gx / BLOCK) | 0);
  let dist = g.goals.get(goalBlock);
  if (!dist) {
    if (g.goals.size >= GUIDE_GOALS) g.goals.delete(g.goals.keys().next().value);
    dist = blockDistances(g.cost, goalBlock);
    g.goals.set(goalBlock, dist);
  }
  return dist;
}

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

  const octile = (x, y) => {
    const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
    // Octile distance at the assumed per-tile cost. See `MIN_COST`: the small
    // overshoot on road tiles buys a large speed-up and, if anything, makes
    // routes look more decisive.
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * MIN_COST;
  };
  // A resident crossing town, or a caravan nosing up to a gate, is a short
  // search that a straight line guesses well; the guide would cost more to
  // fetch than it saves.
  const sx = startIdx % MAP.w, sy = (startIdx / MAP.w) | 0;
  const guide = Math.max(Math.abs(sx - gx), Math.abs(sy - gy)) > GUIDE_MIN_SPAN
    ? coarseGuide(state, gx, gy) : null;
  const h = guide
    ? (x, y) => Math.max(octile(x, y), GUIDE_TRUST * guide[((y / BLOCK) | 0) * BW + ((x / BLOCK) | 0)])
    : octile;

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
