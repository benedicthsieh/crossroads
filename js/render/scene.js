// scene.js — everything the player actually sees.
//
// This is the only file that knows both halves of the program. It reads game
// state and writes pixels; it never writes game state back. That one-way rule
// is what makes the sim snapshottable, and it's worth defending — if a
// traveller's walk-cycle frame ever ends up living in here as mutable state,
// two clients restoring the same save start to drift.
//
// Draw order per frame:
//   1. terrain      (one blit of a slice of the baked map)
//   2. roads        (one blit of the incremental road layer)
//   3. world        (scenery, buildings and people, depth-sorted together)
//   4. effects      (trade popups, sparkles, smoke)
//   5. night wash + lamplight
//   6. labels and the follow ring

import { STYLE, pal } from '../palette.js';
import { villagerFrame } from '../sprites.js';
import { prop, propMeta, propLights, clearPropCache } from '../props.js';
import { clearSpriteCache, roleLook } from '../sprites.js';
import { updateFx, drawFx, smoke, popIcon, sparkle, clearFx } from '../fx.js';
import { WORLD } from '../sim/terrain.js';
import { toScreen, viewBounds } from './camera.js';
import { bakeTerrain } from './terrainPaint.js';
import { createRoadLayer, updateRoadLayer, invalidateRoadColors } from './roadPaint.js';
import { buildScenery, clearAround, trampled } from './scenery.js';

// ------------------------------------------------------------- buildings

/** One town building becomes one or two props. Stalls are two by design. */
function buildingProps(b) {
  switch (b.kind) {
    case 'stall': {
      const v = b.variant % 3;
      // Drawn in two passes with the stallholder's space between them, so the
      // awning sits behind anyone standing at the counter and the counter sits
      // in front. `sortY` moves the depth key without moving the sprite.
      return [
        { name: `stall${v}back`, x: b.x, y: b.y, sortY: b.y - 14, building: true },
        { name: `stall${v}front`, x: b.x, y: b.y, sortY: b.y + 1, building: true },
      ];
    }
    case 'house':
      return [{ name: `house${b.variant % 3}`, x: b.x, y: b.y, building: true }];
    case 'market':
      return [{ name: 'marketplace', x: b.x, y: b.y, building: true }];
    default:
      return [{ name: b.kind, x: b.x, y: b.y, building: true }];
  }
}

const depthOf = (q) => (q.sortY != null ? q.sortY : q.y);
const SHADOWED = /tree|pine|crag|house|inn|bakery|stall|well|cart|haystack|market|warehouse|lumber|smithy|wagon/;

// ------------------------------------------------------------ the renderer

export function createRenderer(state) {
  const r = {
    terrain: null,
    roads: createRoadLayer(),
    scenery: [],
    statics: [],
    lights: [],
    shadowCache: new Map(),
    looks: new Map(),
    smokeT: 0,
    follow: null,
  };

  /** Rebuild everything that depends on the baked pixel scale or the palette. */
  r.rebakeArt = (st) => {
    clearSpriteCache();
    clearPropCache();
    r.shadowCache.clear();
    r.looks.clear();
    r.terrain = bakeTerrain(st.terrain);
    invalidateRoadColors(r.roads);
    updateRoadLayer(r.roads, st, true);
  };

  /**
   * Regrow the scenery and clear it out of the towns.
   * `buildScenery` is deterministic, so doing this from scratch after each new
   * building is both correct and cheap enough — it beats tracking which tree
   * was removed by which shed.
   */
  r.rebuildScenery = (st) => {
    r.scenery = buildScenery(st.terrain);
    for (const town of st.towns) {
      for (const b of town.buildings) {
        const props = buildingProps(b);
        r.scenery = clearAround(r.scenery, b.x, b.y, props[props.length - 1].name);
      }
    }
  };

  /** Rebuild everything that depends on the *world* (a new or loaded game). */
  r.rebuildWorld = (st) => {
    r.rebuildScenery(st);
    r.resort(st);
    clearFx();
    r.follow = null;
  };

  /** Merge scenery and buildings into one depth-sorted list. */
  r.resort = (st) => {
    const items = [...r.scenery];
    for (const town of st.towns) {
      for (const b of town.buildings) items.push(...buildingProps(b));
    }
    items.sort((a, b) => depthOf(a) - depthOf(b));
    r.statics = items;

    const lights = [];
    for (const town of st.towns) {
      for (const b of town.buildings) {
        for (const q of buildingProps(b)) {
          for (const [dx, dy] of propLights(q.name)) {
            // Street lamps throw a wide pool; lit windows stay tight to the
            // glass or the whole facade washes out.
            lights.push({ x: q.x + dx, y: q.y + dy, r: q.name === 'lamp' ? 46 : 22 });
          }
        }
      }
    }
    r.lights = lights;
  };

  /** Drain the sim's event queue into visual effects. */
  r.consumeEvents = (st) => {
    if (!st.events.length) return;
    let structural = false;
    for (const e of st.events) {
      if (e.type === 'trade') {
        popIcon(e.x - 5, e.y - 18, e.give, -6);
        popIcon(e.x + 5, e.y - 18, e.get, 6);
        sparkle(e.x, e.y - 14, 7);
      } else if (e.type === 'built') {
        sparkle(e.x, e.y - 8, 12);
        structural = true;
      } else if (e.type === 'founded') {
        sparkle(e.x, e.y - 6, 20);
      } else if (e.type === 'settled') {
        // A caravan unloading for good. Worth marking: it is the moment the
        // player's attention should move from the road to the town.
        sparkle(e.x, e.y - 10, 14);
        popIcon(e.x, e.y - 22, 'basket', 0);
      }
    }
    st.events.length = 0;
    if (structural) {
      r.rebuildScenery(st);
      r.resort(st);
    }
  };

  r.lookFor = (t) => {
    const key = `${t.role}:${t.seed}`;
    let look = r.looks.get(key);
    if (!look) {
      look = roleLook(t.role, t.seed);
      look.key = key;
      r.looks.set(key, look);
    }
    return look;
  };

  return r;
}

// --------------------------------------------------------------- shadows

function shadowSprite(r, rx) {
  const key = `${STYLE.shadow}|${rx}`;
  const hit = r.shadowCache.get(key);
  if (hit) return hit;
  const soft = STYLE.shadow === 'soft';
  const ry = Math.max(1, rx * (soft ? 0.42 : 0.3));
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(rx * 2) + 4;
  cv.height = Math.ceil(ry * 2) + 4;
  const c = cv.getContext('2d');
  const cx = cv.width / 2, cy = cv.height / 2;
  if (soft) {
    const grad = c.createRadialGradient(cx, cy, 0, cx, cy, rx);
    grad.addColorStop(0, 'rgba(30,22,16,0.32)');
    grad.addColorStop(0.55, 'rgba(30,22,16,0.19)');
    grad.addColorStop(1, 'rgba(30,22,16,0)');
    c.fillStyle = grad;
    c.translate(cx, cy);
    c.scale(1, ry / rx);
    c.translate(-cx, -cy);
    c.fillRect(cx - rx, cy - rx, rx * 2, rx * 2);
  } else {
    c.fillStyle = 'rgba(30,22,16,0.26)';
    c.beginPath();
    c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    c.fill();
  }
  r.shadowCache.set(key, cv);
  return cv;
}

function shadowFor(g, r, sx, sy, w) {
  if (STYLE.shadow === 'off') return;
  const cv = shadowSprite(r, Math.max(2, Math.round(w * 0.34)));
  g.drawImage(cv, Math.round(sx - cv.width / 2), Math.round(sy - cv.height / 2 - STYLE.scale * 0.5));
}

// ------------------------------------------------------------------ pieces

/**
 * Draw a prop at its world position.
 *
 * `dw`/`dh` come from the prop's unit shrink (see `props.js`) and are not the
 * canvas's own size, so this must always be the nine-argument drawImage.
 */
function drawProp(g, r, cam, name, wx, wy, shadow = true) {
  const spr = prop(name);
  const [sx, sy] = toScreen(cam, wx, wy);
  if (shadow && SHADOWED.test(name)) shadowFor(g, r, sx, sy, spr.dw * 0.55);
  g.drawImage(spr.canvas, Math.round(sx - spr.ax), Math.round(sy - spr.ay), spr.dw, spr.dh);
}

function drawStatic(g, r, cam, q) {
  drawProp(g, r, cam, q.name, q.x, q.y);
}

function viewOf(t) {
  if (Math.abs(t.vx) > Math.abs(t.vy) * 1.15) return t.vx > 0 ? 'side' : 'left';
  return t.vy > 0 ? 'front' : 'back';
}

function drawPerson(g, r, cam, t, id) {
  const look = r.lookFor(t);
  const moving = t.rest <= 0;
  const frame = moving
    ? Math.floor(t.walked / 3.2) % 4
    : (Math.floor(t.walked * 2.2) % 2 === 0 ? 0 : 2);
  const spr = villagerFrame(look, viewOf(t), frame, t.carry, null);
  const [sx, sy] = toScreen(cam, t.x, t.y);
  shadowFor(g, r, sx, sy, 8 * STYLE.scale);
  g.drawImage(spr.canvas, Math.round(sx - spr.ax), Math.round(sy - spr.ay));

  if (id != null && r.follow === id) followRing(g, sx, sy, 6);
  if (STYLE.labels) {
    label(g, t.role, sx, sy - spr.canvas.height - 3 * STYLE.scale);
  }
}

function followRing(g, sx, sy, rx) {
  g.strokeStyle = pal().coin;
  g.lineWidth = Math.max(1, STYLE.scale / 2);
  g.beginPath();
  g.ellipse(sx, sy - STYLE.scale * 0.5, rx * STYLE.scale, rx * 0.4 * STYLE.scale, 0, 0, Math.PI * 2);
  g.stroke();
}

// ------------------------------------------------------------------ caravans
//
// A caravan is one object in the sim and several on screen: a wagon per five
// souls, strung out along the road behind the lead, plus a couple of drovers
// walking beside them. The sim never knows about any of that — it stores a
// position and a heading, and the layout below is derived from the caravan's
// seed, so it is stable across a save and identical on two clients.

/** Gap between wagons in a train, in world units. */
const WAGON_GAP = 30;

/**
 * Where each piece of a caravan sits, relative to the caravan's own position.
 * Returns world-space items with their own depth key so they sort correctly
 * against buildings and everybody else.
 */
export function caravanParts(c) {
  const view = viewOf(c);
  const frame = Math.floor(c.walked / 5) % 2;
  const variant = c.seed % 3;
  // Heading, normalised. A stopped caravan keeps whatever it last had.
  const len = Math.hypot(c.vx, c.vy) || 1;
  const hx = c.vx / len, hy = c.vy / len;
  const parts = [];

  for (let i = 0; i < c.wagons; i++) {
    parts.push({
      kind: 'wagon',
      name: `wagon${(variant + i) % 3}${view}${frame}`,
      x: c.x - hx * WAGON_GAP * i,
      y: c.y - hy * WAGON_GAP * i,
    });
  }

  // Drovers: one alongside the lead team, one bringing up the rear. Two is
  // enough to say "people" — drawing all twenty-five souls is exactly the thing
  // this whole redesign exists to stop doing.
  const px = -hy, py = hx;                    // perpendicular to the heading
  const walkers = Math.min(2, c.wagons);
  for (let i = 0; i < walkers; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const back = WAGON_GAP * (i * (c.wagons - 1) + 0.35);
    parts.push({
      kind: 'drover',
      seed: c.seed + i * 977,
      role: i === 0 ? 'peddler' : 'guard',
      x: c.x - hx * back + px * side * 11,
      y: c.y - hy * back + py * side * 11,
      vx: hx,
      vy: hy,
      walked: c.walked + i * 7,
      rest: c.rest,
      carry: i === 0 ? c.carry : null,
    });
  }
  return parts;
}

function drawCaravan(g, r, cam, c) {
  for (const part of caravanParts(c)) {
    if (part.kind === 'wagon') drawProp(g, r, cam, part.name, part.x, part.y);
    else drawPerson(g, r, cam, part, null);
  }
  if (r.follow === c.id) {
    const [sx, sy] = toScreen(cam, c.x, c.y);
    followRing(g, sx, sy, 13);
  }
  if (STYLE.labels) {
    const [sx, sy] = toScreen(cam, c.x, c.y);
    label(g, `${c.souls} souls`, sx, sy - 26 * STYLE.scale);
  }
}

function label(g, text, sx, sy) {
  g.font = `${Math.max(9, 3.2 * STYLE.scale)}px ui-monospace, monospace`;
  g.textAlign = 'center';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(24,18,14,0.85)';
  g.strokeText(text, sx, sy);
  g.fillStyle = '#f6efe2';
  g.fillText(text, sx, sy);
}

/** 0 = full night, 1 = full day. */
export function daylight() {
  const t = STYLE.timeOfDay;
  const up = Math.min(1, Math.max(0, (t - 0.18) / 0.14));
  const down = Math.min(1, Math.max(0, (0.9 - t) / 0.14));
  return Math.min(up, down);
}

function drawNight(g, r, cam) {
  const p = pal();
  const dark = (1 - daylight()) * p.nightStrength;
  if (dark <= 0.01) return;
  const v = cam.view;

  g.fillStyle = p.night;
  g.globalAlpha = dark;
  g.fillRect(0, 0, v.w, v.h);
  g.globalAlpha = 1;

  // `lighter` on top of the wash reads like lamplight rather than a hole cut
  // in the darkness.
  g.globalCompositeOperation = 'lighter';
  const s = STYLE.scale;
  for (const L of r.lights) {
    const [sx, sy] = toScreen(cam, L.x, L.y);
    const rad = L.r * s * 0.55;
    if (sx < -rad || sy < -rad || sx > v.w + rad || sy > v.h + rad) continue;
    const grad = g.createRadialGradient(sx, sy, 0, sx, sy, rad);
    const a = 0.5 * dark;
    grad.addColorStop(0, `rgba(255,215,140,${a})`);
    grad.addColorStop(0.45, `rgba(240,180,90,${a * 0.4})`);
    grad.addColorStop(1, 'rgba(240,180,90,0)');
    g.fillStyle = grad;
    g.fillRect(sx - rad, sy - rad, rad * 2, rad * 2);
  }
  g.globalCompositeOperation = 'source-over';
}

/** Chimneys puff. Purely decorative, and it does a lot for "inhabited". */
export function tickSmoke(r, state, dt) {
  r.smokeT -= dt;
  if (r.smokeT > 0) return;
  r.smokeT = 0.6 + Math.random() * 0.6;
  for (const town of state.towns) {
    for (const b of town.buildings) {
      for (const q of buildingProps(b)) {
        const meta = propMeta(q.name);
        if (!meta.chimney) continue;
        const working = b.kind === 'bakery' || meta.forge;
        if (!working && Math.random() > 0.4) continue;
        smoke(q.x + meta.chimney[0] + (Math.random() - 0.5) * 2, q.y + meta.chimney[1]);
      }
    }
  }
}

// -------------------------------------------------------------------- draw

export function drawScene(g, r, cam, state) {
  const p = pal();
  const v = cam.view;
  const s = STYLE.scale;

  g.fillStyle = p.night;
  g.fillRect(0, 0, v.w, v.h);

  // Terrain and roads: one blit each, of only the slice that's on screen.
  const b = viewBounds(cam, 4);
  const sx0 = Math.max(0, Math.floor(b.x0));
  const sy0 = Math.max(0, Math.floor(b.y0));
  const sx1 = Math.min(WORLD.w, Math.ceil(b.x1));
  const sy1 = Math.min(WORLD.h, Math.ceil(b.y1));
  if (sx1 > sx0 && sy1 > sy0) {
    const [dx, dy] = toScreen(cam, sx0, sy0);
    const dw = (sx1 - sx0) * s;
    const dh = (sy1 - sy0) * s;
    g.drawImage(r.terrain, sx0, sy0, sx1 - sx0, sy1 - sy0, Math.round(dx), Math.round(dy), dw, dh);
    g.drawImage(r.roads.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, Math.round(dx), Math.round(dy), dw, dh);
  }

  // Depth-sorted merge of the static world and everything moving through it.
  // Caravans are sorted by their lead position rather than per wagon: a train
  // strung out along a road is one object as far as the player is concerned,
  // and splitting it lets a building slot between two of its own wagons.
  const inView = (o, pad = 0) => o.x > b.x0 - pad && o.x < b.x1 + pad
    && o.y > b.y0 - pad && o.y < b.y1 + pad;
  const dyn = [];
  for (const c of state.caravans) if (inView(c, WAGON_GAP * 3)) dyn.push(c);
  for (const p of state.residents) if (inView(p)) dyn.push(p);
  dyn.sort((a, c) => a.y - c.y);

  let i = 0, j = 0;
  while (i < r.statics.length || j < dyn.length) {
    const takeStatic = j >= dyn.length
      || (i < r.statics.length && depthOf(r.statics[i]) <= dyn[j].y);
    if (takeStatic) {
      const q = r.statics[i++];
      if (q.x < b.x0 || q.x > b.x1 || q.y < b.y0 || q.y > b.y1 + 60) continue;
      // Scenery on a worn tile isn't there any more — the road went through it.
      if (!q.building && trampled(state, q)) continue;
      drawStatic(g, r, cam, q);
    } else {
      const m = dyn[j++];
      if (m.wagons) drawCaravan(g, r, cam, m);
      else drawPerson(g, r, cam, m, m.id);
    }
  }

  drawFx(g, (wx, wy) => toScreen(cam, wx, wy), s);
  drawNight(g, r, cam);
}

export { updateFx, updateRoadLayer };
