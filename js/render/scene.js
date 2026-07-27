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
import { buildScenery, clearedBy, clearAll, trampled } from './scenery.js';

// ------------------------------------------------------------- buildings

/**
 * Which of the three field sprites a plot is showing.
 *
 * Clearing runs 0 → 1 in the sim; the last stretch of it is drawn as ploughed
 * and sown rather than as scrub, so a field that is nearly ready looks nearly
 * ready. Once it is in production it stays at the ripe stage — the game has no
 * seasons, and a field that flickered between sown and harvested would read as
 * a bug rather than as a year passing.
 */
function fieldStage(b) {
  const g = b.growth || 0;
  if (g >= 1) return 2;
  return g < 0.55 ? 0 : 1;
}

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
    case 'tent':
      return [{ name: `tent${b.variant % 3}`, x: b.x, y: b.y, building: true }];
    case 'farm':
      // The sim's `growth` (0 while the plot is being cleared, 1 once it is in
      // production) picks the stage. Fields are drawn low in the sort order —
      // they are ground, and a villager standing in one should be in front of
      // the crop rather than behind them.
      return [{
        name: `field${fieldStage(b)}`,
        x: b.x,
        y: b.y,
        sortY: b.y - 10,
        building: true,
      }];
    case 'market':
      return [{ name: 'marketplace', x: b.x, y: b.y, building: true }];
    default:
      return [{ name: b.kind, x: b.x, y: b.y, building: true }];
  }
}

const depthOf = (q) => (q.sortY != null ? q.sortY : q.y);
// Fields are deliberately not in here: a field is ground, and ground does not
// cast a shadow onto itself.
const SHADOWED = /tree|pine|crag|house|inn|bakery|stall|well|cart|haystack|market|warehouse|lumber|smithy|wagon|tent|quarry/;

/**
 * Ground clutter: the scenery that stops being worth drawing when zoomed out.
 *
 * At whole-map zoom a bush is six screen pixels and a clump of flowers is four,
 * and there are eight thousand of them on a map this size. Drawing them costs
 * two thirds of the frame and buys a faint speckle over the ground the terrain
 * bake already mottles — the map is measurably *more* legible without them,
 * because what survives is the silhouettes that say forest, mountain and waste.
 *
 * Trees, pines, crags and cacti are not in here. They are what gives the ground
 * its texture at a distance, and dropping those would leave a flat painting.
 */
const CLUTTER = /^(bush|flowers|rock|reeds|deadbush|bones|wheat)/;

/** Below this zoom the clutter and the scenery shadows are skipped. */
const DETAIL_ZOOM = 0.7;

/**
 * What fraction of the *remaining* scenery to draw at a given zoom.
 *
 * Dropping the clutter is not enough on its own once the whole world fits on
 * screen: four and a half thousand trees, pines and crags are still four and a
 * half thousand draw calls, and at 0.24 zoom each one is eight pixels across.
 * A forest of eight-pixel blobs at full density is a green smear, and drawing
 * fewer than half of them is very close to indistinguishable — while the ones
 * that remain still say "trees" rather than "field".
 *
 * `q.lod` is a stable rank baked into each prop by `buildScenery`, so this
 * thins the *same* trees every frame. A per-frame coin toss would make the
 * whole map crawl. Ramping rather than stepping means the ones that come back
 * as you zoom in fade in a few at a time instead of all at once.
 */
function sceneryCoverage(zoom) {
  if (zoom >= DETAIL_ZOOM) return 1;
  return Math.max(0.42, (zoom - 0.2) / (DETAIL_ZOOM - 0.2));
}

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
    // Breadcrumbs and smoothed heading per caravan id. Renderer-only: never
    // serialised, never read by the sim. See the caravan section below.
    trails: new Map(),
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
   *
   * `buildScenery` is deterministic, so regrowing from scratch and re-culling
   * beats tracking which tree was removed by which shed. What it does *not*
   * beat is doing the expensive half twice: on a map this size the untouched
   * scenery is a hundred milliseconds' work and it cannot have changed, because
   * the only thing it depends on is the terrain. So it is grown once per world
   * and kept, and each rebuild is just the cull — which runs on every new
   * building, and used to be what the frame after "a shed went up" was
   * entirely spent on.
   */
  r.rebuildScenery = (st) => {
    if (r.grownFor !== st.terrain.seed) {
      r.grown = buildScenery(st.terrain);
      r.grownFor = st.terrain.seed;
    }
    const boxes = [];
    for (const town of st.towns) {
      for (const b of town.buildings) {
        const props = buildingProps(b);
        boxes.push(clearedBy(b.x, b.y, props[props.length - 1].name));
      }
    }
    r.scenery = clearAll(r.grown, boxes);
  };

  /** Rebuild everything that depends on the *world* (a new or loaded game). */
  r.rebuildWorld = (st) => {
    r.rebuildScenery(st);
    r.resort(st);
    r.trails.clear();
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
      } else if (e.type === 'field') {
        // A plot moved on a stage: different sprite, and the scenery it clears
        // changes with it. No sparkle — this is slow work, not an event.
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

  // Every distinct (role, seed) pair bakes its own set of walk frames, and both
  // caravans and residents churn — a long session gets through hundreds of them,
  // none of which the caches would ever have dropped. Flushing wholesale when
  // the population of *looks* gets large is blunt, but it is one hitch every few
  // thousand people rather than a canvas cache that grows until the tab dies.
  const LOOK_BUDGET = 220;

  r.lookFor = (t) => {
    const key = `${t.role}:${t.seed}`;
    let look = r.looks.get(key);
    if (!look) {
      if (r.looks.size >= LOOK_BUDGET) {
        r.looks.clear();
        clearSpriteCache();
      }
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

function drawStatic(g, r, cam, q, shadow) {
  drawProp(g, r, cam, q.name, q.x, q.y, shadow);
}

function viewOf(t) {
  if (Math.abs(t.vx) > Math.abs(t.vy) * 1.15) return t.vx > 0 ? 'side' : 'left';
  return t.vy > 0 ? 'front' : 'back';
}

/**
 * `viewOf` with hysteresis: it takes a clearer signal to *leave* the current
 * view than to stay in it.
 *
 * Smoothing the heading gets rid of most of the sprite flicker, but a caravan
 * travelling almost exactly diagonally sits right on the boundary between two
 * views and will still trade back and forth across it. Widening the band you
 * have to cross to switch fixes that without adding the lag that more
 * smoothing would. A reversal along the *same* axis (side to left) is a real
 * change of direction and is never held back.
 */
function steadyView(vx, vy, current) {
  const ax = Math.abs(vx), ay = Math.abs(vy);
  const horizontalNow = current === 'side' || current === 'left';
  const bias = current ? (horizontalNow ? 1 / 1.4 : 1.4) : 1.15;
  return ax > ay * bias ? (vx > 0 ? 'side' : 'left') : (vy > 0 ? 'front' : 'back');
}

function drawPerson(g, r, cam, t, id) {
  const look = r.lookFor(t);
  const moving = t.rest <= 0;
  const frame = moving
    ? Math.floor(t.walked / 3.2) % 4
    : (Math.floor(t.walked * 2.2) % 2 === 0 ? 0 : 2);
  // `t.view` is set for caravan drovers, which have a hysteresis-filtered view
  // to share; residents just resolve their own from their heading.
  const spr = villagerFrame(look, t.view || viewOf(t), frame, t.carry, null);
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
// souls, strung out along the road behind the lead, plus a drover or two
// walking beside them. The sim never knows about any of that — it stores one
// position and one heading, and everything below is derived at draw time.
//
// Two things have to be smoothed out of the sim's heading before it is usable
// for drawing, and both were badly visible before they were:
//
//   1. A caravan steers at successive *tile centres*, so its raw heading snaps
//      between eight compass directions several times a second. Fed straight to
//      `viewOf` that flips the wagon sprite between side, front and back on
//      almost every frame — the "twitch".
//   2. Tail wagons laid out along the *current* heading swing around the lead
//      like a rigid arm every time it changes. A train should follow the ground
//      the lead actually covered.
//
// Both are fixed with one piece of renderer-owned state: a breadcrumb trail per
// caravan, keyed by id, holding recent positions and a smoothed heading. It is
// never serialised and the sim cannot see it, which is exactly where this kind
// of thing belongs.

/**
 * Gap between wagons in a train, in world units. An ox and its wagon are about
 * 42 units end to end, so anything much under this parks one team inside the
 * tailgate of the wagon in front.
 */
const WAGON_GAP = 44;

/** World units between recorded breadcrumbs, and how many to keep. */
const TRAIL_STEP = 6;
const TRAIL_POINTS = 26;

/** Seconds-ish constant for heading smoothing. Higher = snappier. */
const HEADING_LERP = 5;

/** How far ahead along the trail a tail wagon looks to work out which way it faces. */
const TAIL_BASELINE = 26;

/**
 * A trail for a caravan we have not seen before.
 *
 * Pre-filled with breadcrumbs running back along the current heading rather
 * than started empty. An empty trail means `backAlong` has nothing to answer
 * with for the first couple of seconds, the tail falls back to a straight line
 * behind the lead, and then *snaps* onto the real path once enough crumbs
 * exist — which is a lurch exactly where a caravan is most likely to be
 * noticed, at the moment it appears.
 */
function makeTrail(c) {
  const len = Math.hypot(c.vx, c.vy) || 1;
  const hx = c.vx / len, hy = c.vy / len;
  const pts = [];
  for (let i = 0; i < TRAIL_POINTS; i++) {
    pts.push({ x: c.x - hx * TRAIL_STEP * i, y: c.y - hy * TRAIL_STEP * i });
  }
  // `heads[i]` is wagon i's own smoothed heading. Index 0 is the lead's.
  return { pts, hx, hy, heads: [] };
}

/**
 * Walk `dist` world units back along a caravan's trail.
 * Returns null while the trail is still shorter than that — a caravan that has
 * only just spawned has nowhere to put its tail yet.
 */
function backAlong(trail, c, dist) {
  if (!trail) return null;
  let remaining = dist;
  let px = c.x, py = c.y;
  for (const p of trail.pts) {
    const seg = Math.hypot(p.x - px, p.y - py);
    if (seg >= remaining) {
      const f = seg > 0 ? remaining / seg : 0;
      return { x: px + (p.x - px) * f, y: py + (p.y - py) * f };
    }
    remaining -= seg;
    px = p.x;
    py = p.y;
  }
  return null;
}

/**
 * Where each piece of a caravan sits. Returns world-space items with their own
 * depth key so they sort correctly against buildings and everybody else.
 */
export function caravanParts(c, trail) {
  const frame = Math.floor(c.walked / 5) % 2;
  const variant = c.seed % 3;
  const hx = trail ? trail.hx : c.vx;
  const hy = trail ? trail.hy : c.vy;
  const parts = [];

  for (let i = 0; i < c.wagons; i++) {
    const back = WAGON_GAP * i;
    const at = i === 0
      ? { x: c.x, y: c.y }
      : backAlong(trail, c, back) || { x: c.x - hx * back, y: c.y - hy * back };
    // Each wagon faces along the trail *where it is*, not where the lead is, so
    // a train rounding a bend bends with it. The heading is the smoothed one
    // kept by `tickCaravans`, not a direction read off two trail points.
    const h = trail && trail.heads[i];
    const view = (h && h.view) || viewOf({ vx: hx, vy: hy });
    parts.push({
      kind: 'wagon',
      name: `wagon${(variant + i) % 3}${view}${frame}`,
      x: at.x,
      y: at.y,
    });
  }

  // Drovers: one alongside the lead team, one bringing up the rear. Two is
  // enough to say "people" — drawing all twenty-five souls is exactly the thing
  // this whole redesign exists to stop doing.
  const px = -hy, py = hx;                    // perpendicular to the heading
  const leadView = (trail && trail.heads[0] && trail.heads[0].view)
    || viewOf({ vx: hx, vy: hy });
  const walkers = Math.min(2, c.wagons);
  for (let i = 0; i < walkers; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const back = WAGON_GAP * i * (c.wagons - 1) + 14;
    const at = backAlong(trail, c, back) || { x: c.x - hx * back, y: c.y - hy * back };
    parts.push({
      kind: 'drover',
      seed: c.seed + i * 977,
      role: i === 0 ? 'peddler' : 'guard',
      x: at.x + px * side * 12,
      y: at.y + py * side * 12,
      vx: hx,
      vy: hy,
      view: leadView,
      walked: c.walked + i * 7,
      rest: c.rest,
      carry: i === 0 ? c.carry : null,
    });
  }
  return parts;
}

function drawCaravan(g, r, cam, c) {
  // Sort within the train as well as between trains. A caravan heading *down*
  // the screen has its tail wagons further up and therefore behind it, and
  // drawing them in train order would lay the back of the queue over the front.
  const parts = caravanParts(c, r.trails.get(c.id)).sort((a, b) => a.y - b.y);
  for (const part of parts) {
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

/**
 * Advance every caravan's breadcrumb trail and smoothed heading.
 *
 * Runs on wall-clock `dt` alongside the other renderer ticks, and only while
 * the game is running — a paused caravan should not keep laying breadcrumbs
 * from a position it is no longer leaving.
 */
export function tickCaravans(r, state, dt) {
  const live = new Set();
  const k = Math.min(1, dt * HEADING_LERP);

  for (const c of state.caravans) {
    live.add(c.id);
    let t = r.trails.get(c.id);
    if (!t) { t = makeTrail(c); r.trails.set(c.id, t); }

    const len = Math.hypot(c.vx, c.vy);
    if (len > 0) {
      t.hx += (c.vx / len - t.hx) * k;
      t.hy += (c.vy / len - t.hy) * k;
      const n = Math.hypot(t.hx, t.hy);
      if (n > 0.0001) { t.hx /= n; t.hy /= n; }
    }

    const head = t.pts[0];
    const dx = c.x - head.x, dy = c.y - head.y;
    const gone = Math.hypot(dx, dy);

    // Doubling back invalidates the trail. A caravan turned away from a full
    // town retraces its own steps, and the tail would then be laid out along
    // ground the caravan is about to walk over — wagons drawn *in front* of the
    // team pulling them. Start the trail again from here.
    if (len > 0 && gone > 2 && (dx * c.vx + dy * c.vy) / (gone * len) < -0.3) {
      r.trails.set(c.id, makeTrail(c));
      continue;
    }

    if (gone >= TRAIL_STEP) {
      t.pts.unshift({ x: c.x, y: c.y });
      if (t.pts.length > TRAIL_POINTS) t.pts.length = TRAIL_POINTS;
    }

    // Each wagon's own heading, smoothed on the same clock as the lead's. The
    // trail records where the caravan actually walked, and where it actually
    // walked zigzags — it steers at tile centres — so a direction read straight
    // off two trail points is as jittery as the raw sim heading was.
    const lead = t.heads[0] || (t.heads[0] = {});
    lead.hx = t.hx;
    lead.hy = t.hy;
    lead.view = steadyView(t.hx, t.hy, lead.view);

    for (let i = 1; i < c.wagons; i++) {
      const back = WAGON_GAP * i;
      const at = backAlong(t, c, back);
      const ahead = backAlong(t, c, back - TAIL_BASELINE);
      if (!at || !ahead) continue;
      const dx = ahead.x - at.x, dy = ahead.y - at.y;
      const n = Math.hypot(dx, dy);
      if (n < 0.001) continue;
      const want = { hx: dx / n, hy: dy / n };
      const w = t.heads[i] || (t.heads[i] = { ...want });
      w.hx += (want.hx - w.hx) * k;
      w.hy += (want.hy - w.hy) * k;
      const m = Math.hypot(w.hx, w.hy);
      if (m > 0.0001) { w.hx /= m; w.hy /= m; }
      w.view = steadyView(w.hx, w.hy, w.view);
    }
  }

  // Caravans that have settled or left the map take their trail with them.
  for (const id of r.trails.keys()) if (!live.has(id)) r.trails.delete(id);
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

/** First index in the depth-sorted static list at or past `depth`. */
function lowerBound(items, depth) {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (depthOf(items[mid]) < depth) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

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

  // `r.statics` is sorted by depth, so the slice that can possibly be on screen
  // is a contiguous run and can be found without walking the whole list. That
  // matters: the list is thirteen thousand long on a full map, and when the
  // camera is down at street level all but a few dozen of them are somewhere
  // else entirely.
  const detail = STYLE.zoom >= DETAIL_ZOOM;
  const coverage = sceneryCoverage(STYLE.zoom);
  const first = lowerBound(r.statics, b.y0 - 60);
  const last = lowerBound(r.statics, b.y1 + 60);

  let i = first, j = 0;
  while (i < last || j < dyn.length) {
    const takeStatic = j >= dyn.length
      || (i < last && depthOf(r.statics[i]) <= dyn[j].y);
    if (takeStatic) {
      const q = r.statics[i++];
      if (q.x < b.x0 || q.x > b.x1 || q.y < b.y0 || q.y > b.y1 + 60) continue;
      if (!detail && !q.building) {
        if (CLUTTER.test(q.name)) continue;
        if (q.lod > coverage) continue;
      }
      // Scenery on a worn tile isn't there any more — the road went through it.
      if (!q.building && trampled(state, q)) continue;
      drawStatic(g, r, cam, q, detail || q.building);
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
