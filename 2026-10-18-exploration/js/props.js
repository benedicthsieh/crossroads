// props.js — buildings, wagons and scenery.
//
// Same rules as the characters: authored small, blown up. Buildings are drawn
// flat-on (no true isometric projection) which is the cheapest way to get a
// storybook town that still sorts correctly by depth.
//
// One logical pixel here used to be exactly one world unit, which made the
// buildings enormous: a house was wider than the gap the road had to squeeze
// through, and twenty of them turned a town into a single brown blob. `UNIT`
// below breaks that assumption — a building's logical pixels are now worth
// less than a world unit each, so the same authored art occupies less ground.
// The art itself is untouched; only how much of the map it claims changed.

import { Pix, darken, lighten, mix, hash2 } from './pixel.js';
import { STYLE, pal, styleKey } from './palette.js';

/**
 * World units per authored pixel, by prop family.
 *
 * These are the knobs for "how crowded does a town feel". Dropping `building`
 * makes every settlement sprawl further for the same number of buildings,
 * because the footprints in `sim/towns.js` stay put while the sprites shrink
 * inside them. Characters are deliberately left at 1: shrinking people too
 * would just undo the change.
 */
export const UNIT = {
  building: 0.72,
  wagon: 0.85,
  scenery: 0.92,
};

const cache = new Map();

/**
 * Bake a prop.
 *
 * `unit` is world units per authored pixel. The art is baked at the nearest
 * whole pixel size that gets close, and the leftover fraction is handed back as
 * `dw`/`dh` for the caller to draw at — the same trick `camera.js` already
 * plays between `STYLE.scale` and `STYLE.zoom`, for the same reason: keep the
 * rasteriser on whole pixels and let one resample close the gap.
 */
function cached(key, build, unit = 1) {
  const bake = Math.max(1, Math.round(STYLE.scale * unit));
  const k = `${key}|${styleKey()}|${bake}`;
  let hit = cache.get(k);
  if (hit) return hit;
  const { px, ax, ay } = build();
  px.rimLight(STYLE.rim * 0.7);
  px.outline(STYLE.outline);
  const canvas = px.toCanvas(bake);
  // Final resample factor: what the sprite must be stretched by so that one
  // authored pixel ends up covering exactly `unit` world units on screen.
  const k2 = (unit * STYLE.scale) / bake;
  hit = {
    canvas,
    ax: ax * bake * k2,
    ay: ay * bake * k2,
    dw: canvas.width * k2,
    dh: canvas.height * k2,
    unit,
  };
  cache.set(k, hit);
  return hit;
}

// --------------------------------------------------------------- building kit
//
// Buildings use an oblique 3/4 projection. The front wall stays face-on so
// doors, windows and signage read clearly at 3x, while the depth axis recedes
// up-and-right at a clean 2:1 pixel slope (one pixel across per half pixel up).
// The camera sits high enough to see the front plane of the roof, and that
// plane is what actually sells the volume.
//
//              ______            ridge (shifted right by half the depth)
//            /      /|
//           /______/ |           front plane of the roof
//          |       | /|
//          |_______|/ |          front wall, face-on
//          |       |  /
//          |_______| /           right wall, receding up-right
//
// Light is always from the upper-left, so the receding right wall and the right
// gable are the shaded faces. Every building shares one `shell()` so the
// projection can never drift between them.

/** Screen rise for a given depth. Flooring at 2:1 keeps all edges clean. */
const backShift = (d) => Math.floor(d / 2);

/**
 * Draw a building volume. `x, y` is the front-bottom-left corner.
 * Returns the rows callers need to hang details on.
 */
function shell(px, o) {
  const p = pal();
  const {
    x, y, w, h, d, rise,
    wallC, wallS, roofCols,
    hip = false, overhang = 2,
    openFront = false, footing = true, beams = true,
  } = o;
  const wallTop = y - h + 1;
  // The corner only reads if there's a real value step across it, so the side
  // is derived from the front colour rather than from the front's own shading.
  const sideC = darken(wallC, 0.34);
  const backC = darken(wallC, 0.48);
  const gableC = darken(wallC, 0.26);

  // ---- right wall, receding up-right --------------------------------------
  for (let i = 0; i < d; i++) {
    const up = backShift(i + 1);
    const t = d > 1 ? i / (d - 1) : 0;
    px.fill(x + w + i, wallTop - up, 1, h, mix(sideC, backC, t));
  }

  // ---- front face ---------------------------------------------------------
  if (openFront) {
    // An open bay: shaded interior with the back wall catching a little light.
    px.fill(x, wallTop, w, h, mix('#2a211c', wallS, 0.28));
    px.fill(x, wallTop, w, 2, mix('#2a211c', wallS, 0.14));
    for (let i = 0; i < d; i++) {
      const up = backShift(i + 1);
      px.fill(x + w + i, wallTop - up, 1, 2, darken(backC, 0.2));
    }
  } else {
    px.fill(x, wallTop, w, h, wallC);
    px.shadeOver(x + w - 2, wallTop, 2, h, wallS);     // turning toward the side
    if (beams) {
      px.fill(x, wallTop, 1, h, p.woodDark);
      px.fill(x + w - 1, wallTop, 1, h, p.woodDark);
      px.fill(x, wallTop + Math.floor(h * 0.46), w, 1, p.wood);
    }
  }

  // ---- stone footing, carried round the corner ----------------------------
  if (footing) {
    px.fill(x, y - 1, w, 2, p.stone);
    px.shadeOver(x + w - 2, y - 1, 2, 2, p.stoneDark);
    for (let i = 0; i < d; i++) {
      px.fill(x + w + i, y - 1 - backShift(i + 1), 1, 2, p.stoneDark);
    }
  }

  // ---- right end, sitting on the sheared wall top --------------------------
  // Same triangle either way: a gable is masonry, a hip is more roof. Skipping
  // it for hips would leave the top of the side wall bare.
  const endC = hip ? darken(roofCols[2], 0.12) : gableC;
  const mid = (d - 1) / 2;
  for (let i = 0; i < d; i++) {
    const base = wallTop - backShift(i + 1) - 1;
    const frac = mid > 0 ? 1 - Math.abs(i - mid) / mid : 1;
    const hh = Math.max(0, Math.round(rise * frac));
    if (hh > 0) px.fill(x + w + i, base - hh + 1, 1, hh, endC);
  }

  // ---- roof: front plane, eave to ridge -----------------------------------
  const eaveY = wallTop - 1;
  const ridgeShift = Math.floor(d / 2);
  const extent = backShift(ridgeShift) + rise;
  const x0 = x - overhang, x1 = x + w - 1 + overhang;
  for (let r = 0; r < extent; r++) {
    const t = extent > 1 ? r / (extent - 1) : 1;
    const sh = Math.round(t * ridgeShift);
    const inset = hip ? Math.round(t * ridgeShift * 0.9) : 0;
    const rx0 = x0 + sh + inset;
    const rx1 = x1 + sh - inset;
    if (rx1 < rx0) break;
    px.fill(rx0, eaveY - r, rx1 - rx0 + 1, 1, r % 3 === 1 ? roofCols[2] : roofCols[r % 2]);
    px.set(rx0, eaveY - r, roofCols[2]);               // barge boards
    px.set(rx1, eaveY - r, roofCols[2]);
  }
  const ridgeY = eaveY - extent + 1;
  px.fill(x0 + ridgeShift, ridgeY, w + overhang * 2, 1, lighten(roofCols[1], 0.3));
  // Shadow the wall directly under the eave so the overhang reads.
  px.shadeOver(x, wallTop, w, 1, darken(openFront ? '#2a211c' : wallC, 0.32));

  return { wallTop, eaveY, ridgeY, ridgeShift, x, y, w, h, d, rise };
}

/**
 * A flat trapezoid roof seen head-on: rows widen as they come down. Too small
 * to be worth a full `shell()` — used for caps on things like the well.
 */
function gable(px, cx, topY, rows, topW, botW, cols) {
  for (let i = 0; i < rows; i++) {
    const t = rows > 1 ? i / (rows - 1) : 1;
    const w = Math.round(topW + (botW - topW) * t);
    const x = cx - (w >> 1);
    px.fill(x, topY + i, w, 1, i % 3 === 2 ? cols[2] : cols[i % 2]);
    px.set(x, topY + i, cols[2]);
    px.set(x + w - 1, topY + i, cols[2]);
  }
  px.fill(cx - (topW >> 1), topY, topW, 1, lighten(cols[1], 0.28));
}

/** Posts across an open bay, for sheds and market halls. */
function posts(px, s, count, col, colDark) {
  const { x, y, w, wallTop } = s;
  for (let i = 0; i < count; i++) {
    const px0 = x + Math.round(i * (w - 2) / (count - 1));
    px.fill(px0, wallTop, 2, y - wallTop + 1, col);
    px.fill(px0 + 1, wallTop, 1, y - wallTop + 1, colDark);
  }
}

function windowPane(px, x, y, w, h, p) {
  px.fill(x, y, w, h, p.woodDark);
  px.fill(x + 1, y + 1, w - 2, h - 2, mix('#2b3a4a', p.stoneDark, 0.35));
  px.fill(x + 1, y + 1, w - 2, 1, mix('#4a6a80', p.stone, 0.3));
  px.fill(x + Math.floor(w / 2) - 1, y + 1, 1, h - 2, p.woodDark);  // mullion
}

function door(px, x, y, w, h, p) {
  px.fill(x, y, w, h, p.wood);
  px.shadeOver(x + w - 2, y, 2, h, p.woodDark);
  px.fill(x, y, w, 1, p.woodDark);
  px.set(x + w - 3, y + Math.floor(h / 2), p.coin);  // handle
}

/** Double doors, for the warehouse and anything else that takes a cart. */
function bigDoors(px, x, y, w, h, p) {
  px.fill(x, y, w, h, p.woodDark);
  px.fill(x + 1, y + 1, w - 2, h - 1, p.wood);
  px.shadeOver(x + w - 3, y + 1, 2, h - 1, p.woodDark);
  px.fill(x + Math.floor(w / 2) - 1, y, 2, h, p.woodDark);   // meeting stiles
  px.fill(x, y, w, 1, darken(p.woodDark, 0.25));             // lintel
  for (const bx of [x + 2, x + w - 4]) px.fill(bx, y + 2, 2, 1, p.stoneDark);  // hinges
}

/** A stack of log ends — the lumberyard's signature. */
function logPile(px, x, y, rows, p) {
  const bark = darken(p.trunk, 0.12);
  const grain = mix(p.woodLight, p.wheat, 0.35);
  for (let r = 0; r < rows; r++) {
    const n = rows - r;
    for (let i = 0; i < n; i++) {
      const cx = x + r * 2 + i * 4;
      const cy = y - r * 4;
      px.disc(cx, cy, 2, bark);
      px.set(cx, cy, grain);
      px.set(cx - 1, cy, mix(grain, bark, 0.4));
    }
  }
}

/** Sawn planks, stacked flat. */
function plankStack(px, x, y, w, layers, p) {
  for (let i = 0; i < layers; i++) {
    const yy = y - i * 2;
    px.fill(x + (i % 2), yy - 1, w, 2, i % 2 ? p.woodLight : mix(p.woodLight, p.wheat, 0.3));
    px.shadeOver(x + (i % 2), yy, w, 1, p.woodDark);
  }
}

// ------------------------------------------------------------------ buildings

/** Where lamplight should appear at night, in local pixels from the anchor. */
const LIGHTS = new Map();

function house(variant) {
  const p = pal();
  const w = 30, h = 17, d = 12, rise = 10;
  const px = new Pix(54, 48);
  const x = 4, y = 45;
  const alt = variant % 2 === 1;
  const wallC = alt ? p.plasterDark : p.plaster;
  const s = shell(px, {
    x, y, w, h, d, rise, wallC, wallS: darken(wallC, 0.15),
    roofCols: alt ? p.roofAlt : p.roof,
  });
  door(px, x + 12, y - 12, 8, 11, p);
  windowPane(px, x + 3, s.wallTop + 3, 7, 6, p);
  windowPane(px, x + 21, s.wallTop + 3, 7, 6, p);
  // Chimney, poking through the back slope of the roof.
  const chx = x + w + Math.floor(d / 2) - 3;
  px.fill(chx, s.ridgeY - 7, 5, 9, p.stone);
  px.shadeOver(chx + 3, s.ridgeY - 7, 2, 9, p.stoneDark);
  px.fill(chx, s.ridgeY - 7, 5, 1, p.stoneDark);
  return {
    px, ax: x + (w >> 1), ay: y + 1,
    lights: [[x + 6, s.wallTop + 6], [x + 24, s.wallTop + 6]],
    chimney: [chx + 2 - (x + (w >> 1)), s.ridgeY - 8 - (y + 1)],
  };
}

function inn() {
  const p = pal();
  const w = 42, h = 25, d = 15, rise = 12;
  const px = new Pix(70, 62);
  const x = 5, y = 59;
  const s = shell(px, {
    x, y, w, h, d, rise, wallC: p.plaster, wallS: darken(p.plaster, 0.15),
    roofCols: p.roof,
  });
  // Two storeys: bedrooms above, taproom below.
  windowPane(px, x + 5, s.wallTop + 3, 8, 7, p);
  windowPane(px, x + 29, s.wallTop + 3, 8, 7, p);
  door(px, x + 17, y - 13, 9, 12, p);
  windowPane(px, x + 4, y - 12, 8, 7, p);
  windowPane(px, x + 30, y - 12, 8, 7, p);
  // Hanging sign on a bracket: a mug, because it's an inn.
  const sx = x + w + 2;
  px.fill(sx, s.wallTop + 4, 1, 9, p.woodDark);
  px.fill(sx - 6, s.wallTop + 4, 7, 1, p.woodDark);
  px.fill(sx - 6, s.wallTop + 6, 6, 7, p.wood);
  px.shadeOver(sx - 2, s.wallTop + 6, 2, 7, p.woodDark);
  px.fill(sx - 5, s.wallTop + 8, 4, 4, p.wheat);
  px.fill(sx - 5, s.wallTop + 8, 4, 1, p.white);
  const chx = x + w + Math.floor(d / 2) - 3;
  px.fill(chx, s.ridgeY - 8, 5, 10, p.stone);
  px.shadeOver(chx + 3, s.ridgeY - 8, 2, 10, p.stoneDark);
  return {
    px, ax: x + (w >> 1), ay: y + 1,
    lights: [
      [x + 9, s.wallTop + 6], [x + 33, s.wallTop + 6],
      [x + 8, y - 9], [x + 34, y - 9],
    ],
    chimney: [chx + 2 - (x + (w >> 1)), s.ridgeY - 9 - (y + 1)],
  };
}

function bakery() {
  const p = pal();
  const w = 36, h = 21, d = 13, rise = 11;
  const px = new Pix(60, 54);
  const x = 5, y = 51;
  const s = shell(px, {
    x, y, w, h, d, rise, wallC: p.plaster, wallS: darken(p.plaster, 0.15),
    roofCols: p.roofAlt,
  });
  // Shopfront: striped awning over a counter of loaves.
  const awY = s.wallTop + 8;
  for (let i = 0; i < 24; i++) {
    px.fill(x + 6 + i, awY, 1, 3, i % 4 < 2 ? p.white : p.roof[0]);
  }
  px.fill(x + 5, awY + 3, 26, 1, p.woodDark);
  px.fill(x + 7, awY + 4, 22, 7, mix('#2b2320', p.woodDark, 0.4));   // dark interior
  px.fill(x + 7, awY + 10, 22, 3, p.wood);                           // counter
  px.shadeOver(x + 7, awY + 12, 22, 1, p.woodDark);
  for (let i = 0; i < 4; i++) {
    const bx = x + 9 + i * 5;
    px.fill(bx, awY + 7, 4, 3, '#d9a45e');
    px.shadeOver(bx + 2, awY + 7, 2, 3, '#a97434');
    px.set(bx + 1, awY + 7, lighten('#d9a45e', 0.3));
  }
  windowPane(px, x + 2, s.wallTop + 2, 7, 6, p);
  // The oven chimney: fat, brick, and the reason this place smokes all day.
  const chx = x + w + 2;
  px.fill(chx, s.ridgeY - 9, 7, 13, p.roof[2]);
  px.shadeOver(chx + 4, s.ridgeY - 9, 3, 13, darken(p.roof[2], 0.28));
  px.fill(chx - 1, s.ridgeY - 9, 9, 2, p.stone);
  return {
    px, ax: x + (w >> 1), ay: y + 1,
    lights: [[x + 18, awY + 7], [x + 5, s.wallTop + 5]],
    chimney: [chx + 3 - (x + (w >> 1)), s.ridgeY - 10 - (y + 1)],
  };
}

/**
 * Market hall: a wide hipped roof on open posts. Deliberately the biggest
 * footprint in town, so the crossroads reads as a market that outgrew its
 * stalls rather than just a wide spot in the road.
 */
function marketplace() {
  const p = pal();
  const w = 52, h = 16, d = 15, rise = 9;
  const px = new Pix(80, 50);
  const x = 5, y = 47;
  const s = shell(px, {
    x, y, w, h, d, rise, wallC: p.plaster, wallS: darken(p.plaster, 0.16),
    roofCols: p.roof, hip: true, openFront: true, overhang: 3, beams: false,
  });
  posts(px, s, 5, p.wood, p.woodDark);
  // Scalloped valance hung off the eave.
  for (let i = 0; i < w + 4; i++) {
    px.fill(x - 2 + i, s.wallTop - 1, 1, 2, i % 6 < 3 ? p.roof[0] : p.white);
  }
  for (let i = 0; i < w + 4; i += 6) px.set(x - 2 + i + 1, s.wallTop + 1, p.roof[0]);
  // Goods under cover: crates, barrels, sacks.
  const fy = y - 2;
  for (let i = 0; i < 3; i++) {
    const bx = x + 5 + i * 15;
    px.fill(bx, fy - 6, 8, 6, p.woodLight);
    px.shadeOver(bx + 5, fy - 6, 3, 6, p.woodDark);
    px.fill(bx, fy - 4, 8, 1, p.woodDark);
    px.fill(bx + 10, fy - 5, 5, 5, p.wood);
    px.shadeOver(bx + 13, fy - 5, 2, 5, p.woodDark);
    px.fill(bx + 10, fy - 4, 5, 1, p.stoneDark);
  }
  px.fill(x + 3, fy - 3, 6, 3, p.wheat);                 // sacks of grain
  px.shadeOver(x + 7, fy - 3, 2, 3, p.wheatDark);
  // Pennant on the ridge.
  const fx = x + Math.floor(w / 2) + s.ridgeShift;
  px.fill(fx, s.ridgeY - 8, 1, 8, p.woodDark);
  px.fill(fx + 1, s.ridgeY - 8, 6, 3, p.cloth[0][0]);
  px.shadeOver(fx + 1, s.ridgeY - 6, 6, 1, p.cloth[0][1]);
  return {
    px, ax: x + (w >> 1), ay: y + 1,
    lights: [[x + 12, y - 8], [x + 40, y - 8]],
  };
}

/**
 * Warehouse: long, plain and tall, with cart-sized doors and a hoist beam
 * out of the gable. Reads as infrastructure rather than somewhere anyone lives.
 */
function warehouse() {
  const p = pal();
  const w = 46, h = 23, d = 16, rise = 10;
  const px = new Pix(76, 56);
  const x = 5, y = 53;
  const s = shell(px, {
    x, y, w, h, d, rise, wallC: mix(p.wood, p.plasterDark, 0.45),
    wallS: darken(mix(p.wood, p.plasterDark, 0.45), 0.18), roofCols: p.roofAlt,
  });
  // Board-and-batten: vertical battens down the whole front.
  for (let i = 4; i < w - 3; i += 5) px.fill(x + i, s.wallTop + 1, 1, h - 3, p.woodDark);
  bigDoors(px, x + 14, y - 16, 18, 15, p);
  windowPane(px, x + 4, s.wallTop + 3, 7, 5, p);
  windowPane(px, x + 35, s.wallTop + 3, 7, 5, p);
  // Loading platform in front of the doors.
  px.fill(x + 11, y - 1, 24, 2, p.woodLight);
  px.shadeOver(x + 11, y, 24, 1, p.woodDark);
  // Hoist beam off the right gable, with a block and tackle hanging from it.
  const hy = s.wallTop - Math.floor(d / 4) - 3;
  px.fill(x + w + 4, hy, 16, 3, p.woodLight);
  px.shadeOver(x + w + 4, hy + 2, 16, 1, p.woodDark);
  px.fill(x + w + 4, hy, 16, 1, lighten(p.woodLight, 0.25));
  px.line(x + w + 12, hy + 3, x + w + 12, s.wallTop + 2, p.woodDark);   // brace
  px.fill(x + w + 18, hy + 3, 1, 7, p.stoneDark);                       // rope
  px.fill(x + w + 16, hy + 10, 5, 3, p.wood);                           // block
  px.shadeOver(x + w + 19, hy + 10, 2, 3, p.woodDark);
  // Crates waiting to go in.
  px.fill(x - 1, y - 7, 9, 7, p.woodLight);
  px.shadeOver(x + 5, y - 7, 3, 7, p.woodDark);
  px.fill(x - 1, y - 4, 9, 1, p.woodDark);
  return {
    px, ax: x + (w >> 1), ay: y + 1,
    lights: [[x + 7, s.wallTop + 5], [x + 38, s.wallTop + 5]],
  };
}

/**
 * Lumberyard: an open-fronted timber shed, stacked logs, and a sawhorse.
 * The one building with no front wall at all, which makes it read instantly
 * as somewhere work happens rather than somewhere goods are sold.
 */
function lumberyard() {
  const p = pal();
  const w = 40, h = 18, d = 15, rise = 9;
  const px = new Pix(70, 50);
  const x = 5, y = 47;
  const s = shell(px, {
    x, y, w, h, d, rise, wallC: p.wood, wallS: darken(p.wood, 0.2),
    roofCols: [mix(p.wood, p.stone, 0.35), mix(p.woodDark, p.stone, 0.3), p.woodDark],
    openFront: true, footing: false, beams: false, overhang: 3,
  });
  posts(px, s, 4, p.wood, p.woodDark);
  // Cross-brace under the eave.
  px.fill(x + 1, s.wallTop + 2, w - 2, 1, p.woodDark);
  // Logs under cover, planks stacked beside them.
  logPile(px, x + 3, y - 3, 3, p);
  plankStack(px, x + 22, y - 2, 14, 4, p);
  // More logs out in the yard, plus a sawhorse with a plank across it.
  logPile(px, x + w + 4, y - 5, 2, p);
  const shx = x - 3;
  px.line(shx, y - 1, shx + 3, y - 7, p.wood);
  px.line(shx + 6, y - 1, shx + 3, y - 7, p.wood);
  px.fill(shx - 1, y - 9, 12, 2, p.woodLight);
  px.shadeOver(shx - 1, y - 8, 12, 1, p.woodDark);
  // Sawdust and offcuts on the ground.
  for (let i = 0; i < 14; i++) {
    const dx = Math.floor(hash2(i, 3, 21) * (w + 14));
    const dy = y - Math.floor(hash2(i, 4, 21) * 3);
    px.set(x - 4 + dx, dy, mix(p.wheat, p.dirt[0], 0.5));
  }
  return { px, ax: x + (w >> 1), ay: y + 1, lights: [[x + 20, y - 8]] };
}

/**
 * Smithy: stone below, timber above, and an oversized chimney. The forge
 * opening is a light source, which makes this the best-looking building on the
 * map after dark.
 */
function smithy() {
  const p = pal();
  const w = 30, h = 19, d = 13, rise = 10;
  const px = new Pix(56, 52);
  const x = 5, y = 49;
  const s = shell(px, {
    x, y, w, h, d, rise, wallC: mix(p.stone, p.plasterDark, 0.5),
    wallS: darken(mix(p.stone, p.plasterDark, 0.5), 0.16), roofCols: p.roof,
  });
  // Stone courses across the lower half.
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < w - 2; i++) {
      const dark = (i + (j % 2) * 3) % 6 < 2;
      px.set(x + 1 + i, y - 9 + j, dark ? p.stoneDark : p.stone);
    }
  }
  // The forge: a glowing opening with a hood over it.
  const fx = x + 4, fy = y - 8;
  px.fill(fx, fy, 11, 7, '#2a1c16');
  px.fill(fx + 2, fy + 3, 7, 4, '#e07a32');
  px.fill(fx + 3, fy + 4, 5, 3, p.lamp);
  px.fill(fx + 4, fy + 5, 3, 2, lighten(p.lamp, 0.5));
  px.fill(fx - 1, fy - 2, 13, 2, p.woodDark);            // hood
  door(px, x + 19, y - 11, 8, 10, p);
  px.fill(x + w + Math.floor(d / 2) - 3, s.ridgeY - 10, 6, 12, p.stoneDark);
  px.fill(x + w + Math.floor(d / 2) - 4, s.ridgeY - 10, 8, 2, p.stone);
  // Anvil and slack tub, both kept on the near-side ground so they don't end
  // up floating halfway up the receding side wall.
  px.fill(x - 5, y - 4, 3, 1, p.stone);                  // horn
  px.fill(x - 6, y - 3, 6, 2, p.stoneDark);
  px.fill(x - 4, y - 1, 2, 2, darken(p.stoneDark, 0.2)); // stump
  px.fill(x + w + 1, y - 3, 7, 4, p.wood);
  px.fill(x + w + 1, y - 3, 7, 1, p.water);
  px.shadeOver(x + w + 6, y - 3, 2, 4, p.woodDark);
  return {
    px, ax: x + (w >> 1), ay: y + 1,
    lights: [[fx + 5, fy + 4]],
    chimney: [x + w + Math.floor(d / 2) - (x + (w >> 1)), s.ridgeY - 11 - (y + 1)],
    forge: true,
  };
}

/**
 * Market stall — the busiest object in the scene, so it gets the most detail.
 * Built in two halves that share one grid, so both align when drawn at the same
 * spot: the 'back' half (posts + awning) sorts behind the stallholder and the
 * 'front' half (counter + goods) sorts in front of them. Without the split the
 * keeper would be hidden by their own stall.
 */
function stall(variant, part) {
  const p = pal();
  const w = 40, h = 34;
  const px = new Pix(w, h);
  const cx = 20;
  const stripe = [p.roof[0], p.roofAlt[0], p.cloth[2][0]][variant % 3];
  const cY = 20;

  if (part === 'back') {
    // Posts.
    px.fill(3, 8, 2, 22, p.wood);
    px.fill(w - 5, 8, 2, 22, p.wood);
    px.shadeOver(w - 4, 8, 1, 22, p.woodDark);
    // Awning: a scalloped stripe canopy, the signature market silhouette.
    for (let i = 0; i < 36; i++) {
      px.fill(2 + i, 6, 1, 4, i % 6 < 3 ? stripe : p.white);
    }
    for (let i = 0; i < 36; i += 6) {
      px.fill(2 + i, 10, 3, 1, stripe);              // scallops
      px.fill(5 + i, 10, 3, 1, p.white);
      px.set(3 + i, 11, stripe);
    }
    px.fill(2, 5, 36, 1, darken(stripe, 0.3));
    return { px, ax: cx, ay: h - 2, lights: [] };
  }

  // Counter and goods.
  px.fill(4, cY, 32, 4, p.wood);
  px.shadeOver(4, cY + 2, 32, 2, p.woodDark);
  px.fill(4, cY + 4, 32, 6, p.woodDark);
  if (variant % 3 === 0) {
    for (let i = 0; i < 3; i++) {
      const bx = 7 + i * 10;
      px.fill(bx, cY - 4, 7, 4, p.woodLight);         // baskets
      px.shadeOver(bx + 5, cY - 4, 2, 4, p.woodDark);
      px.fill(bx + 1, cY - 6, 5, 2, i === 0 ? '#c26a5a' : i === 1 ? p.wheat : p.leaf[1]);
    }
  } else if (variant % 3 === 1) {
    for (let i = 0; i < 4; i++) {
      px.fill(6 + i * 8, cY - 3, 6, 3, '#d9a45e');    // bread trays
      px.shadeOver(10 + i * 8, cY - 3, 2, 3, '#a97434');
    }
  } else {
    px.fill(6, cY - 6, 8, 6, p.water);                // fish / cloth bolts
    px.shadeOver(11, cY - 6, 3, 6, darken(p.water, 0.25));
    px.fill(18, cY - 5, 7, 5, p.cloth[4][0]);
    px.fill(26, cY - 4, 7, 4, p.cloth[3][0]);
  }
  return { px, ax: cx, ay: h - 2, lights: [[cx, cY - 2]] };
}

/**
 * A tent: one covered wagon, unhitched and pitched.
 *
 * Deliberately the *same* canvas arch and the same three hood colours as
 * `wagonSide` — a town's first housing has to read as the wagons that arrived,
 * not as generic camping gear. The propped wheel is the tell: it says this
 * shape used to move, and now doesn't.
 */
function tent(variant) {
  const p = pal();
  const px = new Pix(34, 28);
  const y = 25;                                  // ground line
  const cx = 15;
  const canvasC = [p.plaster, mix(p.plaster, p.wheat, 0.3), mix(p.plaster, p.cloth[7][0], 0.35)][variant % 3];
  const canvasS = darken(canvasC, 0.26);

  // The hood, straight off the wagon and sitting on the dirt.
  const w = 22;
  for (let i = 0; i < w; i++) {
    const t = i / (w - 1);
    const lift = Math.round(Math.sin(t * Math.PI) * 4);
    const h = 8 + lift;
    px.fill(cx - 10 + i, y - h, 1, h, canvasC);
    px.set(cx - 10 + i, y - h, lighten(canvasC, 0.26));
  }
  px.shadeOver(cx + 3, y - 12, 9, 12, canvasS);          // light from the upper left
  for (let i = 3; i < w - 2; i += 5) {                    // hoops showing through
    const lift = Math.round(Math.sin((i / (w - 1)) * Math.PI) * 4);
    px.fill(cx - 10 + i, y - 8 - lift + 1, 1, 7 + lift, mix(canvasC, canvasS, 0.55));
  }

  // The doorway: a dark gap with the flap pulled back to one side.
  px.fill(cx - 3, y - 9, 6, 9, darken(canvasS, 0.55));
  px.fill(cx - 4, y - 10, 2, 10, canvasS);
  px.fill(cx + 2, y - 10, 2, 10, canvasS);

  // Guy ropes and pegs, which is what stops it reading as a loaf of bread.
  px.line(cx - 11, y - 9, cx - 14, y - 1, p.woodDark);
  px.line(cx + 11, y - 9, cx + 14, y - 1, p.woodDark);
  px.fill(cx - 15, y - 1, 2, 2, p.dirtDeep);
  px.fill(cx + 14, y - 1, 2, 2, p.dirtDeep);

  wheel(px, cx + 13, y - 4, 4, p);                       // the wagon it used to be
  return { px, ax: cx, ay: y + 1, lights: [[cx, y - 5]] };
}

/**
 * A quarry: the only place stone comes from.
 *
 * Drawn as a cut into rising ground rather than as a building, because that is
 * what it is — the benches are stepped back so it reads as excavation, and the
 * dressed blocks stacked at the foot are what the town is actually waiting for.
 */
function quarry() {
  const p = pal();
  const px = new Pix(46, 36);
  const y = 33;
  const rock = mix(p.stone, p.dirtDeep, 0.25);
  const lit = lighten(rock, 0.26);
  const dark = darken(rock, 0.32);

  // Stepped benches, each cut further back into the hill than the last. The
  // shadow under every lip is what makes them read as *cut* rather than as one
  // grey lump — without it the whole thing is a boulder.
  for (let i = 0; i < 4; i++) {
    const bw = 34 - i * 6;
    const bx = 6 + i * 3;
    const by = y - 6 - i * 5;
    px.fill(bx, by, bw, 6, i % 2 ? darken(rock, 0.16) : rock);
    px.fill(bx, by, bw, 1, lit);                         // the lit top of the bench
    px.fill(bx, by + 1, bw, 1, darken(rock, 0.42));      // the cut face beneath it
    px.shadeOver(bx + bw - 5, by, 5, 6, dark);           // shaded right end
    px.fill(bx, by, 1, 6, dark);                         // and the left cut
  }
  // Spoil and rubble along the working floor.
  for (let i = 0; i < 14; i++) {
    const sx = 4 + Math.floor(hash2(i, 3, 19) * 36);
    const sy = y - 4 + Math.floor(hash2(i, 5, 23) * 4);
    px.disc(sx, sy, hash2(i, 7, 29) > 0.6 ? 2 : 1.2, hash2(i, 9, 31) > 0.5 ? dark : rock);
  }
  // Dressed blocks, squared off and stacked ready to go.
  const block = (bx, by) => {
    px.fill(bx, by, 8, 5, p.stone);
    px.fill(bx, by, 8, 1, lighten(p.stone, 0.3));
    px.shadeOver(bx + 5, by, 3, 5, p.stoneDark);
  };
  block(6, y - 5);
  block(7, y - 10);
  block(16, y - 5);
  // A timber derrick over the face — the one thing here that says "worked".
  px.fill(33, y - 22, 2, 20, p.wood);
  px.shadeOver(34, y - 22, 1, 20, p.woodDark);
  px.line(33, y - 22, 24, y - 18, p.woodDark);
  px.line(26, y - 18, 26, y - 12, p.woodDark);           // rope
  px.fill(24, y - 12, 5, 4, p.stone);                    // block on the hook
  px.fill(30, y - 2, 8, 2, p.dirtDeep);
  return { px, ax: 23, ay: y + 1, lights: [] };
}

/**
 * A field, at one of three stages of being broken in.
 *
 * The stages are the mechanic made visible: 0 is ground being cleared (stumps
 * and scrub still in it), 1 is ploughed and sown, 2 is a crop worth eating. A
 * town that has just decided to farm therefore *looks* like it has taken on a
 * job, for as long as the job actually takes.
 */
function field(stage) {
  const p = pal();
  const px = new Pix(56, 30);
  const y = 27;
  const soil = stage === 0 ? mix(p.dirt[2], p.grass[2], 0.35) : p.dirt[1];
  const soilDark = darken(soil, 0.22);

  // The plot, drawn as furrows running away up-right so it sits in the same
  // oblique projection everything else does.
  for (let row = 0; row < 8; row++) {
    const w = 46 - row * 3;
    const rx = 4 + row * 2;
    const ry = y - row * 2 - 1;
    px.fill(rx, ry, w, 2, row % 2 ? soil : soilDark);
    if (stage > 0) px.fill(rx, ry, w, 1, lighten(soil, 0.12));
  }

  if (stage === 0) {
    // Stumps and cut brush: the ground is *being* cleared, not cleared. The
    // stumps need a pale sawn top or they vanish into the soil they stand on —
    // which is the whole reason this stage exists to be looked at.
    for (let i = 0; i < 9; i++) {
      const sx = 6 + Math.floor(hash2(i, 1, 41) * 40);
      const sy = y - 14 + Math.floor(hash2(i, 2, 43) * 12);
      px.fill(sx, sy, 4, 3, darken(p.trunk, 0.35));
      px.fill(sx, sy, 4, 1, mix(p.woodLight, p.wheat, 0.5));
      if (hash2(i, 3, 47) > 0.55) px.disc(sx + 5, sy + 1, 2, darken(p.leaf[2], 0.1));
    }
    px.fill(40, y - 9, 2, 8, p.wood);                    // a mattock left standing
    px.fill(37, y - 10, 6, 2, p.stoneDark);
  } else {
    // Crop rows. Green shoots first, then something with ears on it.
    const crop = stage === 1 ? p.leaf[0] : p.wheat;
    const cropDark = stage === 1 ? p.leaf[2] : p.wheatDark;
    for (let row = 0; row < 7; row++) {
      const ry = y - row * 2 - 2;
      const rx = 6 + row * 2;
      const w = 42 - row * 3;
      for (let i = 0; i < w; i += 3) {
        const h = stage === 1 ? 2 : 4;
        px.fill(rx + i, ry - h, 1, h, crop);
        px.set(rx + i, ry - h, stage === 1 ? crop : lighten(crop, 0.25));
        px.set(rx + i + 1, ry - h + 1, cropDark);
      }
    }
  }

  // A rail fence along the near edge, which is what makes the patch read as
  // somebody's field rather than as a stain on the grass.
  px.fill(3, y - 1, 48, 1, p.woodLight);
  px.fill(3, y + 1, 48, 1, p.wood);
  for (const fx of [3, 18, 33, 48]) {
    px.fill(fx, y - 4, 2, 6, p.wood);
    px.shadeOver(fx + 1, y - 4, 1, 6, p.woodDark);
  }
  return { px, ax: 28, ay: y + 2, lights: [] };
}

function well() {
  const p = pal();
  const px = new Pix(28, 30);
  const cx = 14;
  // Stone ring, drawn as courses of two tones so it reads as masonry.
  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 18; i++) {
      const dark = (i + (j % 2) * 2) % 5 < 2;
      px.set(5 + i, 18 + j, dark ? p.stoneDark : p.stone);
    }
  }
  px.fill(5, 17, 18, 1, lighten(p.stone, 0.25));
  px.fill(8, 15, 12, 2, p.water);                    // water inside
  px.fill(8, 15, 12, 1, lighten(p.water, 0.4));
  // Posts and shingled cap.
  px.fill(6, 4, 2, 13, p.wood);
  px.fill(20, 4, 2, 13, p.wood);
  gable(px, cx, 0, 6, 8, 26, p.roof);
  px.fill(cx - 1, 6, 2, 1, p.woodDark);              // winch
  px.line(cx, 7, cx, 14, p.woodDark);                // rope
  px.fill(cx - 2, 14, 4, 3, p.woodLight);            // bucket
  return { px, ax: cx, ay: 28, lights: [] };
}

/**
 * Trees. The canopy has to come down far enough to hide most of the trunk —
 * leave too much trunk showing and they read as lollipops rather than trees.
 * Variant 2 is a conifer, purely so the treeline has more than one silhouette.
 */
function tree(variant) {
  const p = pal();
  const px = new Pix(36, 40);
  const cx = 18;
  const trunkDark = darken(p.trunk, 0.25);

  if (variant % 3 === 2) {
    px.fill(cx - 1, 28, 3, 10, p.trunk);
    px.shadeOver(cx + 1, 28, 1, 10, trunkDark);
    // Stacked skirts, widest at the bottom.
    const dark = p.leaf[2];
    for (let i = 0; i < 5; i++) {
      const w = 7 + i * 4;
      const y = 8 + i * 5;
      const col = i % 2 ? dark : p.leaf[0];
      for (let j = 0; j < 5; j++) {
        const ww = Math.max(3, w - (4 - j) * 2);
        px.fill(cx - (ww >> 1), y + j, ww, 1, col);
      }
      px.shadeOver(cx + 2, y, w, 5, darken(col, 0.22));
    }
    px.fill(cx - 1, 6, 2, 3, p.leaf[2]);             // tip
  } else {
    const cols = variant % 3 === 1 ? p.leafAlt.concat([p.leaf[2]]) : p.leaf;
    px.fill(cx - 2, 26, 4, 12, p.trunk);
    px.shadeOver(cx + 1, 26, 2, 12, trunkDark);
    px.fill(cx - 4, 36, 8, 2, darken(p.trunk, 0.1));  // root flare
    const blobs = variant % 3 === 1
      ? [[cx, 16, 9], [cx - 6, 23, 7], [cx + 6, 23, 7], [cx, 9, 7]]
      : [[cx, 19, 11], [cx - 8, 23, 7], [cx + 8, 23, 7], [cx - 4, 11, 7], [cx + 5, 12, 6]];
    blobs.forEach(([x, y, r], i) => px.disc(x, y, r, cols[i % cols.length]));
  }

  // Light the top-left of every leaf mass, then speckle in some leaf texture.
  for (let y = 0; y < px.h; y++) {
    for (let x = 0; x < px.w; x++) {
      const c = px.get(x, y);
      if (!c || y > 34) continue;
      if (!px.get(x, y - 1) && !px.get(x - 1, y)) px.set(x, y, lighten(c, 0.2));
      else if (hash2(x, y, variant) > 0.94) px.set(x, y, darken(c, 0.2));
    }
  }
  return { px, ax: cx, ay: 38, lights: [] };
}

function bush(variant) {
  const p = pal();
  const px = new Pix(18, 14);
  const cols = variant % 2 ? p.leafAlt : p.leaf;
  px.disc(9, 8, 5, cols[0]);
  px.disc(5, 10, 3.5, cols[1 % cols.length]);
  px.disc(13, 10, 3.5, cols[1 % cols.length]);
  if (variant % 3 === 0) {
    px.set(6, 6, '#e0708a'); px.set(11, 5, '#e0d070'); px.set(13, 8, '#e0708a');
  }
  return { px, ax: 9, ay: 13, lights: [] };
}

function barrel() {
  const p = pal();
  const px = new Pix(12, 14);
  px.fill(2, 2, 8, 11, p.wood);
  px.shadeOver(7, 2, 3, 11, p.woodDark);
  px.fill(2, 4, 8, 1, p.stoneDark);
  px.fill(2, 9, 8, 1, p.stoneDark);
  px.fill(3, 1, 6, 2, p.woodLight);
  return { px, ax: 6, ay: 13, lights: [] };
}

function crate() {
  const p = pal();
  const px = new Pix(14, 13);
  px.fill(2, 3, 10, 9, p.woodLight);
  px.shadeOver(8, 3, 4, 9, p.woodDark);
  px.fill(2, 6, 10, 1, p.woodDark);
  px.fill(6, 3, 1, 9, p.woodDark);
  px.fill(2, 3, 10, 1, lighten(p.woodLight, 0.25));
  return { px, ax: 7, ay: 12, lights: [] };
}

function haystack() {
  const p = pal();
  const px = new Pix(24, 20);
  px.disc(12, 14, 9, p.wheat);
  px.fill(3, 14, 18, 5, p.wheat);
  px.shadeOver(14, 8, 8, 11, p.wheatDark);
  for (let i = 0; i < 40; i++) {
    const x = 3 + Math.floor(hash2(i, 1, 7) * 18);
    const y = 8 + Math.floor(hash2(i, 2, 7) * 11);
    if (px.get(x, y)) px.set(x, y, darken(px.get(x, y), 0.18));
  }
  px.fill(10, 3, 2, 6, p.wood);                      // pole
  return { px, ax: 12, ay: 19, lights: [] };
}

function cart() {
  const p = pal();
  const px = new Pix(34, 22);
  px.fill(4, 6, 26, 8, p.wood);
  px.shadeOver(4, 11, 26, 3, p.woodDark);
  px.fill(4, 6, 26, 1, p.woodLight);
  px.fill(2, 4, 3, 10, p.woodDark);                  // side rails
  px.fill(29, 4, 3, 10, p.woodDark);
  px.fill(8, 2, 18, 4, p.wheat);                     // load of hay
  px.shadeOver(19, 2, 7, 4, p.wheatDark);
  [9, 24].forEach((wx) => {                          // wheels
    px.disc(wx, 16, 4, p.woodDark);
    px.disc(wx, 16, 2, p.woodLight);
    px.set(wx, 16, p.stoneDark);
  });
  px.line(30, 8, 33, 6, p.wood);                     // shaft
  return { px, ax: 17, ay: 20, lights: [] };
}

// -------------------------------------------------------------------- wagons
//
// The covered wagon is the single most important sprite in the game now: it is
// what you see when you look at the map from far enough away to see the road
// network, and it has to read as "traffic" at two pixels a world unit. Two
// things do that work — the pale canvas hood, which is the only large light
// shape out on the open ground, and the ox team, which gives the silhouette a
// direction so a stopped caravan looks stopped.

/** A spoked wheel, dark rim and a paler hub. */
function wheel(px, cx, cy, r, p) {
  px.disc(cx, cy, r, darken(p.woodDark, 0.15));
  px.disc(cx, cy, r - 1.6, mix(p.wood, p.woodLight, 0.4));
  px.fill(cx - r + 1, cy, r * 2 - 2, 1, darken(p.woodDark, 0.1));   // spokes
  px.fill(cx, cy - r + 1, 1, r * 2 - 2, darken(p.woodDark, 0.1));
  px.disc(cx, cy, 1.2, p.stoneDark);
}

// The ox is a much darker, greyer brown than the wagon it pulls. That is not a
// realism call — the first version used the same timber brown and the two shapes
// read as one lump at anything under 3x. The animal has to be a separate value
// from the cart or the silhouette says nothing.
const oxHide = (p) => mix(p.trunk, p.stoneDark, 0.42);

/** A draft ox, seen from the side. Chunky enough to read at one pixel a unit. */
function oxSide(px, x, y, p) {
  const hide = oxHide(p);
  const hideS = darken(hide, 0.26);
  px.fill(x + 3, y - 9, 11, 6, hide);          // body
  px.shadeOver(x + 3, y - 5, 11, 2, hideS);
  px.fill(x + 4, y - 10, 8, 1, lighten(hide, 0.2));
  px.fill(x + 12, y - 10, 2, 2, hideS);        // shoulder hump
  px.fill(x + 4, y - 3, 2, 3, hideS);          // legs
  px.fill(x + 8, y - 3, 2, 3, hide);
  px.fill(x + 12, y - 3, 2, 3, hideS);
  px.fill(x, y - 9, 4, 5, hide);               // head, dropped to graze height
  px.shadeOver(x, y - 6, 4, 2, hideS);
  px.fill(x - 1, y - 11, 2, 2, p.stone);       // horns
  px.fill(x + 3, y - 11, 2, 2, p.stone);
  px.set(x + 1, y - 8, p.eye);
  px.fill(x + 14, y - 6, 2, 3, hideS);         // rump, meeting the traces
}

/** Same animal, coming at you. Mostly a head and shoulders. */
function oxEnd(px, cx, y, p) {
  const hide = oxHide(p);
  const hideS = darken(hide, 0.26);
  px.fill(cx - 5, y - 8, 10, 7, hide);
  px.shadeOver(cx + 1, y - 8, 4, 7, hideS);
  px.fill(cx - 3, y - 11, 6, 4, hide);         // head
  px.shadeOver(cx + 1, y - 11, 2, 4, hideS);
  px.fill(cx - 6, y - 12, 2, 2, p.stone);      // horns
  px.fill(cx + 4, y - 12, 2, 2, p.stone);
  px.fill(cx - 5, y - 13, 1, 1, p.stone);
  px.fill(cx + 5, y - 13, 1, 1, p.stone);
  px.set(cx - 2, y - 10, p.eye);
  px.set(cx + 1, y - 10, p.eye);
  px.fill(cx - 1, y - 8, 2, 1, darken(hideS, 0.3));   // muzzle
  px.fill(cx - 4, y - 1, 2, 2, hideS);
  px.fill(cx + 2, y - 1, 2, 2, hideS);
}

/**
 * Covered wagon, side on.
 * `frame` rocks the body a pixel so a moving caravan visibly trundles.
 */
function wagonSide(variant, frame) {
  const p = pal();
  const px = new Pix(50, 32);
  const y = 29;                                 // ground line
  const bob = frame % 2;
  const canvasC = [p.plaster, mix(p.plaster, p.wheat, 0.3), mix(p.plaster, p.cloth[7][0], 0.35)][variant % 3];
  const canvasS = darken(canvasC, 0.26);
  const bx = 20;                                // wagon body, left edge
  const bedY = y - 13 + bob;

  oxSide(px, 1, y, p);
  // Traces: a clear run of daylight between animal and cart. Without the gap
  // the two silhouettes fuse and the whole thing reads as one brown box.
  px.fill(17, bedY + 3, 3, 1, p.woodDark);
  px.fill(bx - 1, bedY + 2, 2, 2, p.woodDark);

  // Bed and side boards.
  px.fill(bx, bedY, 26, 6, p.wood);
  px.shadeOver(bx, bedY + 4, 26, 2, p.woodDark);
  px.fill(bx, bedY, 26, 1, p.woodLight);
  px.fill(bx, bedY, 1, 6, p.woodDark);
  px.fill(bx + 25, bedY, 1, 6, p.woodDark);

  // Canvas hood: an arch on five hoops. The lift is what makes it a hood rather
  // than a crate — a flat top reads as cargo, a curved one reads as shelter.
  const base = bedY;
  for (let i = 0; i < 24; i++) {
    const t = i / 23;
    const lift = Math.round(Math.sin(t * Math.PI) * 3);
    const h = 9 + lift;
    px.fill(bx + 1 + i, base - h, 1, h, canvasC);
    px.set(bx + 1 + i, base - h, lighten(canvasC, 0.26));
  }
  px.shadeOver(bx + 1, base - 3, 24, 3, canvasS);           // shaded under the curve
  for (let i = 3; i < 23; i += 5) {                          // hoops showing through
    const lift = Math.round(Math.sin((i / 23) * Math.PI) * 3);
    px.fill(bx + 1 + i, base - 9 - lift + 1, 1, 8 + lift, mix(canvasC, canvasS, 0.6));
  }
  // Puckered opening at the back, gathered on a drawstring.
  px.fill(bx + 23, base - 10, 3, 11, canvasS);
  px.fill(bx + 24, base - 7, 2, 5, darken(canvasS, 0.35));

  wheel(px, bx + 5, y - 3 + bob, 4, p);
  wheel(px, bx + 21, y - 4 + bob, 5, p);
  return { px, ax: bx + 13, ay: y + 2, lights: [] };
}

/**
 * Covered wagon, end on — the view you get when it walks toward or away.
 * `back` is the going-away view: the ox is hidden behind the hood, and what you
 * see instead is the puckered opening in the canvas.
 */
function wagonEnd(variant, frame, back) {
  const p = pal();
  const px = new Pix(30, 34);
  const y = 27;
  const bob = frame % 2;
  const cx = 15;
  const canvasC = [p.plaster, mix(p.plaster, p.wheat, 0.3), mix(p.plaster, p.cloth[7][0], 0.35)][variant % 3];
  const canvasS = darken(canvasC, 0.26);

  px.fill(cx - 8, y - 12 + bob, 16, 5, p.wood);            // bed, seen end-on
  px.shadeOver(cx + 3, y - 12 + bob, 5, 5, p.woodDark);
  px.fill(cx - 8, y - 12 + bob, 16, 1, p.woodLight);

  // The hood is a fat arch: a stack of rows that narrow toward the top.
  for (let r = 0; r < 12; r++) {
    const t = r / 11;
    const w = Math.round(16 - Math.pow(t, 2.2) * 9);
    px.fill(cx - (w >> 1), y - 13 - r + bob, w, 1, r > 9 ? lighten(canvasC, 0.22) : canvasC);
  }
  px.shadeOver(cx + 3, y - 24 + bob, 6, 12, canvasS);      // light from upper left

  wheel(px, cx - 8, y - 3 + bob, 4, p);
  wheel(px, cx + 8, y - 3 + bob, 4, p);

  if (back) {
    px.fill(cx - 4, y - 21 + bob, 8, 8, darken(canvasS, 0.45));       // the opening
    px.fill(cx - 4, y - 21 + bob, 8, 1, canvasS);
    px.fill(cx - 2, y - 17 + bob, 4, 3, mix(p.wheat, canvasS, 0.35)); // a bundle inside
  } else {
    // Drawn last and a touch lower: the team is nearer the camera than the
    // wagon it is pulling, so it has to sit on top of the wheels.
    oxEnd(px, cx, y + 4, p);
  }
  return { px, ax: cx, ay: y + 6, lights: [] };
}

/** Fingerpost: the little bit of set dressing that says "this is a junction". */
function signpost() {
  const p = pal();
  const px = new Pix(24, 28);
  const cx = 11;
  px.fill(cx, 6, 2, 20, p.wood);
  px.shadeOver(cx + 1, 6, 1, 20, p.woodDark);

  const arm = (x, y, len, pointsLeft) => {
    px.fill(x, y, len, 3, p.woodLight);
    px.shadeOver(x, y + 2, len, 1, p.woodDark);
    // Chamfer the far end into an arrow tip.
    const tip = pointsLeft ? x : x + len - 1;
    px.clear(tip, y);
    px.clear(tip, y + 2);
    px.set(pointsLeft ? x - 1 : x + len, y + 1, p.woodLight);
    // A groove where the lettering would be.
    px.fill(x + (pointsLeft ? 2 : 1), y + 1, len - 3, 1, p.woodDark);
  };

  arm(2, 8, 9, true);
  arm(13, 15, 9, false);
  px.fill(cx - 2, 26, 6, 2, p.dirtDeep);             // mound at the base
  return { px, ax: cx, ay: 27, lights: [] };
}

function lamp() {
  const p = pal();
  const px = new Pix(14, 34);
  px.fill(6, 8, 2, 24, p.woodDark);
  px.fill(4, 30, 6, 2, p.stoneDark);
  px.fill(4, 3, 6, 6, p.stone);                      // lantern housing
  px.fill(5, 4, 4, 4, p.lamp);
  px.fill(3, 2, 8, 1, p.stoneDark);
  px.fill(5, 1, 4, 1, p.stoneDark);
  return { px, ax: 7, ay: 32, lights: [[7, 5]] };
}

function fence(vertical) {
  const p = pal();
  const px = vertical ? new Pix(10, 20) : new Pix(22, 16);
  if (vertical) {
    px.fill(4, 2, 2, 16, p.wood);
    px.fill(3, 5, 4, 2, p.woodLight);
    px.fill(3, 11, 4, 2, p.woodLight);
    return { px, ax: 5, ay: 18, lights: [] };
  }
  px.fill(2, 4, 18, 2, p.woodLight);
  px.fill(2, 9, 18, 2, p.woodLight);
  [3, 10, 17].forEach((x) => {
    px.fill(x, 2, 2, 12, p.wood);
    px.shadeOver(x + 1, 2, 1, 12, p.woodDark);
  });
  return { px, ax: 11, ay: 14, lights: [] };
}

/** One tuft of crop. Fields are made of dozens of these, jittered. */
function wheatTuft(stage) {
  const p = pal();
  const px = new Pix(10, 14);
  const green = p.leaf[0];
  const stalk = stage === 0 ? green : mix(green, p.wheat, 0.55);
  for (const x of [3, 5, 7]) {
    px.line(x, 12, x - (x - 5) * 0.2 | 0, 5 - (stage ? 1 : 0), stalk);
  }
  if (stage > 0) {
    for (const x of [3, 5, 7]) {
      px.fill(x - 1, 3, 3, 3, p.wheat);
      px.shadeOver(x + 1, 3, 1, 3, p.wheatDark);
      px.set(x, 2, p.wheat);
    }
  }
  return { px, ax: 5, ay: 13, lights: [] };
}

function flowers(variant) {
  const p = pal();
  const px = new Pix(12, 10);
  const colors = ['#e0708a', '#e0d070', '#a888d8', '#f0f0e0'];
  for (let i = 0; i < 4; i++) {
    const x = 2 + Math.floor(hash2(i, variant, 3) * 8);
    const y = 4 + Math.floor(hash2(i, variant, 9) * 4);
    px.line(x, 9, x, y + 1, p.leaf[0]);
    px.set(x, y, colors[(i + variant) % colors.length]);
  }
  return { px, ax: 6, ay: 9, lights: [] };
}

// --------------------------------------------------------------- landscape
//
// The terrain painter draws hills and mountains as *ground* — banded colour and
// hillshade. That alone reads as a height map rather than as a place, so these
// props go on top to give the high ground a silhouette. They are the only thing
// standing between "a beige patch" and "a mountain you'd rather walk around".

/** A rock spire. Big ones are mountain peaks, small ones are outcrops. */
function crag(variant) {
  const p = pal();
  const tall = variant % 3;
  const h = 20 + tall * 9;
  const w = 18 + tall * 7;
  const px = new Pix(w, h + 4);
  const cx = w >> 1;
  const base = mix(p.stone, p.dirtDeep, 0.25);
  const lit = lighten(base, 0.28);
  const dark = darken(base, 0.34);

  // A stack of narrowing slabs. Offsetting each one gives the crooked,
  // fractured look that a plain triangle never has.
  let width = w - 2;
  let y = h;
  let lean = 0;
  for (let band = 0; width > 2; band++) {
    const bh = Math.max(2, 3 + ((band * 7 + variant * 3) % 3));
    lean += Math.round(hash2(band, variant, 5) * 3) - 1;
    const x = cx - (width >> 1) + lean;
    px.fill(x, y - bh, width, bh, base);
    px.shadeOver(x + Math.round(width * 0.55), y - bh, width, bh, dark);   // right face
    px.fill(x, y - bh, Math.max(1, width >> 2), 1, lit);                   // lit ledge
    y -= bh;
    width -= 2 + ((band + variant) % 2) * 2;
  }
  if (y > 2) px.fill(cx - 1 + lean, y - 2, 3, 3, lit);                     // summit cap

  // Scree at the foot, so the spire isn't pasted onto flat ground.
  for (let i = 0; i < 7; i++) {
    const sx = 1 + Math.floor(hash2(i, variant, 12) * (w - 2));
    const sy = h - Math.floor(hash2(i, variant, 13) * 3);
    px.set(sx, sy, hash2(i, variant, 14) > 0.5 ? dark : base);
  }
  return { px, ax: cx, ay: h + 1, lights: [] };
}

/** A boulder, for hill country. */
function rock(variant) {
  const p = pal();
  const px = new Pix(14, 11);
  const base = mix(p.stone, p.dirt[2], 0.3);
  px.disc(7, 7, variant % 2 ? 4 : 3.2, base);
  px.shadeOver(8, 4, 6, 8, darken(base, 0.26));
  px.fill(4, 4, 3, 1, lighten(base, 0.3));
  if (variant % 2) px.disc(3, 9, 2, darken(base, 0.12));
  return { px, ax: 7, ay: 10, lights: [] };
}

/** Reeds, to stop riverbanks being a hard edge between blue and green. */
function reeds(variant) {
  const p = pal();
  const px = new Pix(12, 12);
  const green = darken(p.leaf[0], 0.1);
  for (let i = 0; i < 5; i++) {
    const x = 2 + Math.floor(hash2(i, variant, 21) * 8);
    const top = 2 + Math.floor(hash2(i, variant, 22) * 4);
    px.line(x, 11, x + (i % 2 ? 1 : -1), top, green);
    if (hash2(i, variant, 23) > 0.5) px.fill(x - 1 + (i % 2), top - 1, 2, 2, p.wheatDark);
  }
  return { px, ax: 6, ay: 11, lights: [] };
}

// ---------------------------------------------------------------- the waste
//
// The desert painter draws dunes, and dunes alone are ground rather than a
// place. These three props are the whole silhouette budget for a tenth of the
// map, so each one has a different job: the cactus gives it a vertical, the
// dead bush gives it litter at ground level, and the bleached bone gives it the
// one detail that says *this ground kills things*.

/** A column cactus. Two arms or none — three starts to look like a cartoon. */
function cactus(variant) {
  const p = pal();
  const px = new Pix(16, 30);
  const cx = 8;
  const skin = mix(p.leaf[0], p.stone, 0.22);
  const lit = lighten(skin, 0.26);
  const dark = darken(skin, 0.3);

  px.fill(cx - 2, 8, 4, 21, skin);
  px.fill(cx - 2, 7, 4, 1, lit);                     // rounded crown
  px.shadeOver(cx + 1, 8, 2, 21, dark);
  px.fill(cx - 2, 10, 1, 17, lit);                   // the lit rib

  if (variant % 2 === 0) {
    // Left arm, elbowed: a straight stub reads as a signpost.
    px.fill(cx - 6, 18, 3, 3, skin);
    px.fill(cx - 6, 13, 3, 6, skin);
    px.fill(cx - 6, 12, 3, 1, lit);
    px.shadeOver(cx - 4, 12, 1, 9, dark);
  }
  // Right arm, always, a little higher so the two are never symmetrical.
  px.fill(cx + 2, 15, 3, 3, skin);
  px.fill(cx + 3, 10, 3, 6, skin);
  px.fill(cx + 3, 9, 3, 1, lit);
  px.shadeOver(cx + 4, 9, 2, 9, dark);

  // Spines: single pixels, or the outline pass welds them into a fuzz.
  for (let i = 0; i < 5; i++) {
    const y = 11 + i * 4;
    px.set(cx - 3, y, lit);
    px.set(cx + 3, y + 2, dark);
  }
  return { px, ax: cx, ay: 29, lights: [] };
}

/** Dead scrub. What a bush looks like two summers after the last rain. */
function deadbush(variant) {
  const p = pal();
  const px = new Pix(16, 12);
  const wood = mix(p.trunk, p.sandDeep, 0.45);
  const pale = lighten(wood, 0.3);
  for (let i = 0; i < 7; i++) {
    const x = 3 + Math.floor(hash2(i, variant, 31) * 10);
    const top = 2 + Math.floor(hash2(i, variant, 33) * 5);
    px.line(8, 11, x, top, i % 3 === 0 ? pale : wood);
  }
  px.fill(6, 10, 5, 1, darken(wood, 0.25));
  return { px, ax: 8, ay: 11, lights: [] };
}

/** A skull and a couple of ribs, bleached. Rare on purpose — see `scenery.js`. */
function bones() {
  const p = pal();
  const px = new Pix(14, 8);
  const bone = mix(p.white, p.sand[0], 0.35);
  const shade = darken(bone, 0.25);
  px.disc(4, 4, 2.6, bone);
  px.shadeOver(5, 2, 3, 5, shade);
  px.set(3, 4, p.eye);                               // eye socket
  px.fill(2, 6, 4, 1, shade);                        // jaw
  for (let i = 0; i < 3; i++) px.fill(8 + i * 2, 3 + i, 2, 1, bone);
  return { px, ax: 6, ay: 7, lights: [] };
}

/** A conifer. Reads as upland forest next to the round-canopy broadleaf trees. */
function pine(variant) {
  const p = pal();
  const px = new Pix(22, 34);
  const cx = 11;
  const dark = darken(p.leaf[2], 0.12);
  px.fill(cx - 1, 26, 3, 7, p.trunk);
  px.shadeOver(cx + 1, 26, 1, 7, darken(p.trunk, 0.25));
  for (let i = 0; i < 6; i++) {
    const w = 4 + i * 3;
    const y = 4 + i * 4;
    const col = i % 2 ? dark : p.leaf[variant % 2 ? 1 : 0];
    for (let j = 0; j < 4; j++) {
      const ww = Math.max(2, w - (3 - j) * 2);
      px.fill(cx - (ww >> 1), y + j, ww, 1, col);
    }
    px.shadeOver(cx + 1, y, w, 4, darken(col, 0.24));
  }
  px.fill(cx, 2, 1, 3, dark);
  return { px, ax: cx, ay: 33, lights: [] };
}

// ------------------------------------------------------------------- registry

const BUILDERS = {
  crag0: () => crag(0), crag1: () => crag(1), crag2: () => crag(2),
  rock0: () => rock(0), rock1: () => rock(1),
  reeds0: () => reeds(0), reeds1: () => reeds(1),
  pine0: () => pine(0), pine1: () => pine(1),
  house0: () => house(0), house1: () => house(1), house2: () => house(2),
  inn, bakery, well, cart, signpost, lamp, barrel, crate, haystack,
  marketplace, warehouse, lumberyard, smithy, quarry,
  tent0: () => tent(0), tent1: () => tent(1), tent2: () => tent(2),
  field0: () => field(0), field1: () => field(1), field2: () => field(2),
  stall0back: () => stall(0, 'back'), stall0front: () => stall(0, 'front'),
  stall1back: () => stall(1, 'back'), stall1front: () => stall(1, 'front'),
  stall2back: () => stall(2, 'back'), stall2front: () => stall(2, 'front'),
  tree0: () => tree(0), tree1: () => tree(1), tree2: () => tree(2),
  bush0: () => bush(0), bush1: () => bush(1), bush2: () => bush(2),
  cactus0: () => cactus(0), cactus1: () => cactus(1),
  deadbush0: () => deadbush(0), deadbush1: () => deadbush(1),
  bones,
  fenceH: () => fence(false), fenceV: () => fence(true),
  wheat0: () => wheatTuft(0), wheat1: () => wheatTuft(1),
  flowers0: () => flowers(0), flowers1: () => flowers(1),
};

// Wagons: three canvas colours, two frames of trundle, four headings. One
// horizontal view is the other mirrored, baked rather than flipped at draw time
// so the hot path stays a plain drawImage.
//
// `wagonSide` draws the team at the *left* of the canvas, so it is the
// left-facing view; `side` (used for a caravan heading +x) is the mirror. Get
// this pairing the wrong way round and every caravan on the map trundles along
// with its oxen pushing from behind.
for (let v = 0; v < 3; v++) {
  for (let f = 0; f < 2; f++) {
    BUILDERS[`wagon${v}left${f}`] = () => wagonSide(v, f);
    BUILDERS[`wagon${v}side${f}`] = () => {
      const b = wagonSide(v, f);
      const px = b.px.flipped();
      return { px, ax: px.w - 1 - b.ax, ay: b.ay, lights: [] };
    };
    BUILDERS[`wagon${v}front${f}`] = () => wagonEnd(v, f, false);
    BUILDERS[`wagon${v}back${f}`] = () => wagonEnd(v, f, true);
  }
}

const BUILDING_NAMES = new Set([
  'well', 'inn', 'bakery', 'marketplace', 'warehouse', 'lumberyard', 'smithy',
  'cart', 'signpost', 'lamp', 'haystack', 'barrel', 'crate', 'quarry',
  'house0', 'house1', 'house2',
  'tent0', 'tent1', 'tent2',
  'field0', 'field1', 'field2',
  'stall0back', 'stall0front', 'stall1back', 'stall1front', 'stall2back', 'stall2front',
]);

/** Which shrink factor a prop belongs to. */
export function unitOf(name) {
  if (name.startsWith('wagon')) return UNIT.wagon;
  if (BUILDING_NAMES.has(name)) return UNIT.building;
  return UNIT.scenery;
}

/**
 * Baked props for the style currently in force, keyed by name alone.
 *
 * This exists purely for the draw loop. `drawScene` asks for a prop several
 * thousand times a frame — once per tree, crag and building on screen — and the
 * general path below builds three cache-key strings and does two map lookups
 * for every one of them. Measured on a full map that was a quarter of the
 * renderer's entire frame budget, spent entirely on string concatenation.
 *
 * It cannot go stale on its own: the only thing that changes what a prop looks
 * like is the style key, which is checked on every call, and a re-bake clears
 * the whole thing through `clearPropCache`.
 */
let hot = new Map();
let hotKey = '';

/**
 * Get a baked prop.
 *
 * The returned `dw`/`dh` are the size to draw at, and they are *not* the
 * canvas's own size — see `cached()`. Callers must use them or the shrink is
 * silently lost.
 */
export function prop(name) {
  const style = styleKey();
  if (style !== hotKey) { hot = new Map(); hotKey = style; }
  const unit = unitOf(name);
  // The unit check is not paranoia: `UNIT` is mutable and the demo turns the
  // building shrink off at startup. The style key knows nothing about that, so
  // without this the fast path would happily hand back a prop baked at the
  // other scale.
  const quick = hot.get(name);
  if (quick && quick.unit === unit) return quick;

  const build = BUILDERS[name];
  if (!build) throw new Error(`unknown prop: ${name}`);
  const key = `p|${name}`;
  const bake = Math.max(1, Math.round(STYLE.scale * unit));
  if (!cache.has(`${key}|${style}|${bake}`)) {
    const built = build();
    LIGHTS.set(name, built.lights || []);
  }
  const hit = cached(key, build, unit);
  hot.set(name, hit);
  return hit;
}

/**
 * Local light positions for a prop, in *world units* relative to its anchor —
 * already scaled by the prop's unit, so callers can add them straight onto a
 * building's world position.
 */
export function propLights(name) {
  if (!LIGHTS.has(name)) prop(name);
  const built = LIGHTS.get(name) || [];
  if (!BUILDERS[name]) return [];
  const meta = metaOf(name);
  const u = unitOf(name);
  return built.map(([x, y]) => [(x - meta.ax) * u, (y - meta.ay) * u]);
}

const metaCache = new Map();
function metaOf(name) {
  const u = unitOf(name);
  // Keyed by unit as well as name: `UNIT` is mutable (the demo turns the shrink
  // off), and a cached footprint from the wrong unit is a very quiet bug.
  const key = `${name}|${u}`;
  if (!metaCache.has(key)) {
    const built = BUILDERS[name]();
    metaCache.set(key, {
      ax: built.ax, ay: built.ay,
      // Footprint in *world units*, which is what every caller actually wants:
      // how much ground this thing covers, not how many pixels it was drawn in.
      w: built.px.w * u, h: built.px.h * u,
      // Anchor-relative and in world units too.
      chimney: built.chimney ? [built.chimney[0] * u, built.chimney[1] * u] : null,
      forge: !!built.forge,
    });
    LIGHTS.set(name, built.lights || []);
  }
  return metaCache.get(key);
}

export function propMeta(name) {
  return metaOf(name);
}

export function clearPropCache() {
  cache.clear();
  // `metaCache` deliberately survives: a prop's anchor and footprint come from
  // the authored art and the unit, neither of which a re-bake changes.
  hot = new Map();
  hotKey = '';
}
