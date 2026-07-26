// world.js — the crossroads itself.
//
// The whole point of the eventual game is that roads come first and settlements
// grow at the places they cross. So the map is authored the same way: a road
// graph, a plaza where the two main roads meet, and then buildings hung off the
// junction. The ground is baked once into a single canvas at logical resolution
// and then upscaled, which keeps the frame loop to one blit for the terrain.

import { hash2, darken } from '../../js/pixel.js';
import { pal } from '../../js/palette.js';
import { propMeta, propLights } from '../../js/props.js';

export const WORLD = { w: 640, h: 420 };

// Roads: [x1, y1, x2, y2, width]. Two majors crossing, plus lanes that feel
// like they were worn in later.
export const ROADS = [
  [-30, 210, 670, 210, 26],   // east-west high road
  [300, -30, 300, 450, 24],   // north-south road
  [300, 210, 580, 52, 15],    // lane up to the north-east fields
  [176, 210, 120, 356, 13],   // lane down to the south farmstead
];

export const PLAZA = { x: 300, y: 212, w: 152, h: 122 };

// Buildings and scenery. `y` is the ground contact point, which is also the
// depth-sort key.
export const PROPS = [
  // Trades cluster on the junction: the market hall and warehouse take the two
  // biggest plots, the noisy work (lumber, forge) sits further out.
  { name: 'inn', x: 186, y: 158 },
  { name: 'bakery', x: 410, y: 158 },
  { name: 'lumberyard', x: 86, y: 176 },
  { name: 'warehouse', x: 520, y: 250 },
  { name: 'marketplace', x: 392, y: 302 },
  { name: 'smithy', x: 232, y: 330 },
  { name: 'house2', x: 556, y: 150 },
  { name: 'house0', x: 60, y: 268 },
  { name: 'house1', x: 596, y: 300 },
  // Stalls are drawn in two passes with the stallholder sandwiched between, so
  // the awning is behind them and the counter is in front. `sortY` overrides
  // the depth key without moving where the sprite actually lands.
  { name: 'stall0back', x: 248, y: 242, sortY: 228 },
  { name: 'stall0front', x: 248, y: 242, sortY: 243 },
  { name: 'stall1back', x: 352, y: 242, sortY: 228 },
  { name: 'stall1front', x: 352, y: 242, sortY: 243 },
  { name: 'stall2back', x: 236, y: 186, sortY: 172 },
  { name: 'stall2front', x: 236, y: 186, sortY: 187 },
  { name: 'well', x: 300, y: 270 },
  { name: 'signpost', x: 332, y: 196 },
  { name: 'lamp', x: 228, y: 200 },
  { name: 'lamp', x: 372, y: 200 },
  { name: 'lamp', x: 300, y: 288 },
  { name: 'cart', x: 200, y: 236 },
  { name: 'barrel', x: 268, y: 232 },
  { name: 'barrel', x: 274, y: 238 },
  { name: 'crate', x: 336, y: 232 },
  { name: 'crate', x: 366, y: 250 },
  { name: 'haystack', x: 486, y: 118 },
  { name: 'barrel', x: 462, y: 292 },
  { name: 'crate', x: 168, y: 292 },
];

// Named spots the villagers walk to. Kept out of the props list so the sim can
// read them without knowing about art.
export const POI = {
  innDoor: { x: 186, y: 172 },
  innBench: { x: 224, y: 178 },
  bakeryCounter: { x: 410, y: 172 },
  bakeryDoor: { x: 392, y: 168 },
  stallA: { x: 248, y: 252 },       // produce — the farmer's drop-off
  stallB: { x: 352, y: 252 },       // bread — the baker's stall
  stallAKeeper: { x: 248, y: 232 },
  stallBKeeper: { x: 352, y: 232 },
  well: { x: 300, y: 280 },
  houseDoors: [
    { x: 60, y: 278 },
    { x: 596, y: 310 },
    { x: 556, y: 160 },
  ],
  plazaCentre: { x: 300, y: 212 },
  lumberyardDrop: { x: 96, y: 188 },
  woods: { x: 44, y: 120 },
  warehouseDoor: { x: 520, y: 262 },
  marketHall: { x: 392, y: 314 },
  smithyDoor: { x: 240, y: 342 },
  // Where travellers enter and leave the map.
  gates: [
    { x: -24, y: 210 },
    { x: 664, y: 210 },
    { x: 300, y: -24 },
    { x: 300, y: 444 },
    { x: 590, y: 44 },
    { x: 112, y: 372 },
  ],
};

// Crop fields: a rectangle of jittered tufts with a fence along the road side.
export const FIELDS = [
  { x: 430, y: 40, w: 150, h: 76, cols: 9, rows: 5 },
  { x: 30, y: 300, w: 150, h: 90, cols: 9, rows: 5 },
];

// --------------------------------------------------------------- road geometry

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + dx * t, cy = y1 + dy * t;
  return Math.hypot(px - cx, py - cy);
}

/**
 * How "roadlike" a point is: 1 at the centre of a road, 0 at its edge, and
 * increasingly negative the further into the fields you get. Callers rely on
 * the negative range, so this must not be clamped at zero.
 */
export function roadness(x, y) {
  let best = -Infinity;
  for (const [x1, y1, x2, y2, w] of ROADS) {
    const d = distToSeg(x, y, x1, y1, x2, y2);
    best = Math.max(best, 1 - d / (w / 2));
  }
  return best;
}

function plazaness(x, y) {
  // Rounded rectangle falloff so the plaza blends into the roads.
  const dx = Math.abs(x - PLAZA.x) / (PLAZA.w / 2);
  const dy = Math.abs(y - PLAZA.y) / (PLAZA.h / 2);
  const d = Math.pow(Math.pow(dx, 3) + Math.pow(dy, 3), 1 / 3);
  return 1 - d;
}

/** True where a villager can reasonably stand (road, plaza, or worn ground). */
export function walkable(x, y) {
  if (x < 4 || y < 4 || x > WORLD.w - 4 || y > WORLD.h - 4) return false;
  return roadness(x, y) > -0.6 || plazaness(x, y) > -0.35;
}

// ------------------------------------------------------------- scatter & trees

/** Deterministic scenery scatter: trees, bushes and flowers away from traffic. */
export function scatter() {
  const out = [];
  const blocked = PROPS.map((p) => {
    const m = propMeta(p.name);
    return { x: p.x, y: p.y, w: m.w, h: m.h };
  });
  const nearProp = (x, y) =>
    blocked.some((b) => Math.abs(x - b.x) < b.w * 0.6 + 8 && y > b.y - b.h * 0.8 && y < b.y + 14);
  const inField = (x, y) =>
    FIELDS.some((f) => x > f.x - 14 && x < f.x + f.w + 14 && y > f.y - 14 && y < f.y + f.h + 14);

  for (let i = 0; i < 420; i++) {
    const x = Math.floor(hash2(i, 1, 11) * WORLD.w);
    const y = Math.floor(hash2(i, 2, 11) * WORLD.h);
    const r = roadness(x, y);
    const pz = plazaness(x, y);
    if (r > -0.55 || pz > -0.2 || nearProp(x, y) || inField(x, y)) continue;
    const roll = hash2(i, 3, 11);
    const edge = Math.min(x, y, WORLD.w - x, WORLD.h - y) < 60;
    let name;
    if (roll < (edge ? 0.5 : 0.22)) name = `tree${Math.floor(hash2(i, 4, 11) * 3)}`;
    else if (roll < 0.62) name = `bush${Math.floor(hash2(i, 5, 11) * 3)}`;
    else name = `flowers${Math.floor(hash2(i, 6, 11) * 2)}`;
    // Trees need clearance from each other or the canopy turns to mush.
    const minGap = name.startsWith('tree') ? 26 : 12;
    if (out.some((o) => Math.hypot(o.x - x, o.y - y) < minGap)) continue;
    out.push({ name, x, y });
  }

  // Crops, planted in rows so the fields read as cultivated.
  FIELDS.forEach((f, fi) => {
    for (let r = 0; r < f.rows; r++) {
      for (let c = 0; c < f.cols; c++) {
        const x = Math.round(f.x + (c + 0.5) * (f.w / f.cols) + hash2(c, r, fi) * 3 - 1.5);
        const y = Math.round(f.y + (r + 0.5) * (f.h / f.rows) + hash2(c, r, fi + 5) * 3 - 1.5);
        if (roadness(x, y) > -0.4) continue;
        out.push({ name: hash2(c, r, fi + 9) < 0.78 ? 'wheat1' : 'wheat0', x, y });
      }
    }
    // Fence along the field's road-facing edge.
    for (let i = 0; i < f.w / 20; i++) {
      const x = Math.round(f.x + 10 + i * 20);
      const y = f.y + f.h + 8;
      if (roadness(x, y) > -0.3) continue;
      out.push({ name: 'fenceH', x, y });
    }
  });

  return out;
}

// ------------------------------------------------------------------ ground bake

/**
 * Paint the terrain at 1 logical pixel per pixel, then upscale.
 * Grass gets a two-octave speckle; roads get dither at the edges, wheel ruts
 * down the middle, and a few pebbles. All of it deterministic.
 */
export function bakeGround(scale) {
  const p = pal();
  const base = document.createElement('canvas');
  base.width = WORLD.w;
  base.height = WORLD.h;
  const g = base.getContext('2d');
  const img = g.createImageData(WORLD.w, WORLD.h);
  const data = img.data;

  const rgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const grass = p.grass.map(rgb);
  const grassDeep = rgb(p.grassDeep);
  const dirt = p.dirt.map(rgb);
  const dirtDeep = rgb(p.dirtDeep);
  const plazaCols = p.plaza.map(rgb);
  // Warm grey rather than the blue-ish stone tone, or the pebbles read as
  // confetti scattered over the road.
  const pebble = rgb(darken(p.dirtDeep, 0.22));

  // Worn ground around doorways and stalls, so buildings don't sit on raw grass.
  const patches = [
    ...PROPS.filter((q) => /inn|bakery|house|stall|well|market|warehouse|lumber|smithy/.test(q.name)).map((q) => {
      const m = propMeta(q.name);
      return { x: q.x, y: q.y - 2, rx: m.w * 0.5, ry: 10 };
    }),
    { x: POI.innDoor.x, y: POI.innDoor.y + 6, rx: 26, ry: 14 },
    { x: POI.bakeryCounter.x, y: POI.bakeryCounter.y + 6, rx: 30, ry: 14 },
  ];

  for (let y = 0; y < WORLD.h; y++) {
    for (let x = 0; x < WORLD.w; x++) {
      const i = (y * WORLD.w + x) * 4;
      const r = roadness(x, y);
      const pz = plazaness(x, y);
      const n = hash2(x, y, 3);
      const coarse = hash2(x >> 3, y >> 3, 17);

      let col;
      if (pz > 0) {
        // Packed earth of the market square, slightly lighter than the roads.
        col = plazaCols[(n * 3) | 0];
        if (n > 0.992) col = pebble;                       // odd cobble
      } else if (r > 0) {
        col = dirt[(n * 3) | 0];
        // Wheel ruts: two darker bands either side of the centreline.
        if (Math.abs(r - 0.55) < 0.09 && coarse > 0.25) col = dirtDeep;
        if (n > 0.993) col = pebble;                       // pebbles
      } else {
        const t = coarse * 0.7 + n * 0.3;
        col = grass[(t * 4) | 0];
        if (coarse < 0.16) col = grassDeep;                // darker meadow patches
        if (n > 0.965) col = grass[3];                     // bright blades
      }

      // Blend the road/plaza edges with a dither so the transition isn't a
      // hard vector line.
      const edge = Math.max(r, pz);
      if (edge > -0.14 && edge <= 0.06) {
        const ditherOn = ((x + y) & 1) === 0 || n > 0.6;
        if (ditherOn) col = dirtDeep;
      }

      // Worn patches fade in as ellipse falloff.
      if (edge <= 0) {
        for (const q of patches) {
          const dx = (x - q.x) / q.rx, dy = (y - q.y) / q.ry;
          const d = dx * dx + dy * dy;
          if (d < 1 && (1 - d) > n * 0.85) { col = dirt[(n * 3) | 0]; break; }
        }
      }

      data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // Upscale with nearest-neighbour so the terrain pixels match the sprites.
  const out = document.createElement('canvas');
  out.width = WORLD.w * scale;
  out.height = WORLD.h * scale;
  const og = out.getContext('2d');
  og.imageSmoothingEnabled = false;
  og.drawImage(base, 0, 0, out.width, out.height);
  return out;
}

/** Every light source in the world, in logical coords, for the night pass. */
export function collectLights() {
  const out = [];
  for (const q of PROPS) {
    for (const [dx, dy] of propLights(q.name)) {
      // Street lamps throw a wide pool; lit windows stay tight to the glass or
      // the whole facade washes out.
      out.push({ x: q.x + dx, y: q.y + dy, r: q.name === 'lamp' ? 46 : 22 });
    }
  }
  return out;
}
