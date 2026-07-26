// game.js — camera, render loop, lighting, and the control panel wiring.
//
// Render order per frame:
//   1. baked terrain (one blit)
//   2. everything else, depth-sorted by its ground contact point
//   3. effects (popups, sparkles, smoke)
//   4. night wash + additive lamplight
//   5. labels / selection

import { STYLE, pal, PALETTES } from '../../js/palette.js';
import { villagerFrame, chickenFrame, dogFrame, clearSpriteCache } from '../../js/sprites.js';
import { prop, propMeta, clearPropCache } from '../../js/props.js';
import {
  WORLD, PROPS, POI, scatter, bakeGround, collectLights,
} from './world.js';
import {
  buildCast, buildCritters, spawnTraveler, stats, Actor,
} from './agents.js';
import { updateFx, drawFx, drawBubble, smoke, clearFx } from '../../js/fx.js';

const canvas = document.getElementById('view');
const g = canvas.getContext('2d', { alpha: false });

const cam = { x: 300, y: 214, dragging: false, lx: 0, ly: 0 };
let ground = null;
let statics = [];
let lights = [];
let actors = [];
let critters = [];
let selected = null;
let paused = false;
let nextTraveler = 2;
let fps = 0;

let smokeT = 0;

// ------------------------------------------------------------------ view setup

// Viewport size in CSS pixels. Cached because the coordinate transforms below
// run a few thousand times a frame and must not allocate.
const view = { w: 0, h: 0 };

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  view.w = canvas.width / dpr;
  view.h = canvas.height / dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
}

/** Logical world coords -> CSS pixels. */
function toScreen(wx, wy) {
  const s = STYLE.scale;
  return [(wx - cam.x) * s + view.w / 2, (wy - cam.y) * s + view.h / 2];
}

function toWorld(sx, sy) {
  const s = STYLE.scale;
  return [(sx - view.w / 2) / s + cam.x, (sy - view.h / 2) / s + cam.y];
}

function clampCam() {
  const s = STYLE.scale;
  const halfW = view.w / (2 * s), halfH = view.h / (2 * s);
  // If the world is narrower than the viewport, centre it instead of clamping.
  cam.x = halfW * 2 > WORLD.w ? WORLD.w / 2 : Math.max(halfW, Math.min(WORLD.w - halfW, cam.x));
  cam.y = halfH * 2 > WORLD.h ? WORLD.h / 2 : Math.max(halfH, Math.min(WORLD.h - halfH, cam.y));
}

// ------------------------------------------------------------------- rebuilding

function rebuildArt() {
  clearSpriteCache();
  clearPropCache();
  ground = bakeGround(STYLE.scale);
  lights = collectLights();
  clampCam();
}

function rebuildWorld() {
  statics = [...PROPS, ...scatter()].map((q) => ({ ...q }));
  statics.sort((a, b) => depthOf(a) - depthOf(b));
  actors = buildCast();
  actors.forEach((a) => a.begin(actors));
  critters = buildCritters();
  clearFx();
  stats.trades = stats.coins = stats.goods = stats.travelers = 0;
}

// ----------------------------------------------------------------------- update

function update(dt) {
  updateFx(dt);
  for (const a of actors) a.update(dt, actors);
  for (let i = actors.length - 1; i >= 0; i--) if (actors[i].dead) {
    if (selected === actors[i]) selected = null;
    actors.splice(i, 1);
  }
  for (const c of critters) c.update(dt);

  nextTraveler -= dt;
  const travelling = actors.filter((a) => a.loop === false).length;
  if (nextTraveler <= 0 && travelling < 6) {
    spawnTraveler(actors);
    nextTraveler = 5 + Math.random() * 7;
  }

  // Chimney smoke: the bakery puffs harder while someone is actually baking.
  smokeT -= dt;
  if (smokeT <= 0) {
    smokeT = 0.5 + Math.random() * 0.5;
    for (const q of PROPS) {
      const meta = propMeta(q.name);
      const off = meta.chimney;
      if (!off) continue;
      // Working chimneys (the bakery oven, the forge) puff every tick; homes
      // are lazier about it.
      const working = q.name === 'bakery' || meta.forge;
      if (!working && Math.random() > 0.5) continue;
      smoke(q.x + off[0] + (Math.random() - 0.5) * 2, q.y + off[1]);
      if (q.name === 'bakery' && actors.some((a) => a.baking)) {
        smoke(q.x + off[0], q.y + off[1] - 2);             // oven going hard
      }
    }
  }

  if (selected) {
    // Ease the camera toward whoever is being followed.
    cam.x += (selected.x - cam.x) * Math.min(1, dt * 3);
    cam.y += (selected.y - cam.y) * Math.min(1, dt * 3);
    clampCam();
  }

  if (STYLE.dayNight) {
    STYLE.timeOfDay = (STYLE.timeOfDay + dt / 180) % 1;   // a 3-minute day
    const el = document.getElementById('time');
    if (el) el.value = String(Math.round(STYLE.timeOfDay * 100));
  }
}

// ----------------------------------------------------------------------- render

// Ground shadows are baked to small canvases and blitted. A path fill per
// sprite per frame is the single most expensive thing in a wide shot, and
// caching also buys us a real gradient for the soft mode.
const shadowCache = new Map();

function shadowSprite(rx) {
  const key = `${STYLE.shadow}|${rx}`;
  const hit = shadowCache.get(key);
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
    c.scale(1, ry / rx);                     // squash the circle into an ellipse
    c.translate(-cx, -cy);
    c.fillRect(cx - rx, cy - rx, rx * 2, rx * 2);
  } else {
    c.fillStyle = 'rgba(30,22,16,0.26)';
    c.beginPath();
    c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    c.fill();
  }
  shadowCache.set(key, cv);
  return cv;
}

function shadowFor(sx, sy, w) {
  if (STYLE.shadow === 'off') return;
  const cv = shadowSprite(Math.max(2, Math.round(w * 0.34)));
  g.drawImage(
    cv,
    Math.round(sx - cv.width / 2),
    Math.round(sy - cv.height / 2 - STYLE.scale * 0.5),
  );
}

/** Depth key: `sortY` lets a sprite sort somewhere other than where it draws. */
function depthOf(q) {
  return q.sortY != null ? q.sortY : q.y;
}

function drawStatic(q) {
  const spr = prop(q.name);
  const [sx, sy] = toScreen(q.x, q.y);
  const w = spr.canvas.width;
  if (/tree|house|inn|bakery|stall|well|cart|haystack|market|warehouse|lumber|smithy/.test(q.name)) {
    shadowFor(sx, sy, w * 0.55);
  }
  g.drawImage(spr.canvas, Math.round(sx - spr.ax), Math.round(sy - spr.ay));
}

function drawActor(a) {
  const spr = villagerFrame(a.look, a.view, a.frame, a.item, a.tool);
  const [sx, sy0] = toScreen(a.x, a.y);
  const sy = sy0 - a.z * STYLE.scale;
  shadowFor(sx, sy0, 8 * STYLE.scale);
  g.drawImage(spr.canvas, Math.round(sx - spr.ax), Math.round(sy - spr.ay));

  if (a === selected) {
    // Selection ring, drawn on the ground so it never hides the character.
    g.strokeStyle = pal().coin;
    g.lineWidth = Math.max(1, STYLE.scale / 2);
    g.beginPath();
    g.ellipse(sx, sy0 - STYLE.scale * 0.5, 6 * STYLE.scale, 2.4 * STYLE.scale, 0, 0, Math.PI * 2);
    g.stroke();
  }
  if (a.bubble) {
    const alpha = Math.min(1, a.bubbleT * 2.5);
    drawBubble(g, sx, sy - spr.canvas.height - 2 * STYLE.scale, a.bubble, STYLE.scale, alpha);
  }
  if (STYLE.labels) {
    label(a.name, sx, sy - spr.canvas.height - (a.bubble ? 15 : 3) * STYLE.scale);
  }
}

function drawCritter(c) {
  const spr = c.kind === 'dog' ? dogFrame(c.frame, c.flip) : chickenFrame(c.frame, c.flip);
  const [sx, sy] = toScreen(c.x, c.y);
  shadowFor(sx, sy, 5 * STYLE.scale);
  g.drawImage(spr.canvas, Math.round(sx - spr.ax), Math.round(sy - spr.ay));
}

function label(text, sx, sy) {
  g.font = `${Math.max(9, 3.2 * STYLE.scale)}px ui-monospace, monospace`;
  g.textAlign = 'center';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(24,18,14,0.85)';
  g.strokeText(text, sx, sy);
  g.fillStyle = '#f6efe2';
  g.fillText(text, sx, sy);
}

/** 0 = full night, 1 = full day. */
function daylight() {
  const t = STYLE.timeOfDay;
  // Smooth dawn around 0.25 and dusk around 0.78.
  const up = Math.min(1, Math.max(0, (t - 0.18) / 0.14));
  const down = Math.min(1, Math.max(0, (0.9 - t) / 0.14));
  return Math.min(up, down);
}

function drawNight() {
  const p = pal();
  const d = daylight();
  const dark = (1 - d) * p.nightStrength;
  if (dark <= 0.01) return;
  const v = view;

  g.fillStyle = p.night;
  g.globalAlpha = dark;
  g.fillRect(0, 0, v.w, v.h);
  g.globalAlpha = 1;

  // Warm pools of light. `lighter` on top of the wash reads like lamplight
  // rather than a hole cut in the darkness.
  g.globalCompositeOperation = 'lighter';
  const s = STYLE.scale;
  for (const L of lights) {
    const [sx, sy] = toScreen(L.x, L.y);
    const r = L.r * s * 0.55;
    if (sx < -r || sy < -r || sx > v.w + r || sy > v.h + r) continue;
    const grad = g.createRadialGradient(sx, sy, 0, sx, sy, r);
    const a = 0.5 * dark;
    grad.addColorStop(0, `rgba(255,215,140,${a})`);
    grad.addColorStop(0.45, `rgba(240,180,90,${a * 0.4})`);
    grad.addColorStop(1, 'rgba(240,180,90,0)');
    g.fillStyle = grad;
    g.fillRect(sx - r, sy - r, r * 2, r * 2);
  }
  g.globalCompositeOperation = 'source-over';
}

function render() {
  const p = pal();
  const v = view;
  const s = STYLE.scale;
  g.fillStyle = p.grassDeep;
  g.fillRect(0, 0, v.w, v.h);

  const [gx, gy] = toScreen(0, 0);
  g.drawImage(ground, Math.round(gx), Math.round(gy));

  // Depth-sorted merge of static scenery and moving things.
  const dyn = [
    ...actors.map((a) => ({ y: a.y, kind: 'a', ref: a })),
    ...critters.map((c) => ({ y: c.y, kind: 'c', ref: c })),
  ].sort((a, b) => a.y - b.y);

  const margin = 80;
  const [x0, y0] = toWorld(-margin * s, -margin * s);
  const [x1, y1] = toWorld(v.w + margin * s, v.h + margin * s);

  let i = 0, j = 0;
  while (i < statics.length || j < dyn.length) {
    const takeStatic =
      j >= dyn.length || (i < statics.length && depthOf(statics[i]) <= dyn[j].y);
    if (takeStatic) {
      const q = statics[i++];
      if (q.x > x0 && q.x < x1 && q.y > y0 && q.y < y1 + 60) drawStatic(q);
    } else {
      const d = dyn[j++];
      if (d.ref.x < x0 || d.ref.x > x1 || d.ref.y < y0 || d.ref.y > y1) continue;
      if (d.kind === 'a') drawActor(d.ref);
      else drawCritter(d.ref);
    }
  }

  drawFx(g, toScreen, s);
  drawNight();
}

// -------------------------------------------------------------------- main loop

let last = performance.now();
let acc = 0, frames = 0;

function frame(now) {
  const raw = Math.min(0.05, (now - last) / 1000);
  last = now;
  acc += raw;
  frames++;
  if (acc > 0.5) {
    fps = Math.round(frames / acc);
    acc = 0;
    frames = 0;
    updateHud();
  }
  if (!paused) update(raw * STYLE.speed);
  render();
  requestAnimationFrame(frame);
}

// --------------------------------------------------------------------- controls

canvas.addEventListener('pointerdown', (e) => {
  cam.dragging = true;
  cam.lx = e.clientX;
  cam.ly = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  cam.moved = 0;
});

canvas.addEventListener('pointermove', (e) => {
  if (!cam.dragging) return;
  const dx = e.clientX - cam.lx, dy = e.clientY - cam.ly;
  cam.lx = e.clientX;
  cam.ly = e.clientY;
  cam.moved = (cam.moved || 0) + Math.abs(dx) + Math.abs(dy);
  if (cam.moved > 4) {
    selected = null;                       // dragging breaks the follow
    cam.x -= dx / STYLE.scale;
    cam.y -= dy / STYLE.scale;
    clampCam();
  }
});

canvas.addEventListener('pointerup', (e) => {
  cam.dragging = false;
  if ((cam.moved || 0) > 4) return;
  // A click (not a drag) selects the nearest villager to follow.
  const r = canvas.getBoundingClientRect();
  const [wx, wy] = toWorld(e.clientX - r.left, e.clientY - r.top);
  let best = null, bestD = 14;
  for (const a of actors) {
    const d = Math.hypot(a.x - wx, (a.y - 6 - wy) * 0.8);
    if (d < bestD) { bestD = d; best = a; }
  }
  selected = best;
  updateHud();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dir = e.deltaY > 0 ? -1 : 1;
  setScale(STYLE.scale + dir);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  const pan = 24 / STYLE.scale * 4;
  if (e.key === 'ArrowLeft' || e.key === 'a') cam.x -= pan;
  else if (e.key === 'ArrowRight' || e.key === 'd') cam.x += pan;
  else if (e.key === 'ArrowUp' || e.key === 'w') cam.y -= pan;
  else if (e.key === 'ArrowDown' || e.key === 's') cam.y += pan;
  else if (e.key === ' ') { paused = !paused; syncPauseLabel(); }
  else if (e.key === 'Escape') selected = null;
  else return;
  if (e.key !== ' ') selected = null;
  clampCam();
  e.preventDefault();
});

window.addEventListener('resize', () => { resize(); clampCam(); });

function setScale(n) {
  const next = Math.max(2, Math.min(6, n));
  if (next === STYLE.scale) return;
  STYLE.scale = next;
  document.getElementById('scale').value = String(next);
  document.getElementById('scaleVal').textContent = `${next}×`;
  rebuildArt();
}

// -------------------------------------------------------------------------- HUD

function updateHud() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('statTrades', stats.trades);
  set('statGoods', stats.goods);
  set('statCoins', stats.coins);
  set('statTravelers', stats.travelers);
  set('statPop', actors.length);
  set('statFps', fps);
  const card = document.getElementById('card');
  if (selected) {
    card.hidden = false;
    set('cardName', selected.name);
    set('cardRole', selected.role);
    set('cardItem', selected.item ? `carrying ${selected.item}` : (selected.tool ? `working (${selected.tool})` : 'empty-handed'));
  } else {
    card.hidden = true;
  }
}

function syncPauseLabel() {
  document.getElementById('pause').textContent = paused ? '▶ Resume' : '❚❚ Pause';
}

function bindUi() {
  const palSel = document.getElementById('palette');
  for (const [k, v] of Object.entries(PALETTES)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = v.name;
    palSel.append(o);
  }
  palSel.value = STYLE.palette;
  palSel.onchange = () => { STYLE.palette = palSel.value; rebuildArt(); };

  const scale = document.getElementById('scale');
  scale.value = String(STYLE.scale);
  scale.oninput = () => setScale(+scale.value);

  const outline = document.getElementById('outline');
  outline.value = STYLE.outline;
  outline.onchange = () => { STYLE.outline = outline.value; rebuildArt(); };

  const rim = document.getElementById('rim');
  rim.value = String(Math.round(STYLE.rim * 100));
  rim.oninput = () => {
    STYLE.rim = +rim.value / 100;
    document.getElementById('rimVal').textContent = `${rim.value}%`;
    rebuildArt();
  };

  const shadow = document.getElementById('shadow');
  shadow.value = STYLE.shadow;
  shadow.onchange = () => { STYLE.shadow = shadow.value; };

  const speed = document.getElementById('speed');
  speed.value = String(STYLE.speed);
  speed.onchange = () => { STYLE.speed = +speed.value; };

  const labels = document.getElementById('labels');
  labels.checked = STYLE.labels;
  labels.onchange = () => { STYLE.labels = labels.checked; };

  const cycle = document.getElementById('cycle');
  cycle.checked = STYLE.dayNight;
  cycle.onchange = () => { STYLE.dayNight = cycle.checked; };

  const time = document.getElementById('time');
  time.value = String(Math.round(STYLE.timeOfDay * 100));
  time.oninput = () => {
    STYLE.timeOfDay = +time.value / 100;
    STYLE.dayNight = false;
    cycle.checked = false;
  };

  document.getElementById('pause').onclick = () => { paused = !paused; syncPauseLabel(); };
  document.getElementById('traveler').onclick = () => spawnTraveler(actors);
  document.getElementById('reset').onclick = () => { rebuildWorld(); actors.forEach((a) => a.begin(actors)); };
}

// -------------------------------------------------------------------------- boot

resize();
bindUi();
rebuildArt();
rebuildWorld();
// Start looking at the crossroads itself.
cam.x = POI.plazaCentre.x;
cam.y = POI.plazaCentre.y + 6;
clampCam();
updateHud();
requestAnimationFrame(frame);

// Handy for poking at the sim from the console while art-directing.
window.CROSSROADS = { STYLE, actors, stats, cam, spawn: () => spawnTraveler(actors), Actor };
