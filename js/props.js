// props.js — buildings and scenery.
//
// Same rules as the characters: authored small, blown up. Buildings are drawn
// flat-on (no true isometric projection) which is the cheapest way to get a
// storybook town that still sorts correctly by depth.

import { Pix, darken, lighten, mix, hash2 } from './pixel.js';
import { STYLE, pal, styleKey } from './palette.js';

const cache = new Map();

function cached(key, build) {
  const k = `${key}|${styleKey()}`;
  let hit = cache.get(k);
  if (hit) return hit;
  const { px, ax, ay } = build();
  px.rimLight(STYLE.rim * 0.7);
  px.outline(STYLE.outline);
  hit = { canvas: px.toCanvas(STYLE.scale), ax: ax * STYLE.scale, ay: ay * STYLE.scale };
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
  marketplace, warehouse, lumberyard, smithy,
  stall0back: () => stall(0, 'back'), stall0front: () => stall(0, 'front'),
  stall1back: () => stall(1, 'back'), stall1front: () => stall(1, 'front'),
  stall2back: () => stall(2, 'back'), stall2front: () => stall(2, 'front'),
  tree0: () => tree(0), tree1: () => tree(1), tree2: () => tree(2),
  bush0: () => bush(0), bush1: () => bush(1), bush2: () => bush(2),
  fenceH: () => fence(false), fenceV: () => fence(true),
  wheat0: () => wheatTuft(0), wheat1: () => wheatTuft(1),
  flowers0: () => flowers(0), flowers1: () => flowers(1),
};

export function prop(name) {
  const build = BUILDERS[name];
  if (!build) throw new Error(`unknown prop: ${name}`);
  const key = `p|${name}`;
  const full = `${key}|${styleKey()}`;
  if (!cache.has(full)) {
    const built = build();
    LIGHTS.set(name, built.lights || []);
  }
  return cached(key, build);
}

/** Local light positions for a prop, in logical pixels relative to its anchor. */
export function propLights(name) {
  if (!LIGHTS.has(name)) prop(name);
  const built = LIGHTS.get(name) || [];
  const b = BUILDERS[name];
  if (!b) return [];
  // Convert from top-left local coords to anchor-relative offsets.
  const meta = metaOf(name);
  return built.map(([x, y]) => [x - meta.ax, y - meta.ay]);
}

const metaCache = new Map();
function metaOf(name) {
  if (!metaCache.has(name)) {
    const built = BUILDERS[name]();
    metaCache.set(name, {
      ax: built.ax, ay: built.ay, w: built.px.w, h: built.px.h,
      // Anchor-relative, so callers never need to know the grid layout.
      chimney: built.chimney || null,
      forge: !!built.forge,
    });
    LIGHTS.set(name, built.lights || []);
  }
  return metaCache.get(name);
}

export function propMeta(name) {
  return metaOf(name);
}

export function clearPropCache() {
  cache.clear();
}
