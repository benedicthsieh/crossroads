// roadPaint.js — the road layer, repainted where it changed and nowhere else.
//
// Roads are the one part of the map that moves, and they move constantly: every
// traveller is adjusting the wear field under their feet. Rebaking the terrain
// for that would cost tens of milliseconds a frame, so roads live on their own
// transparent canvas over the top, and only the tiles whose wear has actually
// shifted since they were last drawn get redrawn.
//
// Wear is sampled *bilinearly* rather than per tile, which is the difference
// between a road and a staircase of six-pixel squares. That's also why touching
// one tile marks its neighbours dirty — their edge pixels read from it.

import { MAP, TILE, WORLD, T } from '../sim/terrain.js';
import { roadFrac, ROAD_MIN, clearTouchLog } from '../sim/roads.js';
import { hash3 } from '../sim/rng.js';
import { pal } from '../palette.js';

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/**
 * How much a tile's wear must move before the decay sweep repaints it.
 *
 * This is only about *fading* now — anything a traveller scuffs comes through
 * the sim's touch log and is repainted whatever the size of the change. Decay
 * is uniform and glacial, so the threshold can be coarse: 0.06 is a thirtieth
 * of the way up the ramp from bare ground to finished road, well under one step
 * of the dither, and holding it there roughly thirds the repaint churn a mature
 * road network generates for no reason anyone can see.
 */
const EPS = 0.06;
/** Tiles repainted per frame. Enough to keep up; small enough not to hitch. */
const BUDGET = 900;

/**
 * Frames it takes the background sweep to walk the whole wear field once.
 *
 * The sweep exists only to notice *decay*, which the sim's touch log
 * deliberately doesn't record — decay moves every tile at once, so logging it
 * would just be the full-map scan this is here to avoid. A road loses about
 * 0.0014 of wear a second, so it takes a quarter of a minute to drift past EPS
 * at all; noticing that half a second late is invisible, and it costs a
 * thirty-second of a scan per frame instead of a whole one.
 */
const SWEEP_FRAMES = 32;

/**
 * Upload granularity. Dirty tiles are scattered — twenty caravans are twenty
 * separate smudges — so the bounding box around them is most of the map, and
 * uploading that box was costing more than painting the tiles inside it. Tiles
 * are grouped into short runs along a tile row instead, and each run goes up on
 * its own. `RUN_GAP` is how many clean tiles it's worth carrying inside a run
 * rather than paying for a second upload; past `MAX_RUNS` the scatter is bad
 * enough that the call overhead starts to matter and rows are sent whole.
 *
 * `MAX_RUNS` is high because the call turns out to be cheap: measured on a
 * throttled phone profile, 400 uploads of a 30x6 run cost 1.6ms between them,
 * while the single 2520x460 rectangle they replace costs 2.8ms on its own. The
 * fallback is a safety valve for a repaint backlog, not a routine path.
 *
 * Note what the fallback is *not*: a single box round everything. That was the
 * original behaviour and it is the worst of both worlds — dirt in two opposite
 * corners of the map uploaded four million pixels to repaint a few hundred. A
 * whole row is 2,520 pixels by six; even every row at once is a fraction of it.
 */
const RUN_GAP = 12;
const MAX_RUNS = 384;

export function createRoadLayer() {
  const canvas = document.createElement('canvas');
  canvas.width = WORLD.w;
  canvas.height = WORLD.h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(WORLD.w, WORLD.h);
  return {
    canvas,
    ctx,
    img,
    data: img.data,
    painted: new Float32Array(MAP.w * MAP.h).fill(-1),
    queue: [],
    queued: new Uint8Array(MAP.w * MAP.h),
    colors: null,
    // Where the slow decay sweep has got to, as a tile row.
    sweepRow: 0,
    // Tiles painted this frame, reused so the per-frame flush doesn't allocate.
    done: new Int32Array(BUDGET),
  };
}

const mixRgb = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function colorsFor() {
  const p = pal();
  const dirt = p.dirt.map(rgb);
  const deep = rgb(p.dirtDeep);
  const grassDeep = rgb(p.grassDeep);
  return {
    // A faint track is flattened grass with soil showing through, not fresh
    // earth. Painting early wear in full dirt colour made new routes look like
    // a rash of orange dots across the meadow.
    track: dirt.map((c) => mixRgb(c, grassDeep, 0.52)),
    dirt,
    dirtDeep: deep,
    plaza: p.plaza.map(rgb),
    wood: rgb(p.wood),
    woodDark: rgb(p.woodDark),
    woodLight: rgb(p.woodLight),
  };
}

// Ordered dither. A pure hash threshold gives TV static; a Bayer matrix with a
// little hash mixed in gives the even, deliberate stipple pixel art uses to
// fake a gradient.
const BAYER = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

/** Wear at a world pixel, interpolated across the four nearest tiles. */
function sampleWear(wear, px, py) {
  const u = px / TILE - 0.5;
  const v = py / TILE - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  const cx0 = Math.max(0, Math.min(MAP.w - 1, x0));
  const cx1 = Math.max(0, Math.min(MAP.w - 1, x0 + 1));
  const cy0 = Math.max(0, Math.min(MAP.h - 1, y0));
  const cy1 = Math.max(0, Math.min(MAP.h - 1, y0 + 1));
  const a = wear[cy0 * MAP.w + cx0], b = wear[cy0 * MAP.w + cx1];
  const c = wear[cy1 * MAP.w + cx0], d = wear[cy1 * MAP.w + cx1];
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}

/**
 * The wear a bilinear sample anywhere inside this tile could possibly return.
 *
 * Every pixel in the tile interpolates between it and its eight neighbours, so
 * the largest of the nine bounds the lot. Most tiles marked dirty are the
 * *verge* of a track rather than the track itself — a deposit marks four
 * neighbours it may barely have touched — and for those the whole tile is
 * transparent, which is worth knowing before doing thirty-six bilinear samples
 * to find out one pixel at a time.
 */
function peakWear(wear, tx, ty) {
  let m = 0;
  const y0 = Math.max(0, ty - 1), y1 = Math.min(MAP.h - 1, ty + 1);
  const x0 = Math.max(0, tx - 1), x1 = Math.min(MAP.w - 1, tx + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const w = wear[y * MAP.w + x];
      if (w > m) m = w;
    }
  }
  return m;
}

function paintTile(layer, state, tx, ty) {
  const { data, colors } = layer;
  const { wear, terrain } = state;
  const x0 = tx * TILE, y0 = ty * TILE;
  const kind = terrain.kind[ty * MAP.w + tx];
  const isWater = kind === T.WATER;

  // Nothing here can clear the faintest-scuff threshold: blank it and go.
  if (roadFrac(peakWear(wear, tx, ty)) <= 0.04) {
    for (let py = y0; py < y0 + TILE; py++) {
      let o = (py * WORLD.w + x0) * 4 + 3;
      for (let px = 0; px < TILE; px++, o += 4) data[o] = 0;
    }
    return;
  }

  for (let py = y0; py < y0 + TILE; py++) {
    for (let px = x0; px < x0 + TILE; px++) {
      const o = (py * WORLD.w + px) * 4;
      const f = roadFrac(sampleWear(wear, px + 0.5, py + 0.5));
      if (f <= 0.04) { data[o + 3] = 0; continue; }

      const n = hash3(px, py, 55);
      const dither = ((BAYER[(py & 3) * 4 + (px & 3)] + 0.5) / 16) * 0.72 + n * 0.28;
      let col;
      let alpha = 255;

      if (isWater && f > 0.2) {
        // A crossing used enough becomes a bridge. The decking is deliberately
        // *lighter* than the road either side: at this scale a plank pattern in
        // road-brown over blue water just reads as more road, and the whole
        // point is that you can see where the network had to build something.
        const plank = (px + py * 2) % 6;
        col = plank < 1 ? colors.woodDark : (plank < 4 ? colors.woodLight : colors.wood);
        // The thin outer part of the span becomes the rail.
        if (f < 0.38 || n > 0.95) col = colors.woodDark;
      } else if (isWater) {
        // Not yet a bridge: a churned, muddy ford.
        if (dither > f * 1.5) { data[o + 3] = 0; continue; }
        col = colors.dirtDeep;
      } else {
        // Dither in: a faint track is stippled, a trunk road is solid.
        const cover = f * 1.5 - 0.08;
        if (dither > cover) { data[o + 3] = 0; continue; }
        if (f > 0.8) {
          // Packed centre with wheel ruts either side.
          col = colors.plaza[(n * 3) | 0];
          if (hash3(px >> 1, py >> 1, 7) > 0.74) col = colors.dirtDeep;
        } else if (f > 0.42) {
          col = colors.dirt[(n * 3) | 0];
          if (n > 0.92) col = colors.dirtDeep;
        } else {
          col = colors.track[(n * 3) | 0];
        }
        // Feather the outer edge so verges fade rather than stop.
        if (f < 0.32) alpha = 120 + (((f / 0.32) * 135) | 0);
      }

      data[o] = col[0];
      data[o + 1] = col[1];
      data[o + 2] = col[2];
      data[o + 3] = alpha;
    }
  }
}

function markDirty(layer, i) {
  if (layer.queued[i]) return;
  layer.queued[i] = 1;
  layer.queue.push(i);
}

/**
 * A tile whose wear moved, plus the neighbours whose edge pixels sample it.
 * The spread is what stops a change showing up as a row of hard-edged squares.
 *
 * Worth knowing before trying to save the four extra marks: skipping them for
 * decay looks safe — fade is uniform, so a tile past EPS sits among neighbours
 * that faded by the same factor — but it is not, and it does not pay. A bright
 * road tile crosses EPS several times as often as its faint verge, so the verge
 * stays chronically stale rather than catching up. Measured against a
 * from-scratch repaint it took the standing difference from 0.36% of pixels to
 * 0.47%, and the frame cost it saved was inside the noise. Kept.
 */
function markTile(layer, i) {
  markDirty(layer, i);
  const tx = i % MAP.w, ty = (i / MAP.w) | 0;
  if (tx > 0) markDirty(layer, i - 1);
  if (tx < MAP.w - 1) markDirty(layer, i + 1);
  if (ty > 0) markDirty(layer, i - MAP.w);
  if (ty < MAP.h - 1) markDirty(layer, i + MAP.w);
}

/**
 * Push the tiles painted this frame to the canvas.
 *
 * `done` holds them in the order they were painted, which is the order they
 * were queued in and therefore arbitrary. Sorting puts them in row-major order,
 * where a smudge of dirty tiles becomes a handful of short runs along
 * successive rows, and each run is one small upload instead of a share in one
 * enormous one.
 */
function flush(layer, done, count) {
  if (!count) return;
  const tiles = done.subarray(0, count);
  tiles.sort();

  // Count the runs first: if the dirt really is scattered all over the map,
  // hundreds of tiny uploads cost more in call overhead than one big rectangle.
  let runs = 1;
  for (let k = 1; k < count; k++) {
    const a = tiles[k - 1], b = tiles[k];
    if (((b / MAP.w) | 0) !== ((a / MAP.w) | 0) || b - a > RUN_GAP) runs++;
  }

  // Too scattered to be worth one call each: send each dirty row entire, and
  // merge rows that turned out to be adjacent into a single taller band.
  if (runs > MAX_RUNS) {
    let bandY = (tiles[0] / MAP.w) | 0, bandH = 1;
    for (let k = 1; k <= count; k++) {
      const ty = k < count ? (tiles[k] / MAP.w) | 0 : -1;
      if (ty === bandY + bandH - 1) continue;               // same row again
      if (ty === bandY + bandH) { bandH++; continue; }      // the next row down
      layer.ctx.putImageData(layer.img, 0, 0, 0, bandY * TILE, MAP.w * TILE, bandH * TILE);
      bandY = ty;
      bandH = 1;
    }
    return;
  }

  let start = 0;
  for (let k = 1; k <= count; k++) {
    const a = tiles[k - 1];
    const brk = k === count
      || ((tiles[k] / MAP.w) | 0) !== ((a / MAP.w) | 0)
      || tiles[k] - a > RUN_GAP;
    if (!brk) continue;
    const ty = (a / MAP.w) | 0;
    const x0 = tiles[start] % MAP.w, x1 = a % MAP.w;
    layer.ctx.putImageData(layer.img, 0, 0,
      x0 * TILE, ty * TILE, (x1 - x0 + 1) * TILE, TILE);
    start = k;
  }
}

/**
 * Bring the layer up to date with the wear field.
 * @param {boolean} all repaint everything (after a load, or an art rebake).
 */
export function updateRoadLayer(layer, state, all = false) {
  if (!layer.colors) layer.colors = colorsFor();
  const { wear } = state;
  const n = MAP.w * MAP.h;
  const log = state.wearTouched;

  if (all) {
    layer.painted.fill(-1);
    layer.queue.length = 0;
    layer.queued.fill(0);
    for (let i = 0; i < n; i++) markDirty(layer, i);
    if (log) clearTouchLog(log);
  } else {
    // What the sim scuffed since the last frame, exactly.
    if (log) {
      if (log.overflow) for (let i = 0; i < n; i++) markDirty(layer, i);
      else for (let k = 0; k < log.n; k++) markTile(layer, log.idx[k]);
      clearTouchLog(log);
    }

    // One slice of the field, looking for tiles that decay has moved. Without
    // a touch log at all this still catches everything, just slowly — which is
    // why a headless state with no log attached is not a broken one.
    const rows = Math.ceil(MAP.h / SWEEP_FRAMES);
    const y0 = layer.sweepRow;
    const y1 = Math.min(MAP.h, y0 + rows);
    for (let i = y0 * MAP.w; i < y1 * MAP.w; i++) {
      if (Math.abs(wear[i] - layer.painted[i]) > EPS) markTile(layer, i);
    }
    layer.sweepRow = y1 >= MAP.h ? 0 : y1;
  }

  if (!layer.queue.length) return;

  const budget = all ? layer.queue.length : Math.min(BUDGET, layer.queue.length);

  for (let k = 0; k < budget; k++) {
    const i = layer.queue[k];
    layer.queued[i] = 0;
    paintTile(layer, state, i % MAP.w, (i / MAP.w) | 0);
    layer.painted[i] = wear[i];
    if (!all) layer.done[k] = i;
  }
  layer.queue.splice(0, budget);

  if (all) layer.ctx.putImageData(layer.img, 0, 0);
  else flush(layer, layer.done, budget);
}

/** Drop cached palette colours so the next update repaints in the new palette. */
export function invalidateRoadColors(layer) {
  layer.colors = null;
}

