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
import { roadFrac, ROAD_MIN } from '../sim/roads.js';
import { hash3 } from '../sim/rng.js';
import { pal } from '../palette.js';

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** How much a tile's wear must move before it's worth redrawing. */
const EPS = 0.02;
/** Tiles repainted per frame. Enough to keep up; small enough not to hitch. */
const BUDGET = 900;

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

function paintTile(layer, state, tx, ty) {
  const { data, colors } = layer;
  const { wear, terrain } = state;
  const x0 = tx * TILE, y0 = ty * TILE;
  const kind = terrain.kind[ty * MAP.w + tx];
  const isWater = kind === T.WATER;

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
 * Bring the layer up to date with the wear field.
 * @param {boolean} all repaint everything (after a load, or an art rebake).
 */
export function updateRoadLayer(layer, state, all = false) {
  if (!layer.colors) layer.colors = colorsFor();
  const { wear } = state;
  const n = MAP.w * MAP.h;

  if (all) {
    layer.painted.fill(-1);
    layer.queue.length = 0;
    layer.queued.fill(0);
    for (let i = 0; i < n; i++) markDirty(layer, i);
  } else {
    for (let i = 0; i < n; i++) {
      if (Math.abs(wear[i] - layer.painted[i]) <= EPS) continue;
      markDirty(layer, i);
      const tx = i % MAP.w, ty = (i / MAP.w) | 0;
      if (tx > 0) markDirty(layer, i - 1);
      if (tx < MAP.w - 1) markDirty(layer, i + 1);
      if (ty > 0) markDirty(layer, i - MAP.w);
      if (ty < MAP.h - 1) markDirty(layer, i + MAP.w);
    }
  }

  if (!layer.queue.length) return;

  const budget = all ? layer.queue.length : Math.min(BUDGET, layer.queue.length);
  let minX = WORLD.w, minY = WORLD.h, maxX = 0, maxY = 0;

  for (let k = 0; k < budget; k++) {
    const i = layer.queue[k];
    layer.queued[i] = 0;
    const tx = i % MAP.w, ty = (i / MAP.w) | 0;
    paintTile(layer, state, tx, ty);
    layer.painted[i] = wear[i];
    if (tx * TILE < minX) minX = tx * TILE;
    if (ty * TILE < minY) minY = ty * TILE;
    if ((tx + 1) * TILE > maxX) maxX = (tx + 1) * TILE;
    if ((ty + 1) * TILE > maxY) maxY = (ty + 1) * TILE;
  }
  layer.queue.splice(0, budget);

  if (maxX > minX) {
    layer.ctx.putImageData(layer.img, 0, 0, minX, minY, maxX - minX, maxY - minY);
  }
}

/** Drop cached palette colours so the next update repaints in the new palette. */
export function invalidateRoadColors(layer) {
  layer.colors = null;
}

