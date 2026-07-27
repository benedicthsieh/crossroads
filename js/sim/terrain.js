// terrain.js — the map, and the reason travel is interesting.
//
// The whole premise of the game is that roads are *discovered*, not designed.
// That only works if the ground argues back, so the map is built to be crossed
// unevenly: grassland is cheap, forest slows you, hills slow you more, sand
// drags, and mountain ridges and rivers are near-walls with a handful of gaps
// in them. Travellers funnel through those gaps, the gaps wear into roads, and
// the roads meet at crossroads. Nothing places a road or a town — the terrain
// does, by being annoying in specific places.
//
// The map is also divided into a handful of **regions**, and that division is
// authored rather than hoped for. Four seeded sites carve the world into
// warped Voronoi territories, and the *boundaries between them* get an
// elevation lift, so the ranges and the rivers that drain them fall along the
// same lines. One region is arid and is where the spice comes from. Regions are
// what make trade worth the road: they hold different things.
//
// Terrain is a pure function of the seed. Nothing here is ever mutated by the
// sim (that's `wear`, which lives in state.js), so a snapshot never has to
// store 470,400 tiles of it: save the seed, regenerate on load.

import { hash3 } from './rng.js';

// One tile is 6 world units — roughly a third of a villager's height, small
// enough that a worn track reads as a track rather than as a tiled corridor.
//
// The map is deliberately far larger than a screenful, and was doubled on each
// axis to make room for regions that are a real journey apart. Caravans have to
// be able to travel long enough for the decision "settle here or push on" to
// mean something, and a dozen towns spread over three or four regions need room
// to sit apart without their outskirts touching. Everything downstream (gate
// spacing, town spacing, how long a road takes to wear in) is tuned against
// these numbers — see the note at the top of `caravans.js` about `LEG_UNIT`,
// which is the one place map size feeds back into a decision.
export const TILE = 6;
export const MAP = { w: 840, h: 560 };
export const WORLD = { w: MAP.w * TILE, h: MAP.h * TILE };

export const T = {
  WATER: 0,
  GRASS: 1,
  FOREST: 2,
  HILL: 3,
  MOUNTAIN: 4,
  DESERT: 5,
};

export const TERRAIN_NAMES = ['water', 'grassland', 'forest', 'hills', 'mountain', 'desert'];

/**
 * Movement cost per tile, before roads. These ratios are the map's entire
 * personality: grass is the baseline, a river is a wall you *can* wade if the
 * detour is absurd, and a mountain is worth going around unless the pass is
 * short. Fords and worn tracks are what bring the extremes back down.
 *
 * Sand sits between forest and hills. Desert is meant to be *unrewarding*
 * rather than impassable — you can cross it, you would rather skirt it, and the
 * one reason to go anyway is that it is the only ground spice grows on.
 */
export const BASE_COST = [60, 1, 2.2, 3.2, 8, 2.6];
export const FORD_COST = 5;

/** Terrain a building can stand on. Sand included: a spice town has to live somewhere. */
export function buildable(kind) {
  return kind === T.GRASS || kind === T.FOREST || kind === T.HILL || kind === T.DESERT;
}

// ------------------------------------------------------------------ regions
//
// Four territories, each roughly a quadrant of the map with a wandering border.
// The point of them is economic, not political: herbs vary with latitude, spice
// only grows in the arid one, and gem lodes are scattered so that some regions
// have none. A town therefore *cannot* supply itself with everything, and the
// long trade runs between regions are the thing this whole file exists to make
// worth walking.

export const REGION_COUNT = 4;

/** How wide the contested ground between two regions is, in tiles. */
const DIVIDE_WIDTH = 44;

const NAME_A = ['Amber', 'Ashen', 'Bitter', 'Copper', 'Ember', 'Far', 'Green', 'Grey',
  'High', 'Hollow', 'Iron', 'Long', 'Pale', 'Salt', 'Sun', 'Thorn', 'West', 'Wolf'];
const NAME_B = ['March', 'Reach', 'Weald', 'Downs', 'Vale', 'Hollows', 'Wold', 'Moor',
  'Basin', 'Shelf', 'Country', 'Waste'];

/**
 * Where each region's heart sits, in tiles.
 *
 * One site per quadrant, jittered inside the middle of it. Constraining them to
 * quadrants rather than scattering them freely is what guarantees four regions
 * of usable size — free placement regularly produces one enormous territory and
 * three slivers, and a sliver cannot hold a town, let alone the two to five
 * this map is aiming for.
 */
function regionSites(seed) {
  const sites = [];
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const jx = hash3(gx, gy, seed + 311);
      const jy = hash3(gx, gy, seed + 733);
      sites.push({
        x: (gx + 0.26 + jx * 0.48) * (MAP.w / 2),
        y: (gy + 0.26 + jy * 0.48) * (MAP.h / 2),
      });
    }
  }
  return sites;
}

/** Which of the three herb bands a latitude falls in. Thirds of the map, north to south. */
export const HERB_BANDS = ['mosswort', 'wildbay', 'sunbalm'];

export function herbAt(ty) {
  const t = Math.max(0, Math.min(0.999, ty / MAP.h));
  return HERB_BANDS[Math.floor(t * HERB_BANDS.length)];
}

/** The region a tile belongs to, 0..REGION_COUNT-1. */
export function regionAt(terrain, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h) return 0;
  return terrain.region[ty * MAP.w + tx];
}

/** The region a world point is in, with its record. */
export function regionOf(terrain, wx, wy) {
  const tx = Math.max(0, Math.min(MAP.w - 1, Math.floor(wx / TILE)));
  const ty = Math.max(0, Math.min(MAP.h - 1, Math.floor(wy / TILE)));
  return terrain.regions[regionAt(terrain, tx, ty)];
}

// ------------------------------------------------------------------- noise

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  // Smoothstep the interpolant or the noise shows its grid.
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash3(x0, y0, seed);
  const n10 = hash3(x0 + 1, y0, seed);
  const n01 = hash3(x0, y0 + 1, seed);
  const n11 = hash3(x0 + 1, y0 + 1, seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

function fbm(x, y, seed, octaves = 5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, y * f, seed + i * 101) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged noise: the |n| fold is what turns blobs into chains. */
function ridged(x, y, seed, octaves = 4) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x * f, y * f, seed + i * 71) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// --------------------------------------------------------------- generation

/** Threshold that puts exactly `fraction` of the values above it. */
function percentile(values, fraction) {
  const bins = new Int32Array(512);
  for (let i = 0; i < values.length; i++) {
    bins[Math.max(0, Math.min(511, (values[i] * 511) | 0))]++;
  }
  const want = values.length * (1 - fraction);
  let acc = 0;
  for (let b = 0; b < 512; b++) {
    acc += bins[b];
    if (acc >= want) return b / 511;
  }
  return 1;
}

/**
 * Drown the deepest inland basins.
 *
 * Rivers alone cut the map into strips; a lake or an inland sea cuts it into
 * *pieces*, which is what a region boundary wants sitting in the middle of it.
 * Run before the rivers so that a river bed — which carves its own elevation
 * down as it goes — cannot be mistaken for a basin and flooded along its whole
 * length.
 *
 * The margin matters more than it looks: the lowest ground on the map is around
 * the rim (the edge easing pushes it down so travellers can actually get in),
 * so without it the whole border floods and `findGates` has nowhere to put a
 * gate.
 */
const LAKE_FRACTION = 0.06;
const LAKE_MARGIN = 36;

function fillLakes(elev, water, flow) {
  const { w, h } = MAP;
  const inland = new Float32Array((w - LAKE_MARGIN * 2) * (h - LAKE_MARGIN * 2));
  let n = 0;
  for (let y = LAKE_MARGIN; y < h - LAKE_MARGIN; y++) {
    for (let x = LAKE_MARGIN; x < w - LAKE_MARGIN; x++) inland[n++] = elev[y * w + x];
  }
  // `percentile` counts from the top, so the lowest `LAKE_FRACTION` is what
  // sits *below* the (1 - fraction) threshold.
  const at = percentile(inland, 1 - LAKE_FRACTION);
  for (let y = LAKE_MARGIN; y < h - LAKE_MARGIN; y++) {
    for (let x = LAKE_MARGIN; x < w - LAKE_MARGIN; x++) {
      const i = y * w + x;
      if (elev[i] > at) continue;
      water[i] = 1;
      flow[i] = 1;                     // a lake is all mouth, as far as the painter cares
    }
  }
}

/**
 * Carve rivers by walking downhill from high ground.
 *
 * Rivers matter more than they look: a river that reaches the map edge cuts the
 * world in two, and the only cheap way across is a ford. Fords are therefore
 * placed deliberately and sparsely rather than left to chance — they are the
 * bottlenecks the road network ends up hanging off.
 *
 * Because the region divides are the highest ground on the map, sources land on
 * them by themselves and the drainage runs *away* from a boundary on both
 * sides. That is free and it is exactly right: a range and the rivers off its
 * flanks are the same barrier seen twice.
 */
const RIVERS = 22;
const RIVER_GAP = 58;
const FORD_SPACING = 34;

function carveRivers(elev, water, ford, flow, seed) {
  const { w, h } = MAP;
  const idx = (x, y) => y * w + x;
  const sources = [];

  // Pick sources on high ground, spread out, scanning a coarse grid so the
  // result doesn't depend on iteration order of anything else.
  for (let ty = 4; ty < h - 4; ty += 7) {
    for (let tx = 4; tx < w - 4; tx += 7) {
      const e = elev[idx(tx, ty)];
      if (e < 0.62) continue;
      sources.push({ x: tx, y: ty, e: e + hash3(tx, ty, seed + 7) * 0.05 });
    }
  }
  sources.sort((a, b) => b.e - a.e);

  // River count scales with the map: the point of a river is to cut the world
  // into pieces that traffic has to funnel between, and a handful of them
  // spread over an 840x560 map leaves whole quadrants with nothing to argue
  // with.
  const chosen = [];
  for (const s of sources) {
    if (chosen.length >= RIVERS) break;
    if (chosen.some((c) => Math.hypot(c.x - s.x, c.y - s.y) < RIVER_GAP)) continue;
    chosen.push(s);
  }

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const seen = new Uint8Array(w * h);

  for (let ri = 0; ri < chosen.length; ri++) {
    let { x, y } = chosen[ri];
    // Every river gets an outlet: the nearest map edge to its source. A pure
    // steepest-descent river dies in the first basin it finds, which leaves a
    // chain of ponds rather than a barrier. Biasing the descent toward the
    // outlet keeps terrain in charge of the *route* while guaranteeing the
    // river actually reaches the edge and cuts the map in two.
    const outlet = (() => {
      const d = [x, w - 1 - x, y, h - 1 - y];
      const min = Math.min(...d);
      if (min === d[0]) return (px) => px;
      if (min === d[1]) return (px) => w - 1 - px;
      if (min === d[2]) return (px, py) => py;
      return (px, py) => h - 1 - py;
    })();
    const path = [];
    // Visited tiles are excluded from the descent. Without that, the meander
    // jitter can make a river prefer the tile it just came from, and it spends
    // its whole step budget oscillating between two squares — which looks, from
    // the outside, exactly like "the generator doesn't make rivers".
    seen.fill(0);
    let steps = 0;
    while (steps++ < 8000) {
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) break;
      const here = idx(x, y);
      path.push(here);
      seen[here] = 1;
      if (water[here] && path.length > 4) break;              // joined a river or a lake

      // Steepest descent, with a hash nudge so rivers meander instead of
      // running in eight straight compass directions.
      let bx = -1, by = -1, best = Infinity;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) { bx = nx; by = ny; best = -Infinity; break; }
        if (seen[idx(nx, ny)]) continue;
        const cost = elev[idx(nx, ny)]
          + (hash3(nx, ny, seed + ri * 31) - 0.5) * 0.03
          + outlet(nx, ny) * 0.0011;
        if (cost < best) { best = cost; bx = nx; by = ny; }
      }
      if (bx < 0) break;                                      // boxed in by its own bed
      // Rivers cut down as they go, so the bed never runs uphill. This also
      // leaves a real valley in the elevation field, which the hillshade and
      // the terrain classifier both pick up for free.
      if (bx >= 0 && by >= 0 && bx < w && by < h && elev[idx(bx, by)] >= elev[here]) {
        elev[idx(bx, by)] = elev[here] - 0.001;
      }
      x = bx; y = by;
    }

    // Downstream tiles carry more water, so the channel widens toward the mouth.
    for (let i = 0; i < path.length; i++) {
      const t = i / Math.max(1, path.length - 1);
      const radius = t < 0.18 ? 0 : (t < 0.5 ? 1 : (t < 0.8 ? 1.6 : 2.2));
      const px = path[i] % w, py = (path[i] / w) | 0;
      const r = Math.ceil(radius);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.hypot(dx, dy) > radius + 0.4) continue;
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          water[idx(nx, ny)] = 1;
          flow[idx(nx, ny)] = Math.max(flow[idx(nx, ny)], t);
        }
      }
    }

    // Fords roughly every `FORD_SPACING` tiles of river. Deliberate and spaced:
    // the point is to force travellers into a small number of crossings, not to
    // make the river porous everywhere.
    for (let i = 8; i < path.length - 6; i++) {
      if (i % FORD_SPACING !== 0) continue;
      const px = path[i] % w, py = (path[i] / w) | 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (water[idx(nx, ny)]) ford[idx(nx, ny)] = 1;
        }
      }
    }
  }
}

// -------------------------------------------------------------- gem lodes
//
// Gems are the one resource that is *placed* rather than derived from what kind
// of ground a tile is, and that is the whole point of them: wood is wherever
// there are trees and stone is wherever there is rock, so any town with the
// right country around it can have both. A lode is somewhere specific. Most
// towns will never have one, and the ones that do have something nobody else
// can produce at any price.

/**
 * How many lodes, how far apart, and how far a town will go to work one.
 *
 * The reach matches the town's own working radius in `economy.js`, because that
 * is what it means: a lode is a place in the hills the town's own quarrymen can
 * get to and back from. Sixteen of them at that reach covers something under a
 * tenth of the map, so most settlements will never see a gem — which is the
 * entire point of gems, and why a town that *does* have one is worth a very long
 * journey.
 */
const LODES = 28;
const LODE_GAP = 66;
export const LODE_REACH = 30;

/** Is this bit of rock at the edge of country somebody could live in? */
function nearOpenGround(kind, tx, ty) {
  const { w, h } = MAP;
  let open = 0, seen = 0;
  for (let dy = -7; dy <= 7; dy += 2) {
    for (let dx = -7; dx <= 7; dx += 2) {
      const x = tx + dx, y = ty + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      seen++;
      const k = kind[y * w + x];
      if (k === T.GRASS || k === T.FOREST || k === T.DESERT) open++;
    }
  }
  return seen > 0 && open / seen >= 0.22;
}

function placeLodes(kind, elev, seed) {
  const { w, h } = MAP;
  const candidates = [];
  // Coarse scan: a lode is a place on the map, and sampling every tile would
  // just spend time finding the same peaks.
  for (let ty = 20; ty < h - 20; ty += 5) {
    for (let tx = 20; tx < w - 20; tx += 5) {
      const i = ty * w + tx;
      const k = kind[i];
      if (k !== T.MOUNTAIN && k !== T.HILL) continue;
      // Deliberately *not* weighted toward the high peaks, and required to be
      // within sight of ground somebody could actually live on. Gems only pay
      // if somebody can carry them out, and a town does not settle on a summit
      // — it settles on a crossroads with hills behind it. An earlier version
      // pushed every lode onto true mountain and, across a dozen seeds, not one
      // town on any map ever ended up within reach of a single one.
      if (!nearOpenGround(kind, tx, ty)) continue;
      candidates.push({ tx, ty, score: hash3(tx, ty, seed + 8123) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const out = [];
  for (const c of candidates) {
    if (out.length >= LODES) break;
    if (out.some((q) => Math.hypot(q.tx - c.tx, q.ty - c.ty) < LODE_GAP)) continue;
    out.push({ tx: c.tx, ty: c.ty, x: (c.tx + 0.5) * TILE, y: (c.ty + 0.5) * TILE });
  }
  return out;
}

/** Gem lodes within `reach` tiles of a tile. Used by the survey and by `siteOk`. */
export function lodesNear(terrain, tx, ty, reach = LODE_REACH) {
  let n = 0;
  for (const lode of terrain.lodes) {
    if (Math.hypot(lode.tx - tx, lode.ty - ty) <= reach) n++;
  }
  return n;
}

/**
 * Build the whole map from a seed.
 * Returns plain typed arrays — no classes, nothing the renderer can hook into.
 */
export function generateTerrain(seed) {
  const { w, h } = MAP;
  const n = w * h;
  const elev = new Float32Array(n);
  const moist = new Float32Array(n);
  const arid = new Float32Array(n);
  const kind = new Uint8Array(n);
  const region = new Uint8Array(n);
  const water = new Uint8Array(n);
  const ford = new Uint8Array(n);
  const flow = new Float32Array(n);

  const s = seed >>> 0;
  const sites = regionSites(s);
  // One region is a desert. Which one is seeded, so a given map always has its
  // waste in the same place, and every other region has to buy spice from it.
  const aridRegion = Math.floor(hash3(7, 11, s + 5501) * REGION_COUNT) % REGION_COUNT;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;

      // Which region, and how close to the seam between two of them. The
      // lookup runs on *warped* coordinates so the borders wander like
      // watersheds instead of meeting at the straight lines a plain Voronoi
      // diagram would give.
      const wx = x + (fbm(x / 90, y / 90, s + 1501, 3) - 0.5) * 150;
      const wy = y + (fbm(x / 90 + 40, y / 90 + 40, s + 2609, 3) - 0.5) * 150;
      let d1 = Infinity, d2 = Infinity, which = 0;
      for (let k = 0; k < sites.length; k++) {
        const d = Math.hypot(sites[k].x - wx, sites[k].y - wy);
        if (d < d1) { d2 = d1; d1 = d; which = k; }
        else if (d < d2) { d2 = d; }
      }
      region[i] = which;
      const divide = Math.max(0, 1 - (d2 - d1) / DIVIDE_WIDTH);

      const base = fbm(x / 46, y / 46, s, 5);
      const chains = ridged(x / 78, y / 78, s + 977, 4);
      // Ridges are added, not blended, so the chains sit on top of the rolling
      // ground rather than replacing it — foothills come free that way.
      //
      // The third term is the region divide, and it is what makes the map read
      // as *countries* rather than as one continuous field of noise: the seam
      // between two territories rises into a range. The pass noise is the half
      // that keeps it crossable — it dips the lift in places, and those dips
      // become the handful of gaps every road between two regions has to use.
      const pass = fbm(x / 19, y / 19, s + 3301, 3);
      const lift = divide * divide * 0.52 * (0.34 + 0.66 * pass);
      let e = base * 0.62 + chains * 0.62 + lift;
      // Ease the very edge of the map down a little so the border isn't a wall
      // of cliffs and travellers can actually enter.
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y) / 14;
      if (edge < 1) e *= 0.72 + 0.28 * edge;
      elev[i] = Math.max(0, Math.min(1, e));

      const m = fbm(x / 34 + 100, y / 34 + 100, s + 4231, 4);
      moist[i] = m;
      // Dryness is mostly *where you are*: the arid region bakes, and it bakes
      // hardest in its own interior rather than up against the ranges, where
      // the rain that the range wrings out has to go somewhere. Elsewhere only
      // genuinely dry ground qualifies, which leaves the odd patch of badland
      // outside the waste and no more than that.
      const core = which === aridRegion ? 1 - divide : 0;
      arid[i] = (1 - m) * 0.52 + core * 0.48;
    }
  }

  fillLakes(elev, water, flow);
  carveRivers(elev, water, ford, flow, s);

  // Thresholds by percentile rather than by absolute height: every seed then
  // lands the same *proportions* of terrain, so "mostly passable" is a property
  // of the generator instead of something to get lucky with.
  const mountainAt = percentile(elev, 0.14);
  const hillAt = percentile(elev, 0.28);
  const forestAt = percentile(moist, 0.27);

  // Desert is thresholded against the *flat* land only. Taken over the whole
  // map, a percentile of aridity would spend most of its budget on mountainside
  // that was never going to be sand, and the waste would come out half the size
  // asked for.
  const flat = new Float32Array(n);
  let flatN = 0;
  for (let i = 0; i < n; i++) {
    if (!water[i] && elev[i] < hillAt) flat[flatN++] = arid[i];
  }
  const desertAt = percentile(flat.subarray(0, flatN), 0.16);

  for (let i = 0; i < n; i++) {
    if (water[i]) { kind[i] = T.WATER; continue; }
    if (elev[i] >= mountainAt) kind[i] = T.MOUNTAIN;
    else if (elev[i] >= hillAt) kind[i] = T.HILL;
    else if (arid[i] >= desertAt) kind[i] = T.DESERT;
    else if (moist[i] >= forestAt) kind[i] = T.FOREST;
    else kind[i] = T.GRASS;
  }

  const lodes = placeLodes(kind, elev, s);

  // Which herb each region mostly grows. Taken over the region's actual tiles
  // rather than off its centre: a territory that straddles a band boundary
  // should be named for the half of it a caravan is likely to be standing in.
  const bandTally = sites.map(() => new Array(HERB_BANDS.length).fill(0));
  for (let y = 0; y < h; y++) {
    const band = Math.floor(Math.min(0.999, y / h) * HERB_BANDS.length);
    for (let x = 0; x < w; x++) bandTally[region[y * w + x]][band]++;
  }

  // A name and a heart for each region, for the panel and for the caravan card.
  // Deterministic, and distinct within a map — the whole point of naming them
  // is that a player can say "the spice comes from the Salt Waste".
  const used = [];
  const regions = sites.map((site, i) => {
    let name = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = NAME_A[Math.floor(hash3(i, attempt, s + 61) * NAME_A.length) % NAME_A.length];
      const b = NAME_B[Math.floor(hash3(i, attempt, s + 97) * NAME_B.length) % NAME_B.length];
      name = `${a} ${b}`;
      if (!used.includes(name)) break;
    }
    used.push(name);
    const tally = bandTally[i];
    let band = 0;
    for (let k = 1; k < tally.length; k++) if (tally[k] > tally[band]) band = k;
    return {
      id: i,
      name,
      arid: i === aridRegion,
      x: site.x * TILE,
      y: site.y * TILE,
      herb: HERB_BANDS[band],
    };
  });

  return { w, h, kind, elev, moist, region, regions, ford, flow, lodes, seed: s };
}

// ------------------------------------------------------------------ queries

export function tileIndex(tx, ty) {
  return ty * MAP.w + tx;
}

export function tileAt(wx, wy) {
  return [
    Math.max(0, Math.min(MAP.w - 1, Math.floor(wx / TILE))),
    Math.max(0, Math.min(MAP.h - 1, Math.floor(wy / TILE))),
  ];
}

export function tileCentre(tx, ty) {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

/** Terrain cost of a tile, ignoring roads. */
export function terrainCost(terrain, i) {
  const k = terrain.kind[i];
  if (k === T.WATER) return terrain.ford[i] ? FORD_COST : BASE_COST[T.WATER];
  return BASE_COST[k];
}
