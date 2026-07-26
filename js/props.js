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

// -------------------------------------------------------------------- helpers

/** Plastered wall with a timber sill and a stone footing. */
function wall(px, x, y, w, h, p, wallC, wallS) {
  px.fill(x, y, w, h, wallC);
  px.shadeOver(x + w - 3, y, 3, h, wallS);
  px.fill(x, y + h - 2, w, 2, p.stone);              // footing
  px.shadeOver(x + w - 3, y + h - 2, 3, 2, p.stoneDark);
  // Exposed beams, two verticals and a mid rail.
  px.fill(x + 1, y, 1, h - 2, p.woodDark);
  px.fill(x + w - 2, y, 1, h - 2, p.woodDark);
  px.fill(x, y + Math.floor(h * 0.45), w, 1, p.wood);
}

/** Gabled roof: rows widen as they come down, with shingle banding. */
function gable(px, cx, topY, rows, topW, botW, cols) {
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const w = Math.round(topW + (botW - topW) * t);
    const x = cx - (w >> 1);
    const band = i % 3 === 2 ? cols[2] : cols[i % 2];
    px.fill(x, topY + i, w, 1, band);
    px.set(x, topY + i, cols[2]);                    // darker edge
    px.set(x + w - 1, topY + i, cols[2]);
  }
  // Ridge highlight.
  px.fill(cx - (topW >> 1), topY, topW, 1, lighten(cols[1], 0.28));
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

// ------------------------------------------------------------------ buildings

/** Where lamplight should appear at night, in local pixels from the anchor. */
const LIGHTS = new Map();

function house(variant) {
  const p = pal();
  const w = 46, h = 46;
  const px = new Pix(w, h);
  const cx = 23;
  const alt = variant % 2 === 1;
  const roofCols = alt ? p.roofAlt : p.roof;
  const wallC = alt ? p.plasterDark : p.plaster;
  const wallS = darken(wallC, 0.14);
  const wallY = 20, wallH = 22;
  wall(px, 5, wallY, 36, wallH, p, wallC, wallS);
  gable(px, cx, 6, 15, 10, 42, roofCols);
  door(px, cx - 4, wallY + wallH - 12, 8, 12, p);
  windowPane(px, 8, wallY + 3, 8, 7, p);
  windowPane(px, 30, wallY + 3, 8, 7, p);
  // Chimney with a puff of smoke handled by the FX layer.
  px.fill(cx + 9, 3, 5, 8, p.stone);
  px.shadeOver(cx + 12, 3, 2, 8, p.stoneDark);
  px.fill(cx + 9, 3, 5, 1, p.stoneDark);
  return { px, ax: cx, ay: h - 2, lights: [[8 + 4, wallY + 6], [30 + 4, wallY + 6]] };
}

function inn() {
  const p = pal();
  const w = 62, h = 58;
  const px = new Pix(w, h);
  const cx = 31;
  const wallY = 24, wallH = 30;
  wall(px, 4, wallY, 54, wallH, p, p.plaster, darken(p.plaster, 0.14));
  gable(px, cx, 6, 19, 12, 58, p.roof);
  // Upper storey windows tucked under the eaves.
  windowPane(px, 12, wallY + 2, 9, 8, p);
  windowPane(px, 41, wallY + 2, 9, 8, p);
  door(px, cx - 5, wallY + wallH - 14, 10, 14, p);
  windowPane(px, 8, wallY + 15, 8, 7, p);
  windowPane(px, 46, wallY + 15, 8, 7, p);
  // Hanging sign on a bracket — a mug, because it's an inn.
  px.fill(w - 6, wallY - 2, 1, 10, p.woodDark);
  px.fill(w - 12, wallY - 2, 7, 1, p.woodDark);
  px.fill(w - 12, wallY + 1, 7, 7, p.wood);
  px.shadeOver(w - 7, wallY + 1, 2, 7, p.woodDark);
  px.fill(w - 11, wallY + 3, 4, 4, p.wheat);
  px.fill(w - 11, wallY + 3, 4, 1, p.white);
  px.fill(w + 1 - 8, wallY - 2, 1, 1, p.woodDark);
  return {
    px, ax: cx, ay: h - 2,
    lights: [[16, wallY + 6], [45, wallY + 6], [12, wallY + 18], [50, wallY + 18]],
  };
}

function bakery() {
  const p = pal();
  const w = 54, h = 52;
  const px = new Pix(w, h);
  const cx = 27;
  const wallY = 22, wallH = 27;
  wall(px, 4, wallY, 46, wallH, p, p.plaster, darken(p.plaster, 0.14));
  gable(px, cx, 5, 18, 10, 50, p.roofAlt);
  // Big brick oven chimney.
  px.fill(8, 2, 7, 12, p.roof[2]);
  px.shadeOver(12, 2, 3, 12, darken(p.roof[2], 0.25));
  px.fill(7, 2, 9, 2, p.stone);
  // Shopfront: counter under a striped awning, loaves on display.
  const awY = wallY + 8;
  for (let i = 0; i < 26; i++) {
    px.fill(cx - 12 + i, awY, 1, 3, i % 4 < 2 ? p.white : p.roof[0]);
  }
  px.fill(cx - 13, awY + 3, 28, 1, p.woodDark);
  px.fill(cx - 11, awY + 4, 24, 8, mix('#2b2320', p.woodDark, 0.4));   // dark interior
  px.fill(cx - 11, awY + 11, 24, 3, p.wood);                           // counter
  px.shadeOver(cx - 11, awY + 13, 24, 1, p.woodDark);
  for (let i = 0; i < 4; i++) {
    const bx = cx - 9 + i * 6;
    px.fill(bx, awY + 8, 5, 3, '#d9a45e');
    px.shadeOver(bx + 3, awY + 8, 2, 3, '#a97434');
    px.set(bx + 1, awY + 8, lighten('#d9a45e', 0.3));
  }
  windowPane(px, 6, wallY + 2, 8, 7, p);
  return { px, ax: cx, ay: h - 2, lights: [[cx, awY + 8], [10, wallY + 5]] };
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

// ------------------------------------------------------------------- registry

const BUILDERS = {
  house0: () => house(0), house1: () => house(1), house2: () => house(2),
  inn, bakery, well, cart, signpost, lamp, barrel, crate, haystack,
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
    metaCache.set(name, { ax: built.ax, ay: built.ay, w: built.px.w, h: built.px.h });
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
