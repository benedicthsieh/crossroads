// sprites.js — the cast.
//
// Every villager is drawn into an 22x24 pixel grid. The proportions are the
// whole trick: a head roughly a third of the body height, stubby legs, wide-set
// eyes, and a silhouette that stays readable when it's only ~50 screen pixels
// tall. That's the "They Are Billions" civilian read — tiny, chunky, legible in
// a crowd — with the head pushed a little larger for charm.

import { Pix, darken, lighten, mix } from './pixel.js';
import { STYLE, pal, styleKey } from './palette.js';

const W = 22, H = 24;
const CX = 10;      // centre column
const FEET = 20;    // baseline row: the sprite's contact point with the ground

// -------------------------------------------------------------- character kit

function luma(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Build the concrete colour set for one villager from indices into the palette. */
export function makeLook(seedish) {
  const p = pal();
  const r = (n, m) => Math.floor(hashf(seedish * 31 + n) * m);
  const [skin, skinS] = p.skin[r(1, p.skin.length)];
  const [cloth, clothS] = p.cloth[r(2, p.cloth.length)];

  // Trousers come from their own short list rather than the shirt palette, so
  // the legs never end up the same tone as the top.
  const trousers = [
    darken(p.wood, 0.12),
    darken(p.stoneDark, 0.18),
    darken(p.cloth[1][1], 0.1),
    darken(p.cloth[3][1], 0.2),
  ];
  const pants = trousers[r(3, trousers.length)];

  // Hair sits right against the face; nudge them apart if the tones collide.
  let hair = p.hair[r(4, p.hair.length)];
  if (Math.abs(luma(hair) - luma(skin)) < 28) hair = darken(hair, 0.25);

  return {
    skin, skinS,
    cloth, clothS,
    pants, pantsS: darken(pants, 0.16),
    hair,
    boots: darken(p.wood, 0.45),
    trim: lighten(cloth, 0.3),
  };
}

function hashf(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Role presets layered on top of a random look. */
export const ROLES = {
  farmer:   { hat: 'straw',  clothIdx: 2 },
  merchant: { hat: 'cap',    clothIdx: 0, apron: true },
  baker:    { hat: 'baker',  clothIdx: 7, apron: true },
  traveler: { hat: 'hood',   clothIdx: 6, pack: true },
  peddler:  { hat: 'wide',   clothIdx: 4, pack: true },
  villager: { hat: 'none',   clothIdx: 1 },
  matron:   { hat: 'kerchief', clothIdx: 4, dress: true },
  kid:      { hat: 'none',   clothIdx: 5, small: true },
  guard:    { hat: 'helm',   clothIdx: 6, guard: true },
};

export function roleLook(role, seed) {
  const p = pal();
  const preset = ROLES[role] || ROLES.villager;
  const look = makeLook(seed);
  if (preset.clothIdx != null) {
    const [c, cs] = p.cloth[preset.clothIdx];
    look.cloth = c;
    look.clothS = cs;
    look.trim = lighten(c, 0.3);
  }
  return { ...look, ...preset, role };
}

// ------------------------------------------------------------------- the body
//
// Row layout for an adult (FEET = 20 is the ground contact row):
//
//   hat             headTop-4 .. headTop-1
//   hair fringe     headTop
//   forehead        headTop+1
//   eyes            headTop+2 .. headTop+3
//   cheeks / blush  headTop+4
//   mouth           headTop+5
//   chin (shaded)   headTop+6
//   torso           5 rows, 5px wide, with a 1px arm down each side
//   legs            4 rows, the last 2 being boots
//
// Kids reuse the adult head on a shorter torso and legs — that ratio is what
// makes them read as children rather than as small adults.

function metrics(look, frame) {
  const small = !!look.small;
  const bob = frame === 1 || frame === 3 ? -1 : 0;   // hips rise at the passing pose
  const legH = small ? 3 : 4;
  const torsoH = small ? 4 : 5;
  const headH = 7;
  const legTop = FEET - (legH - 1);
  const hip = legTop + bob;                          // feet stay planted, legs stretch
  const torsoY = hip - torsoH;
  const headTop = torsoY - headH;
  return { small, bob, legH, torsoH, headH, hip, torsoY, headTop, feet: FEET };
}

function drawLegs(px, look, view, frame, m) {
  const { hip, feet } = m;
  const boot = look.boots;
  const bootS = darken(boot, 0.18);

  if (view === 'side') {
    // Contact poses at frames 0 and 2, legs together at the passing poses.
    const split = frame === 0 ? 2 : frame === 2 ? -2 : 0;
    const far = { x: CX - 1 - split, col: look.pantsS, boot: bootS };
    const near = { x: CX - 1 + split, col: look.pants, boot };
    for (const leg of [far, near]) {
      px.fill(leg.x, hip, 2, feet - hip + 1, leg.col);
      px.fill(leg.x, feet, 2, 1, leg.boot);          // a single row of shoe
      px.set(leg.x + 2, feet, leg.boot);             // toe, pointing forward
    }
    return;
  }

  // Front and back: one foot lifts clear of the ground on the passing poses.
  const lifted = frame === 1 ? 1 : frame === 3 ? 0 : -1;
  [[CX - 2, 0], [CX + 1, 1]].forEach(([x, i]) => {
    const bottom = feet - (i === lifted ? 1 : 0);
    px.fill(x, hip, 2, bottom - hip + 1, i === 1 ? look.pantsS : look.pants);
    px.fill(x, bottom, 2, 1, i === 1 ? bootS : boot);
  });
}

function drawTorso(px, look, view, m) {
  const p = pal();
  const { torsoY, torsoH, hip } = m;
  const tw = 5, tx = CX - 2;

  if (look.dress) {
    // Skirt flares out over the top of the legs.
    for (let j = 0; j < torsoH + 2; j++) {
      const wid = j < 2 ? 5 : 7;
      px.fill(CX - (wid >> 1), torsoY + j, wid, 1, look.cloth);
    }
    px.shadeOver(CX + 2, torsoY, 2, torsoH + 2, look.clothS);
  } else {
    px.fill(tx, torsoY, tw, torsoH, look.cloth);
    px.shadeOver(tx + tw - 1, torsoY, 1, torsoH, look.clothS);
  }

  // A darker row across the shoulders separates the head from the body.
  px.fill(tx, torsoY, tw, 1, darken(look.cloth, 0.2));
  if (look.apron) {
    px.fill(CX - 1, torsoY + 2, 3, torsoH - 2, p.white);
    px.shadeOver(CX + 1, torsoY + 2, 1, torsoH - 2, darken(p.white, 0.14));
  }
  if (look.guard) px.fill(CX, torsoY + 1, 1, torsoH - 1, look.trim);   // tabard stripe
  if (!look.dress) px.fill(tx, hip - 1, tw, 1, darken(look.pants, 0.35));  // belt
}

function drawArms(px, look, view, frame, m, carrying) {
  const { torsoY, torsoH } = m;
  // Sleeves are a shade off the shirt and the hands hang a pixel past the hem,
  // which is what makes 1px arms read as arms instead of as an outline.
  const sleeve = lighten(look.cloth, 0.12);
  const sleeveS = look.clothS;
  const len = torsoH - 1;

  if (view === 'side') {
    const swing = [1, 0, -1, 0][frame];
    const x = CX + 1 + (carrying ? 1 : Math.max(0, swing));
    const top = carrying ? torsoY : torsoY + 1 + (swing < 0 ? 1 : 0);
    px.fill(x, top, 2, len, sleeveS);
    px.fill(x, top + len, 2, 1, look.skin);          // hand
    return;
  }

  const swing = [0, 1, 0, -1][frame];
  const ltop = carrying ? torsoY : torsoY + 1 + swing;
  const rtop = carrying ? torsoY : torsoY + 1 - swing;
  px.fill(CX - 3, ltop, 1, len, sleeve);
  px.set(CX - 3, ltop + len, look.skin);
  px.fill(CX + 3, rtop, 1, len, sleeveS);
  px.set(CX + 3, rtop + len, look.skin);
}

function drawHead(px, look, view, m) {
  const p = pal();
  const { headTop, headH } = m;
  // The face runs a touch lighter than the body so 1px eyes stay legible on
  // every skin tone in the palette.
  const face = lighten(look.skin, 0.08);
  const shade = look.skinS;

  px.fill(CX - 3, headTop, 7, headH, face);
  px.clear(CX - 3, headTop); px.clear(CX + 3, headTop);
  px.clear(CX - 3, headTop + headH - 1); px.clear(CX + 3, headTop + headH - 1);
  px.shadeOver(CX + 3, headTop, 1, headH, shade);
  px.shadeOver(CX - 3, headTop + headH - 1, 7, 1, shade);

  const eye = mix(p.eye, look.skin, 0.1);
  const mouth = mix(p.mouth, look.skin, 0.3);
  const blush = '#e08a7a';
  const eyeY = headTop + 2;

  if (view === 'front') {
    px.fill(CX - 2, eyeY, 1, 2, eye);
    px.fill(CX + 2, eyeY, 1, 2, eye);
    px.set(CX, headTop + 5, mouth);
    px.set(CX - 3, headTop + 4, mix(face, blush, 0.5));
    px.set(CX + 3, headTop + 4, mix(shade, blush, 0.4));
  } else if (view === 'side') {
    px.fill(CX + 1, eyeY, 1, 2, eye);
    px.set(CX + 4, headTop + 3, face);               // nose
    px.set(CX + 3, headTop + 5, mouth);
    px.set(CX + 2, headTop + 4, mix(face, blush, 0.45));
  }
  // 'back' gets no face at all — the hair covers it.
}

function drawHair(px, look, view, m) {
  const p = pal();
  const { headTop, headH } = m;
  const h = look.hair;
  const hs = darken(h, 0.28);

  if (look.hat === 'hood') {
    // A hood frames the face and instantly reads as "not from here".
    const c = look.cloth;
    px.fill(CX - 3, headTop - 2, 7, 2, c);
    px.fill(CX - 4, headTop - 1, 9, 2, c);
    px.fill(CX - 4, headTop + 1, 1, headH - 2, c);
    px.fill(CX + 4, headTop + 1, 1, headH - 2, c);
    px.shadeOver(CX + 2, headTop - 2, 3, headH, darken(c, 0.22));
    if (view === 'back') px.fill(CX - 3, headTop, 7, headH - 1, c);
    return;
  }

  // Base hair: a cap over the skull and a fringe on the first face row. Kept
  // deliberately shallow — any more and the head reads as a dark helmet.
  px.fill(CX - 2, headTop - 2, 5, 1, h);
  px.fill(CX - 3, headTop - 1, 7, 1, h);
  // The fringe row runs darker than the rest of the hair: that hairline is what
  // separates hair from forehead even when the two tones are close in value.
  px.fill(CX - 3, headTop, 7, 1, hs);
  px.set(CX - 4, headTop, hs);
  px.set(CX - 4, headTop + 1, h);                    // one pixel of sideburn
  if (view !== 'side') {
    px.set(CX + 4, headTop, hs);
    px.set(CX + 4, headTop + 1, h);
  }
  px.shadeOver(CX + 2, headTop - 2, 3, 2, hs);

  if (view === 'back') {
    px.fill(CX - 3, headTop, 7, headH - 1, h);
    px.fill(CX - 4, headTop, 1, headH - 2, h);
    px.fill(CX + 4, headTop, 1, headH - 2, h);
    px.shadeOver(CX + 2, headTop, 3, headH - 1, hs);
  } else if (view === 'side') {
    px.fill(CX - 4, headTop, 2, headH - 1, h);       // mass at the back of the skull
    px.shadeOver(CX - 4, headTop, 1, headH - 1, hs);
  }
  if (look.dress) {                                  // longer hair
    px.fill(CX - 4, headTop + 1, 1, 5, h);
    px.fill(CX + 4, headTop + 1, 1, 5, h);
  }

  switch (look.hat) {
    case 'straw': {
      const s = p.wheat, sd = p.wheatDark;
      px.fill(CX - 5, headTop - 1, 11, 1, s);        // brim
      px.fill(CX - 4, headTop - 2, 9, 1, s);
      px.fill(CX - 2, headTop - 4, 5, 2, s);         // crown
      px.shadeOver(CX + 1, headTop - 4, 5, 4, sd);
      px.fill(CX - 2, headTop - 2, 5, 1, darken(s, 0.2));
      break;
    }
    case 'wide': {
      const s = darken(p.wood, 0.08);
      px.fill(CX - 5, headTop - 2, 11, 2, s);
      px.fill(CX - 2, headTop - 5, 5, 3, s);
      px.shadeOver(CX + 1, headTop - 5, 5, 6, darken(s, 0.24));
      px.fill(CX - 2, headTop - 3, 5, 1, look.trim);  // hatband
      break;
    }
    case 'cap': {
      px.fill(CX - 3, headTop - 2, 7, 2, look.cloth);
      px.fill(CX - 2, headTop - 3, 5, 1, look.cloth);
      px.shadeOver(CX + 2, headTop - 3, 2, 4, look.clothS);
      px.fill(CX + 3, headTop, 3, 1, darken(look.cloth, 0.12));  // peak
      break;
    }
    case 'baker': {
      const w = p.white;
      px.fill(CX - 3, headTop - 2, 7, 2, w);
      px.fill(CX - 2, headTop - 4, 5, 2, w);         // puff
      px.shadeOver(CX + 2, headTop - 4, 2, 5, darken(w, 0.12));
      break;
    }
    case 'kerchief': {
      px.fill(CX - 3, headTop - 2, 7, 2, look.cloth);
      px.fill(CX - 4, headTop - 1, 9, 2, look.cloth);
      px.fill(CX - 4, headTop + 1, 1, 2, look.cloth);
      px.fill(CX + 4, headTop + 1, 1, 2, look.cloth);
      px.shadeOver(CX + 2, headTop - 2, 3, 4, look.clothS);
      px.set(CX - 5, headTop + 1, look.cloth);       // knot
      break;
    }
    case 'helm': {
      const s = p.stone, sd = p.stoneDark;
      px.fill(CX - 3, headTop - 2, 7, 3, s);
      px.fill(CX - 4, headTop - 1, 9, 1, s);
      px.fill(CX - 4, headTop, 1, 3, s);             // cheek guards
      px.fill(CX + 4, headTop, 1, 3, s);
      px.shadeOver(CX + 2, headTop - 2, 3, 5, sd);
      if (view === 'front') px.fill(CX, headTop + 1, 1, 3, sd);   // nose guard
      px.fill(CX - 1, headTop - 4, 3, 2, look.trim); // plume
      break;
    }
    default:
      break;
  }
}

function drawPack(px, look, view, m) {
  const p = pal();
  const { torsoY, torsoH } = m;
  const c = darken(p.wood, 0.05);
  if (view === 'back') {
    px.fill(CX - 2, torsoY + 1, 5, torsoH - 1, c);
    px.shadeOver(CX + 1, torsoY + 1, 1, torsoH - 1, darken(c, 0.24));
    px.fill(CX - 2, torsoY + 3, 5, 1, darken(c, 0.3));
    px.fill(CX - 1, torsoY, 3, 1, p.wheat);          // bedroll poking out the top
  } else if (view === 'side') {
    px.fill(CX - 4, torsoY + 1, 3, torsoH - 1, c);
    px.shadeOver(CX - 4, torsoY + 1, 1, torsoH - 1, darken(c, 0.24));
  } else {
    px.fill(CX - 4, torsoY + 1, 1, torsoH - 2, c);   // just a strap from the front
    px.fill(CX + 4, torsoY + 1, 1, torsoH - 2, c);
  }
}

const ITEMS = {
  wheat: (px, p, x, y) => {
    px.fill(x - 2, y, 5, 3, p.wheat);
    px.shadeOver(x + 1, y, 2, 3, p.wheatDark);
    px.fill(x - 1, y - 1, 3, 1, p.wheat);
    px.set(x - 2, y + 3, p.wheatDark);
    px.set(x + 2, y + 3, p.wheatDark);
  },
  bread: (px, p, x, y) => {
    px.fill(x - 2, y, 5, 3, '#d9a45e');
    px.shadeOver(x + 1, y, 2, 3, '#a97434');
    px.set(x - 1, y, lighten('#d9a45e', 0.35));
    px.set(x + 1, y, lighten('#d9a45e', 0.2));
  },
  basket: (px, p, x, y) => {
    px.fill(x - 2, y, 5, 3, p.woodLight);
    px.shadeOver(x + 1, y, 2, 3, p.woodDark);
    px.fill(x - 2, y - 1, 5, 1, p.wood);
    px.fill(x - 1, y - 2, 3, 1, '#c26a5a');          // apples on top
  },
  water: (px, p, x, y) => {
    px.fill(x - 2, y, 5, 4, p.stone);
    px.shadeOver(x + 1, y, 2, 4, p.stoneDark);
    px.fill(x - 1, y - 1, 3, 1, p.water);
  },
  crate: (px, p, x, y) => {
    px.fill(x - 2, y - 1, 6, 5, p.wood);
    px.shadeOver(x + 2, y - 1, 2, 5, p.woodDark);
    px.fill(x - 2, y + 1, 6, 1, p.woodDark);
  },
  log: (px, p, x, y) => {
    // Two log ends stacked, pale end-grain against dark bark.
    const bark = darken(p.trunk, 0.1);
    px.fill(x - 2, y, 6, 2, bark);
    px.fill(x - 1, y + 2, 5, 2, bark);
    px.set(x - 1, y, mix(p.woodLight, p.wheat, 0.4));
    px.set(x + 2, y, mix(p.woodLight, p.wheat, 0.2));
    px.set(x, y + 2, mix(p.woodLight, p.wheat, 0.35));
  },
  coins: (px, p, x, y) => {
    px.fill(x - 2, y, 5, 4, '#8a6a4a');
    px.shadeOver(x + 1, y, 2, 4, '#5f452c');
    px.fill(x - 1, y - 1, 3, 1, p.coin);
  },
};

function drawCarry(px, look, view, m, item) {
  const fn = ITEMS[item];
  if (!fn) return;
  // Held out in front of the chest, low enough to leave the face clear.
  fn(px, pal(), view === 'side' ? CX + 3 : CX, m.torsoY + 2);
}

function drawTool(px, look, view, m, tool) {
  const p = pal();
  const { torsoY } = m;
  if (tool === 'scythe') {
    px.line(CX + 4, torsoY - 3, CX + 4, torsoY + 6, p.wood);
    px.line(CX + 4, torsoY - 3, CX + 7, torsoY - 1, p.stone);
    px.set(CX + 7, torsoY, p.stoneDark);
  } else if (tool === 'spear') {
    px.line(CX + 4, torsoY - 6, CX + 4, torsoY + 7, p.wood);
    px.fill(CX + 3, torsoY - 8, 3, 2, p.stone);
    px.set(CX + 4, torsoY - 9, p.stone);
  } else if (tool === 'axe') {
    px.line(CX + 4, torsoY - 2, CX + 4, torsoY + 6, p.wood);
    px.fill(CX + 3, torsoY - 4, 4, 2, p.stone);
    px.set(CX + 6, torsoY - 2, p.stoneDark);
  } else if (tool === 'broom') {
    px.line(CX + 4, torsoY - 2, CX + 4, torsoY + 5, p.woodLight);
    px.fill(CX + 3, torsoY + 5, 3, 3, p.wheatDark);
  }
}

/** Assemble one villager frame into a fresh pixel grid. */
function drawVillager(look, view, frame, opts = {}) {
  const px = new Pix(W, H);
  const m = metrics(look, frame);
  const carrying = !!opts.item;

  drawLegs(px, look, view, frame, m);
  drawTorso(px, look, view, m);
  drawArms(px, look, view, frame, m, carrying);
  drawHead(px, look, view, m);
  drawHair(px, look, view, m);
  if (look.pack) drawPack(px, look, view, m);
  if (opts.tool) drawTool(px, look, view, m, opts.tool);
  if (opts.item) drawCarry(px, look, view, m, opts.item);
  return px;
}


// ----------------------------------------------------------------- the cache
//
// Sprites are baked once per (look, view, frame, item, style) and reused. A busy
// scene ends up with a few hundred small canvases, which the GPU is happy with.

const cache = new Map();

function bake(px) {
  const p = pal();
  const skip = new Set([p.eye, p.mouth]);
  px.rimLight(STYLE.rim, skip);
  px.outline(STYLE.outline);
  return px.toCanvas(STYLE.scale);
}

/**
 * Get a baked villager frame.
 * Returned anchor is in *screen* pixels: where the sprite's feet sit.
 */
export function villagerFrame(look, view, frame, item, tool) {
  const key = `v|${styleKey()}|${look.key}|${view}|${frame}|${item || ''}|${tool || ''}`;
  let hit = cache.get(key);
  if (hit) return hit;

  // Remember which frames belong to this look, so retiring one traveller's
  // appearance doesn't mean throwing away everybody's. See `dropLooks`.
  if (look.sprites) look.sprites.push(key);
  const flip = view === 'left';
  const drawn = drawVillager(look, flip ? 'side' : view, frame, { item, tool });
  const px = flip ? drawn.flipped() : drawn;
  const canvas = bake(px);
  hit = {
    canvas,
    // Anchor: centre column, baseline row (+1 so the outline row is included).
    ax: (flip ? W - 1 - CX : CX) * STYLE.scale + STYLE.scale / 2,
    ay: (FEET + 2) * STYLE.scale,
  };
  cache.set(key, hit);
  return hit;
}

/** Small standalone icons for bubbles and floating popups. */
export function iconSprite(name, scale = STYLE.scale) {
  const key = `i|${styleKey()}|${name}|${scale}`;
  let hit = cache.get(key);
  if (hit) return hit;
  const p = pal();
  const px = new Pix(9, 9);
  switch (name) {
    case 'coin':
      px.disc(4, 4, 3.2, p.coin);
      px.shadeOver(5, 2, 4, 6, p.coinDark);
      px.set(3, 3, lighten(p.coin, 0.5));
      px.fill(4, 3, 1, 3, p.coinDark);
      break;
    case 'wheat':
      px.fill(4, 5, 1, 4, p.leaf[0]);                // stalk
      px.fill(3, 1, 3, 4, p.wheat);                  // ear
      px.shadeOver(5, 1, 1, 4, p.wheatDark);
      px.set(2, 2, p.wheat); px.set(6, 2, p.wheatDark);   // awns
      px.set(2, 4, p.wheat); px.set(6, 4, p.wheatDark);
      break;
    case 'bread': ITEMS.bread(px, p, 4, 3); break;
    case 'log':
      px.fill(1, 3, 7, 4, darken(p.trunk, 0.1));
      px.disc(2, 5, 1.6, mix(p.woodLight, p.wheat, 0.4));
      px.set(2, 5, darken(p.trunk, 0.2));
      px.shadeOver(1, 6, 7, 1, darken(p.trunk, 0.3));
      break;
    case 'basket':
      px.fill(2, 2, 1, 1, p.wood);                   // handle
      px.fill(4, 1, 1, 1, p.wood);
      px.fill(6, 2, 1, 1, p.wood);
      px.fill(1, 3, 7, 1, p.wood);                   // rim
      px.fill(2, 4, 5, 4, p.woodLight);
      px.shadeOver(5, 4, 2, 4, p.woodDark);
      px.fill(2, 6, 5, 1, p.woodDark);               // weave
      px.set(3, 2, '#c26a5a'); px.set(5, 2, p.wheat);  // produce peeking out
      break;
    case 'water': {
      // Droplet: reads better than a bucket at nine pixels across.
      const w = p.water;
      px.set(4, 1, w);
      px.fill(3, 2, 3, 1, w);
      px.fill(2, 3, 5, 4, w);
      px.fill(3, 7, 3, 1, w);
      px.shadeOver(5, 3, 2, 5, darken(w, 0.28));
      px.set(3, 3, lighten(w, 0.45));
      break;
    }
    case 'heart':
      px.fill(2, 2, 2, 2, '#e05a6a');
      px.fill(5, 2, 2, 2, '#e05a6a');
      px.fill(2, 3, 5, 2, '#e05a6a');
      px.fill(3, 5, 3, 1, '#e05a6a');
      px.fill(4, 6, 1, 1, '#c03a4a');
      px.set(2, 2, '#f08a94');
      break;
    case 'chat':
      // Three dots, spaced so the outline pass can't merge them into a bar.
      px.set(1, 4, p.eye);
      px.set(4, 4, p.eye);
      px.set(7, 4, p.eye);
      break;
    case 'spark':
      px.fill(4, 1, 1, 7, p.coin);
      px.fill(1, 4, 7, 1, p.coin);
      px.set(4, 4, lighten(p.coin, 0.6));
      break;
    default:
      px.disc(4, 4, 3, p.white);
  }
  px.outline(STYLE.outline === 'off' ? 'off' : 'hard', '#3a2a20', 0.5);
  hit = { canvas: px.toCanvas(scale), ax: 4 * scale, ay: 9 * scale };
  cache.set(key, hit);
  return hit;
}

// ------------------------------------------------------------------- critters

export function chickenFrame(frame, flip) {
  const key = `c|${styleKey()}|${frame}|${flip}`;
  let hit = cache.get(key);
  if (hit) return hit;
  const p = pal();
  let px = new Pix(11, 11);
  const body = p.white, bodyS = darken(p.white, 0.16);
  const peck = frame === 2;
  const bodyY = 3;
  px.fill(3, bodyY, 5, 4, body);
  px.shadeOver(6, bodyY, 2, 4, bodyS);
  px.fill(2, bodyY + 1, 1, 2, body);                 // tail
  // Head bobs down on the pecking frame.
  const hy = peck ? bodyY + 2 : bodyY - 2;
  px.fill(6, hy, 3, 2, body);
  px.set(9, hy + 1, '#e0a03c');                      // beak
  px.set(7, hy, '#d04a3a');                          // comb
  px.set(7, hy + 1, p.eye);
  const legY = bodyY + 4;
  const stride = frame === 1 ? 1 : 0;
  px.fill(4 - stride, legY, 1, 2, '#e0a03c');
  px.fill(6 + stride, legY, 1, 2, '#e0a03c');
  if (flip) px = px.flipped();
  px.rimLight(STYLE.rim * 0.6, new Set([p.eye]));
  px.outline(STYLE.outline);
  hit = { canvas: px.toCanvas(STYLE.scale), ax: 5 * STYLE.scale, ay: 8 * STYLE.scale };
  cache.set(key, hit);
  return hit;
}

export function dogFrame(frame, flip) {
  const key = `d|${styleKey()}|${frame}|${flip}`;
  let hit = cache.get(key);
  if (hit) return hit;
  const p = pal();
  let px = new Pix(16, 13);
  const c = '#c39558', cs = '#96693a';
  px.fill(3, 5, 7, 4, c);                            // body
  px.shadeOver(3, 7, 7, 2, cs);
  px.fill(9, 3, 4, 4, c);                            // head
  px.shadeOver(9, 6, 4, 1, cs);
  px.fill(12, 5, 3, 2, lighten(c, 0.18));            // snout
  px.set(14, 5, p.eye);                              // nose
  px.set(11, 4, p.eye);                              // eye
  px.fill(9, 2, 2, 2, cs);                           // floppy ear
  px.line(2, 5, 1, 2, c);                            // tail, up and curled
  px.set(2, 2, c);
  const s = frame % 2 ? 1 : 0;                       // trotting legs
  px.fill(4 - s, 9, 2, 3, cs);
  px.fill(8 + s, 9, 2, 3, c);
  if (flip) px = px.flipped();
  px.rimLight(STYLE.rim * 0.6, new Set([p.eye]));
  px.outline(STYLE.outline);
  hit = { canvas: px.toCanvas(STYLE.scale), ax: 8 * STYLE.scale, ay: 12 * STYLE.scale };
  cache.set(key, hit);
  return hit;
}

export function clearSpriteCache() {
  cache.clear();
}

/**
 * Forget the baked frames belonging to a few retired looks.
 *
 * Every distinct (role, seed) pair bakes its own walk cycle, and travellers
 * churn, so without eviction the cache grows until the tab dies. It used to be
 * emptied wholesale when it got large, which meant every villager and wagon on
 * screen re-baked in the same frame — a stall you could see, arriving every few
 * hundred people. Dropping only the looks nobody is wearing any more costs
 * nothing anybody notices.
 */
export function dropLooks(looks) {
  for (const look of looks) {
    if (!look.sprites) continue;
    for (const key of look.sprites) cache.delete(key);
    look.sprites.length = 0;
  }
}
