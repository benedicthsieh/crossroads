// game.js — boot, main loop, input and HUD.
//
// The whole file is renderer-side. It owns the canvas, the camera, the DOM and
// the clock; it calls `step(state, dt)` and then draws whatever came back. It
// never reaches into the sim to nudge a traveller or place a road, which is
// what keeps "save the game" honest: everything this file holds is either
// derived from the state or is a view setting nobody needs restored.

import { STYLE } from './palette.js';
import { createState, step, snapshot, totalPopulation } from './sim/state.js';
import { WORLD, TERRAIN_NAMES, MAP, TILE, regionOf } from './sim/terrain.js';
import { housing, population } from './sim/towns.js';
import { stockOf, countKind, workingFields, consumption, luxuryStanding } from './sim/economy.js';
import { heldLuxuries, LUXURY_KINDS, LUXURIES } from './sim/luxuries.js';
import { saveLocal, loadLocal, hasLocal, toShareCode, fromShareCode, saveSize } from './sim/save.js';
import {
  makeCamera, resizeCamera, applyTransform, toWorld, clampCamera,
  ZOOM_STOPS, DEFAULT_STOP, bakeScaleFor, ZOOM_MIN, ZOOM_MAX, nearestStop,
} from './render/camera.js';
import {
  createRenderer, drawScene, tickSmoke, tickCaravans, updateFx, updateRoadLayer,
} from './render/scene.js';
import {
  CREEDS, PLAYER, RIVAL, PERKS, faithOf, shares, beginFaith, claimOmen, buyPerk, canBuy, has,
  sendProphet, prophetCost, endPrologue, canBeginEarly, WIN_SHARE,
} from './sim/faith.js';
import { drawFaithOverlay, floatText, tickFloaters, clearFloaters } from './render/faithPaint.js';

const canvas = document.getElementById('view');
const g = canvas.getContext('2d', { alpha: false });

let state = null;
let renderer = null;
const cam = makeCamera();
let dpr = 1;
let paused = false;
let fps = 0;
let zoomStop = DEFAULT_STOP;
let autosaveT = 30;

/**
 * Wall-clock milliseconds per frame the prologue may spend stepping the sim.
 * The prologue is the world building itself before there is anything to
 * convert. It is worth seeing — it is the reason the map looks the way it
 * does — but not at 1x, so it runs as fast as the frame budget allows and
 * leaves the rest of the frame for drawing it.
 */
const PROLOGUE_BUDGET = 26;

/**
 * Renderer-side game UI state. None of this is saved: which town the card is
 * showing, where the camera is gliding to, and which towns the HUD last saw
 * change hands (so it can announce it).
 */
const ui = {
  hits: [],
  selected: null,
  glide: null,
  keeps: new Map(),
  omenCursor: 0,
  phase: null,
};

// --------------------------------------------------------------- lifecycle

function adoptState(next) {
  state = next;
  if (!renderer) renderer = createRenderer(state);
  // A world still building itself is watched whole; a game in progress opens
  // on the town the creed started in. The zoom is set before the bake, not
  // after, so a new map is baked once at the scale it will be seen at.
  const fs = state.faith;
  const origin = state.towns.find((t) => t.id === fs.origin);
  const watching = fs.phase === 'prologue' || fs.phase === 'choose' || !origin;
  STYLE.zoom = ZOOM_STOPS[watching ? 0 : 1].zoom;
  STYLE.scale = bakeScaleFor(STYLE.zoom);
  applyTransform(cam, canvas, g, dpr);
  syncZoomUi();
  // Always rebake: a loaded game may have a different seed, and the terrain
  // canvas belongs to the seed it was painted from.
  renderer.rebakeArt(state);
  renderer.rebuildWorld(state);
  clearFloaters();
  ui.selected = null;
  ui.glide = null;
  ui.keeps = new Map();
  ui.phase = null;
  cam.x = watching ? WORLD.w / 2 : origin.x;
  cam.y = watching ? WORLD.h / 2 : origin.y;
  clampCamera(cam);
  refreshHud();
  refreshTowns();
  syncPhase();
}

/**
 * Set the zoom, optionally keeping one screen point pinned to the world under
 * it — which is what a pinch gesture and a wheel-over-the-cursor both want.
 *
 * Zoom itself is continuous; only the *bake* scale is bracketed, and crossing a
 * bracket is the only thing here that costs anything (see camera.js).
 */
function setZoom(zoom, anchorCssX, anchorCssY) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  if (next === STYLE.zoom) return;

  let anchorWorld = null;
  if (anchorCssX != null) anchorWorld = screenToWorld(anchorCssX, anchorCssY);

  // Passing the current scale is what arms the hysteresis — without it a pinch
  // that settles on a bracket boundary re-bakes every sprite and repaints the
  // whole road layer several times a second.
  const bake = bakeScaleFor(next, STYLE.scale);
  const rebake = bake !== STYLE.scale;
  STYLE.zoom = next;
  STYLE.scale = bake;
  applyTransform(cam, canvas, g, dpr);
  if (rebake && renderer) {
    renderer.rebakeArt(state);
    renderer.rebuildWorld(state);
  }

  if (anchorWorld) {
    // Put the same world point back under the same finger.
    const after = screenToWorld(anchorCssX, anchorCssY);
    cam.x += anchorWorld[0] - after[0];
    cam.y += anchorWorld[1] - after[1];
  }
  clampCamera(cam);
  syncZoomUi();
}

function syncZoomUi() {
  zoomStop = nearestStop(STYLE.zoom);
  document.getElementById('zoom').value = String(zoomStop);
  document.getElementById('zoomVal').textContent = ZOOM_STOPS[zoomStop].label;
}

/** Jump to one of the slider's named stops. */
function applyZoom(stop) {
  const i = Math.max(0, Math.min(ZOOM_STOPS.length - 1, stop));
  setZoom(ZOOM_STOPS[i].zoom);
  zoomStop = i;
  syncZoomUi();
}

// -------------------------------------------------------------------- loop

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
    refreshHud();
  }

  const phase = state.faith.phase;
  // The clock holds while the player is choosing where to begin: it is the one
  // decision in the game that should not be made against a timer.
  if (!paused && phase !== 'choose') {
    if (phase === 'prologue') {
      const t0 = performance.now();
      do step(state, 0.05);
      while (performance.now() - t0 < PROLOGUE_BUDGET && state.faith.phase === 'prologue');
    } else {
      const dt = raw * STYLE.speed;
      // Long steps at high speed are split so travellers can't tunnel through a
      // tile without laying any wear down in it.
      const slices = Math.min(16, Math.ceil(dt / 0.05));
      for (let i = 0; i < slices; i++) step(state, dt / slices);
    }
    updateFx(raw);
    tickFloaters(raw);
    tickCaravans(renderer, state, raw);
    tickSmoke(renderer, state, raw);
    handleEvents(state.events);
    renderer.consumeEvents(state);
    // The clock runs on wall time, not sim time. Tie it to `dt` and the whole
    // map strobes between noon and midnight at 16x, which is unusable.
    if (STYLE.dayNight) STYLE.timeOfDay = (STYLE.timeOfDay + raw / 260) % 1;

    autosaveT -= raw;
    if (autosaveT <= 0) {
      autosaveT = 30;
      saveLocal(state);
    }
  }

  updateRoadLayer(renderer.roads, state);

  if (state.faith.phase !== ui.phase) syncPhase();

  if (ui.glide) {
    const k = Math.min(1, raw * 5);
    cam.x += (ui.glide.x - cam.x) * k;
    cam.y += (ui.glide.y - cam.y) * k;
    clampCamera(cam);
    if (Math.hypot(ui.glide.x - cam.x, ui.glide.y - cam.y) < 2) ui.glide = null;
  }

  if (cam.follow != null) {
    const t = state.caravans.find((x) => x.id === cam.follow)
      || state.residents.find((x) => x.id === cam.follow);
    if (t) {
      cam.x += (t.x - cam.x) * Math.min(1, raw * 3);
      cam.y += (t.y - cam.y) * Math.min(1, raw * 3);
      clampCamera(cam);
    } else {
      cam.follow = null;
      renderer.follow = null;
    }
  }

  drawScene(g, renderer, cam, state);
  drawFaithOverlay(g, cam, state, ui, dpr, now / 1000);
  requestAnimationFrame(frame);
}

// ----------------------------------------------------------------- input

// Pointers are tracked in a map rather than as a single drag, because the same
// three handlers have to serve a mouse, one finger panning, and two fingers
// pinching. `pinch` is non-null only while exactly two are down.
const pointers = new Map();
let pinch = null;

const localX = (e) => e.clientX - canvas.getBoundingClientRect().left;
const localY = (e) => e.clientY - canvas.getBoundingClientRect().top;

function pinchState() {
  const [a, b] = [...pointers.values()];
  return {
    dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
  };
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const p = pinchState();
    pinch = { dist: p.dist, zoom: STYLE.zoom };
    cam.dragging = false;
  } else if (pointers.size === 1) {
    cam.dragging = true;
    cam.lx = e.clientX;
    cam.ly = e.clientY;
    cam.moved = 0;
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch && pointers.size === 2) {
    const p = pinchState();
    const rect = canvas.getBoundingClientRect();
    // Zoom about the midpoint between the fingers, so the map stays put under
    // the gesture instead of sliding out from under it.
    setZoom(pinch.zoom * (p.dist / pinch.dist), p.cx - rect.left, p.cy - rect.top);
    cam.follow = null;
    renderer.follow = null;
    return;
  }

  if (!cam.dragging) return;
  const dx = e.clientX - cam.lx, dy = e.clientY - cam.ly;
  cam.lx = e.clientX;
  cam.ly = e.clientY;
  cam.moved += Math.abs(dx) + Math.abs(dy);
  if (cam.moved > 4) {
    cam.follow = null;
    renderer.follow = null;
    ui.glide = null;
    cam.x -= dx / STYLE.zoom;
    cam.y -= dy / STYLE.zoom;
    clampCamera(cam);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) {
    // Coming out of a pinch with one finger still down: re-anchor the pan so
    // the map doesn't jump by however far the lifted finger was away.
    const [only] = [...pointers.values()];
    cam.lx = only.x;
    cam.ly = only.y;
    cam.moved = 99;              // treat the rest of this gesture as a drag
    cam.dragging = true;
  }
  if (pointers.size === 0) cam.dragging = false;
}

canvas.addEventListener('pointerup', (e) => {
  const wasPinching = pinch != null || pointers.size > 1;
  const moved = cam.moved;
  endPointer(e);
  if (wasPinching || moved > 4) return;
  pickAt(localX(e), localY(e));
});

canvas.addEventListener('pointercancel', endPointer);

/**
 * A tap. The game layer gets first refusal — omens, then towns — and only a
 * tap on nothing in particular falls through to following a caravan.
 */
function pickAt(cssX, cssY) {
  for (let i = ui.hits.length - 1; i >= 0; i--) {
    const h = ui.hits[i];
    if (cssX < h.x0 || cssX > h.x1 || cssY < h.y0 || cssY > h.y1) continue;
    if (h.type === 'omen') { claimOmen(state, h.id, PLAYER); return; }
    if (h.type === 'omenEdge') {
      const o = state.faith.omens.find((q) => q.id === h.id);
      if (o) glideTo(o.x, o.y);
      return;
    }
    if (h.type === 'town') { selectTown(h.id); return; }
  }
  if (ui.selected != null) { selectTown(null); return; }
  followAt(cssX, cssY);
}

/** Follow whatever is under this point: a caravan, or somebody on foot. */
function followAt(cssX, cssY) {
  const [wx, wy] = screenToWorld(cssX, cssY);
  let best = null, bestD = 26;
  for (const c of state.caravans) {
    const d = Math.hypot(c.x - wx, (c.y - 8 - wy) * 0.8);
    if (d < bestD) { bestD = d; best = c.id; }
  }
  let bestPerson = 16;
  for (const p of state.residents) {
    const d = Math.hypot(p.x - wx, (p.y - 6 - wy) * 0.8);
    if (d < bestPerson) { bestPerson = d; best = p.id; }
  }
  cam.follow = best;
  renderer.follow = best;
  refreshHud();
}

/** CSS pixels within the canvas -> world units. */
function screenToWorld(cssX, cssY) {
  const z = STYLE.zoom / STYLE.scale;
  return toWorld(cam, cssX / z, cssY / z);
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // Continuous, and anchored on the cursor — the same code path the pinch uses.
  const factor = Math.exp(-e.deltaY * 0.0018);
  setZoom(STYLE.zoom * factor, localX(e), localY(e));
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'Tab' || e.key === 'o') { nextOmen(); e.preventDefault(); return; }
  if (e.key === 'r') { togglePerks(); e.preventDefault(); return; }
  if (e.key === 'Escape') {
    document.getElementById('perks').hidden = true;
    selectTown(null);
  }
  const pan = 90 / STYLE.zoom;
  if (e.key === 'ArrowLeft' || e.key === 'a') cam.x -= pan;
  else if (e.key === 'ArrowRight' || e.key === 'd') cam.x += pan;
  else if (e.key === 'ArrowUp' || e.key === 'w') cam.y -= pan;
  else if (e.key === 'ArrowDown' || e.key === 's') cam.y += pan;
  else if (e.key === ' ') { paused = !paused; syncPause(); }
  else if (e.key >= '1' && e.key <= '4') { setSpeed([1, 2, 4, 8][+e.key - 1]); }
  else if (e.key === 'Escape') { cam.follow = null; renderer.follow = null; }
  else if (e.key === '+' || e.key === '=') applyZoom(zoomStop + 1);
  else if (e.key === '-' || e.key === '_') applyZoom(zoomStop - 1);
  else return;
  if (e.key !== ' ') { cam.follow = null; renderer.follow = null; }
  clampCamera(cam);
  e.preventDefault();
});

window.addEventListener('resize', () => {
  dpr = resizeCamera(cam, canvas, g);
  clampCamera(cam);
});

// -------------------------------------------------------------------- HUD

let toastT = null;

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg.charAt(0).toUpperCase() + msg.slice(1);
  el.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.hidden = true; }, 2600);
}

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Everything every town has in its stores, for the map-wide summary. */
function stores(st) {
  let food = 0, wood = 0, stone = 0;
  for (const t of st.towns) {
    const s = stockOf(t);
    food += s.food;
    wood += s.wood;
    stone += s.stone;
  }
  return `${Math.round(food)}f ${Math.round(wood)}w ${Math.round(stone)}s`;
}

/** Fields in production, and fields still being broken in. */
function fields(st) {
  let working = 0, clearing = 0;
  for (const t of st.towns) {
    const done = workingFields(t);
    working += done;
    clearing += countKind(t, 'farm') - done;
  }
  return clearing ? `${working} (+${clearing} clearing)` : String(working);
}

const terrainUnder = (x, y) => TERRAIN_NAMES[state.terrain.kind[
  Math.min(MAP.h - 1, Math.floor(y / TILE)) * MAP.w + Math.min(MAP.w - 1, Math.floor(x / TILE))
]];

const regionUnder = (x, y) => regionOf(state.terrain, x, y).name;

/**
 * Which luxuries exist anywhere on the map, and how many towns hold each.
 *
 * Reported as "how many of the five are in circulation" rather than as a total
 * weight, because the interesting number is variety: two towns swapping spice
 * for gems is the thing this whole system is for, and a bare tonnage would read
 * the same whether one town was hoarding or five were trading.
 */
function luxuryTrade(st) {
  const holders = new Map();
  for (const t of st.towns) {
    for (const l of heldLuxuries(stockOf(t), 1)) {
      holders.set(l.kind, (holders.get(l.kind) || 0) + 1);
    }
  }
  if (!holders.size) return 'none in circulation';
  const parts = [...holders.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${LUXURIES[kind].label} ×${n}`);
  return `${holders.size}/${LUXURY_KINDS.length} · ${parts.slice(0, 3).join(', ')}`;
}

function refreshHud() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  let onRoad = 0;
  for (const c of state.caravans) onRoad += c.souls;
  set('statTime', clock(state.time));
  set('statTowns', state.towns.length);
  set('statSettled', totalPopulation(state));
  set('statPop', `${onRoad} in ${state.caravans.length}`);
  set('statTravelers', state.stats.settled);
  set('statRoads', state.stats.roadTiles);
  set('statTrades', state.stats.trades);
  set('statStores', stores(state));
  set('statFields', fields(state));
  set('statLuxuries', luxuryTrade(state));
  set('statFps', fps);
  refreshGameHud();

  const card = document.getElementById('card');
  const c = cam.follow != null ? state.caravans.find((x) => x.id === cam.follow) : null;
  const p = !c && cam.follow != null ? state.residents.find((x) => x.id === cam.follow) : null;

  if (c) {
    card.hidden = false;
    const leg = c.legs && c.legs[c.leg];
    const named = (id) => (state.towns.find((t) => t.id === id) || {}).name || 'town';
    const heading = !leg ? 'deciding'
      : leg.kind === 'join' ? `looking for a home in ${named(leg.townId)}`
        : leg.kind === 'found' ? 'headed for an empty crossroads to settle'
          : leg.kind === 'market' ? `calling in at ${named(leg.townId)}`
            : leg.kind === 'home' ? `heading home to ${named(leg.townId)}`
              : 'leaving by the far road';
    set('cardName', `${c.home ? 'Trade run' : 'Caravan'} #${c.id}`);
    set('cardRole', `${c.wagons} wagon${c.wagons === 1 ? '' : 's'}, ${c.souls} souls`);
    set('cardItem', `${heading} · crossing ${terrainUnder(c.x, c.y)} in the ${regionUnder(c.x, c.y)}${load(c)}`);
  } else if (p) {
    card.hidden = false;
    const town = state.towns.find((t) => t.id === p.town);
    set('cardName', `#${p.id}`);
    set('cardRole', `${p.role}${town ? `, of ${town.name}` : ''}`);
    set('cardItem', `running an errand · on ${terrainUnder(p.x, p.y)}${p.carry ? ` · carrying ${p.carry}` : ''}`);
  } else {
    card.hidden = true;
  }
}

/**
 * What a caravan is hauling: real material first, then the sack it's holding.
 *
 * Luxuries are listed first and to one decimal place. Half a jar of spice is a
 * meaningful cargo and "0 spice" is not — the whole shelf only holds fourteen.
 */
function load(c) {
  if (c.cargo) {
    const parts = [];
    for (const res of LUXURY_KINDS) {
      const n = c.cargo[res] || 0;
      if (n >= 0.1) parts.push(`${n.toFixed(1)} ${LUXURIES[res].label}`);
    }
    for (const res of ['food', 'wood', 'stone']) {
      const n = c.cargo[res] || 0;
      if (n >= 0.5) parts.push(`${Math.round(n)} ${res}`);
    }
    if (parts.length) return ` · hauling ${parts.join(', ')}`;
  }
  return c.carry ? ` · carrying ${c.carry}` : '';
}

let lastTownCount = -1;

function refreshTowns() {
  const list = document.getElementById('townList');
  list.innerHTML = '';
  if (!state.towns.length) {
    list.innerHTML = '<li class="quiet">None yet — the roads have to meet first.</li>';
    return;
  }
  // Grouped by region, because "which country is this in" is now the first
  // thing worth knowing about a town — it is what decides who it trades with.
  const byRegion = new Map();
  for (const t of state.towns) {
    if (!byRegion.has(t.region)) byRegion.set(t.region, []);
    byRegion.get(t.region).push(t);
  }

  for (const [region, towns] of [...byRegion.entries()].sort((a, b) => a[0] - b[0])) {
    const info = state.terrain.regions[region];
    const head = document.createElement('li');
    head.className = 'quiet';
    head.innerHTML = `<b>${info.name}</b>${info.arid ? ' — arid' : ''} · ${info.herb}`;
    list.append(head);

    for (const t of towns) {
      const li = document.createElement('li');
      const beds = housing(t) - population(t);
      const s = stockOf(t);
      const tents = countKind(t, 'tent');
      // Days of food in hand rather than raw stock: "9 food" means nothing, "the
      // larder is nearly out" means everything.
      const larder = consumption(t) > 0 ? s.food / consumption(t) : 999;
      const food = t.starving ? '<b>starving</b>'
        : larder < 30 ? 'short of food' : `${Math.round(s.food)} food`;
      // Only what it actually has a supply of. A town holding a tenth of a jar
      // of something is not a spice town and should not be listed as one.
      const lux = heldLuxuries(s, 1).map((l) => l.label).join(', ');
      li.innerHTML = `<b>${t.name}</b> — ${population(t)} people, ${t.buildings.length}
      building${t.buildings.length === 1 ? '' : 's'}, ${beds > 0 ? `${beds} bed${beds === 1 ? '' : 's'} free` : 'full'}
      <span class="tiny">${food} · ${Math.round(s.wood)} wood · ${Math.round(s.stone)} stone${
  tents ? ` · ${tents} tent${tents === 1 ? '' : 's'}` : ''}${
  workingFields(t) ? ` · ${workingFields(t)} field${workingFields(t) === 1 ? '' : 's'}` : ''}${
  lux ? `<br>trades in ${lux} · standing ${luxuryStanding(t).toFixed(1)}` : ''}</span>`;
      li.style.cursor = 'pointer';
      li.onclick = () => {
        cam.follow = null;
        renderer.follow = null;
        cam.x = t.x;
        cam.y = t.y;
        clampCamera(cam);
      };
      list.append(li);
    }
  }
}

function syncPause() {
  document.getElementById('pause').textContent = paused ? '▶ Resume' : '❚❚ Pause';
  syncSpeedButtons();
}

function bindUi() {
  const zoom = document.getElementById('zoom');
  zoom.max = String(ZOOM_STOPS.length - 1);
  zoom.oninput = () => applyZoom(+zoom.value);

  const speed = document.getElementById('speed');
  speed.value = String(STYLE.speed);
  speed.onchange = () => { STYLE.speed = +speed.value; syncSpeedButtons(); };

  const labels = document.getElementById('labels');
  labels.checked = STYLE.labels;
  labels.onchange = () => { STYLE.labels = labels.checked; };

  document.getElementById('pause').onclick = () => { paused = !paused; syncPause(); };

  document.getElementById('newWorld').onclick = newMap;

  document.getElementById('save').onclick = () => {
    toast(saveLocal(state) ? `Saved (${Math.round(saveSize() / 1024)} kB).` : 'Could not save.');
  };

  document.getElementById('load').onclick = () => {
    if (!hasLocal()) { toast('No save found.'); return; }
    const loaded = loadLocal();
    if (!loaded) { toast('That save could not be read.'); return; }
    adoptState(loaded);
    toast('Save loaded.');
  };

  document.getElementById('copyCode').onclick = async () => {
    const code = toShareCode(state);
    try {
      await navigator.clipboard.writeText(code);
      toast(`Share code copied (${Math.round(code.length / 1024)} kB).`);
    } catch {
      // Clipboard is blocked without a user gesture in some contexts, and over
      // plain HTTP everywhere. A prompt is ugly but it always works.
      window.prompt('Copy this Crossroads share code:', code);
    }
  };

  document.getElementById('pasteCode').onclick = () => {
    const code = window.prompt('Paste a Crossroads share code:');
    if (!code) return;
    try {
      adoptState(fromShareCode(code));
      toast('Loaded from share code.');
    } catch (err) {
      toast(err.message);
    }
  };

  bindGameUi();

  // The town list only changes when a town is founded, so poll cheaply rather
  // than rebuilding a DOM list every frame.
  setInterval(() => {
    if (state.towns.length !== lastTownCount) {
      lastTownCount = state.towns.length;
      refreshTowns();
    } else if (state.towns.length) {
      refreshTowns();
    }
  }, 2000);
}

// ------------------------------------------------------------- the game
//
// Everything from here down is the game laid over the simulation: the HUD, the
// rites panel, the town card and the phase overlays. Like the rest of this file
// it reads state freely and changes it only through the sim's own commands —
// `beginFaith`, `claimOmen`, `buyPerk`, `sendProphet`, `endPrologue`.

const pct = (v) => `${Math.round(v * 100)}%`;
const creed = (k) => CREEDS[k].name.replace(/^the /, '');
const $ = (id) => document.getElementById(id);

function glideTo(x, y) {
  cam.follow = null;
  renderer.follow = null;
  ui.glide = { x, y };
}

function setSpeed(n) {
  paused = false;
  STYLE.speed = n;
  $('speed').value = String(n);
  syncPause();
}

function syncSpeedButtons() {
  for (const b of $('speedctl').querySelectorAll('button')) {
    const n = +b.dataset.speed;
    b.classList.toggle('on', n === 0 ? paused : !paused && n === STYLE.speed);
  }
}

function newMap() {
  adoptState(createState());
  toast('A new map. The roads are forming.');
}

/** Fly to the omen closest to fading, then the next one on the next press. */
function nextOmen() {
  const fs = state.faith;
  if (!fs.omens.length) { toast('No omens right now — watch the sky.'); return; }
  const list = [...fs.omens].sort((a, b) => (a.born + a.life) - (b.born + b.life));
  const o = list[ui.omenCursor++ % list.length];
  glideTo(o.x, o.y);
}

/** Sim events the HUD cares about. Read before the renderer drains the queue. */
function handleEvents(events) {
  for (const e of events) {
    switch (e.type) {
      case 'omenClaimed': {
        const who = e.faith === PLAYER ? '' : `${creed(RIVAL)} `;
        floatText(e.x, e.y, `${who}+${e.value} ✦`, CREEDS[e.faith].color);
        if (e.faith === RIVAL) floatText(e.x, e.y - 18, 'the Choir speaks', CREEDS[RIVAL].color);
        else if (e.by === 'preacher') floatText(e.x, e.y - 18, 'a preacher speaks', CREEDS[PLAYER].color);
        break;
      }
      case 'omenFaded':
        floatText(e.x, e.y, 'forgotten', '#b9ae9a');
        break;
      case 'faithBegun':
        toast(`${CREEDS[PLAYER].name} is lit in ${e.name}.`);
        glideTo(e.x, e.y);
        applyZoom(1);
        break;
      case 'rivalRises':
        toast(`A rival prophet rises in ${e.name}: ${CREEDS[RIVAL].name}.`);
        floatText(e.x, e.y, '✶ a rival prophet', CREEDS[RIVAL].color);
        break;
      case 'prophet':
        floatText(e.x, e.y, e.faith === PLAYER ? 'a prophet preaches' : 'a Choir prophet', CREEDS[e.faith].color);
        if (e.faith === RIVAL) toast(`The Choir sends a prophet to ${e.name}.`);
        break;
      case 'perk':
        if (e.faith === RIVAL) {
          const p = PERKS.find((q) => q.id === e.id);
          toast(`The Choir adopts ${p ? p.name : e.id}.`);
        }
        if (!$('perks').hidden) renderPerks();
        break;
      default:
        break;
    }
  }
}

/** Show the overlay that belongs to the phase the sim is in. */
function syncPhase() {
  const fs = state.faith;
  ui.phase = fs.phase;
  const ov = $('overlay');
  const buttons = $('ovButtons');
  buttons.innerHTML = '';
  const button = (text, fn, primary = false) => {
    const b = document.createElement('button');
    b.textContent = text;
    if (primary) b.className = 'primary';
    b.onclick = fn;
    buttons.append(b);
    return b;
  };
  $('ovProgress').hidden = true;

  if (fs.phase === 'prologue') {
    ov.hidden = false;
    $('ovTitle').textContent = 'The roads are forming';
    $('ovBody').textContent = 'Nothing on this map is placed. Caravans cross it, wear roads into '
      + 'it, and stop where the roads meet. A creed needs people to believe in it, so the world '
      + 'runs ahead until it has some towns.';
    $('ovProgress').hidden = false;
    const early = button('Begin now', () => { endPrologue(state); syncPhase(); }, true);
    early.id = 'ovEarly';
    early.disabled = !canBeginEarly(state);
  } else if (fs.phase === 'choose') {
    ov.hidden = false;
    $('ovTitle').textContent = 'Where is the word first spoken?';
    $('ovBody').textContent = 'Tap a town. A busy one sends the word out on more wagons; a remote '
      + 'one is safer, but slow. A rival prophet will rise a little later, as far from you as the '
      + 'map allows.';
    button('The largest town', () => {
      const t = [...state.towns].sort((a, b) => b.pop - a.pop)[0];
      if (t) selectTown(t.id);
    });
  } else if (fs.phase === 'over') {
    ov.hidden = false;
    const [mine, theirs] = shares(state);
    const mins = Math.round(((fs.endedAt || state.time) - fs.started) / 60);
    const title = fs.outcome === 'won' ? `${CREEDS[PLAYER].name} is kept at every crossroads`
      : fs.outcome === 'extinct' ? `The last of ${CREEDS[PLAYER].name} is gone`
        : `${CREEDS[RIVAL].name} holds the roads`;
    $('ovTitle').textContent = title.charAt(0).toUpperCase() + title.slice(1);
    $('ovBody').textContent = `${mins} minutes after the first sermon: ${pct(mine)} of all souls keep `
      + `the ${creed(PLAYER)}, ${pct(theirs)} the ${creed(RIVAL)}. You read ${fs.claimed[PLAYER]} `
      + `omens; the Choir read ${fs.claimed[RIVAL]}, and ${fs.missed} were forgotten.`;
    button('Keep watching', () => { ov.hidden = true; });
    button('New map', newMap, true);
  } else {
    ov.hidden = true;
  }
  refreshTownCard();
  refreshTownbar();
}

function refreshGameHud() {
  const fs = state.faith;
  const [mine, theirs] = shares(state);
  $('creedName').textContent = CREEDS[PLAYER].name;
  $('devotion').textContent = Math.floor(fs.devotion[PLAYER]);
  $('barMine').style.width = pct(mine);
  $('barRival').style.width = pct(theirs);
  $('shareText').textContent = fs.phase === 'prologue' || fs.phase === 'choose'
    ? `${state.towns.length} towns · ${clock(state.time)} of history`
    : `${pct(mine)} yours · ${fs.rivalOrigin != null ? `${pct(theirs)} Choir` : 'no rival yet'}`
      + ` · win at ${pct(WIN_SHARE)}`;
  $('omenCount').textContent = fs.omens.length;
  $('nextOmen').classList.toggle('live', fs.omens.length > 0);
  $('nextOmen').hidden = fs.phase !== 'play';
  $('perkBadge').hidden = !PERKS.some((p) => canBuy(state, p.id));
  syncSpeedButtons();

  if (fs.phase === 'prologue') {
    $('ovProgressBar').style.width = pct(Math.min(1, state.towns.length / 5));
    const early = $('ovEarly');
    if (early) early.disabled = !canBeginEarly(state);
  }

  // Announce a town changing hands. The first sighting of each town only
  // records it, so loading a game doesn't announce everything at once.
  for (const t of state.towns) {
    const f = faithOf(t);
    const now = f[PLAYER] >= 0.5 ? PLAYER : f[RIVAL] >= 0.5 ? RIVAL : -1;
    const before = ui.keeps.get(t.id);
    ui.keeps.set(t.id, now);
    if (before === undefined || before === now || fs.phase !== 'play') continue;
    if (now === PLAYER) toast(`${t.name} keeps ${CREEDS[PLAYER].name}.`);
    else if (now === RIVAL) toast(`${t.name} has gone over to the Choir.`);
  }

  // Where the HUD sits over the canvas, so off-screen omen pointers can stay
  // clear of it. Measured rather than assumed: the top bar wraps on a phone.
  const stage = canvas.getBoundingClientRect();
  ui.inset = {
    top: $('topbar').getBoundingClientRect().bottom - stage.top + 24,
    bottom: stage.bottom - $('townbar').getBoundingClientRect().top + 24,
  };

  refreshTownCard();
  if (!$('perks').hidden) $('perkPurse').textContent = `You have ${Math.floor(fs.devotion[PLAYER])} ✦.`;
}

/** The strip of town chips along the bottom: a map index that is always in reach. */
function refreshTownbar() {
  const bar = $('townbar');
  const scroll = bar.scrollLeft;
  const towns = [...state.towns].sort((a, b) => a.region - b.region || a.founded - b.founded);
  bar.innerHTML = towns.map((t) => {
    const f = faithOf(t);
    const cls = f[PLAYER] >= 0.5 ? 'mine' : f[RIVAL] >= 0.5 ? 'rival' : '';
    return `<button class="chip ${cls}${ui.selected === t.id ? ' sel' : ''}" data-id="${t.id}">`
      + `${t.name}<small>${Math.round(t.pop)}</small>`
      + `<div class="bar"><i style="width:${pct(f[PLAYER])}"></i><i style="width:${pct(f[RIVAL])}"></i></div>`
      + '</button>';
  }).join('');
  bar.scrollLeft = scroll;
}

function selectTown(id) {
  ui.selected = id;
  const t = state.towns.find((q) => q.id === id);
  if (t && state.faith.phase !== 'choose') glideTo(t.x, t.y);
  refreshTownCard();
  refreshTownbar();
}

function refreshTownCard() {
  const card = $('towncard');
  const t = state.towns.find((q) => q.id === ui.selected);
  if (!t) { card.hidden = true; return; }
  const fs = state.faith;
  const f = faithOf(t);
  const region = state.terrain.regions[t.region];
  card.hidden = false;
  $('tcName').textContent = t.name;
  $('tcSub').textContent = `${Math.round(t.pop)} souls · ${t.buildings.length} buildings · `
    + `the ${region.name}${region.arid ? ' (arid)' : ''}`
    + `${fs.origin === t.id ? ' · where you began' : ''}${fs.rivalOrigin === t.id ? ' · where the Choir began' : ''}`;
  $('tcMine').style.width = pct(f[PLAYER]);
  $('tcRival').style.width = pct(f[RIVAL]);
  $('tcLine').textContent = fs.phase === 'prologue' || fs.phase === 'choose'
    ? 'Nobody here has heard the word yet.'
    : `${pct(f[PLAYER])} keep the ${creed(PLAYER)} · ${pct(f[RIVAL])} the ${creed(RIVAL)} · `
      + `${pct(Math.max(0, 1 - f[0] - f[1]))} believe nothing`;
  $('tcBegin').hidden = fs.phase !== 'choose';
  $('tcBegin').textContent = `Begin in ${t.name}`;
  const prophet = $('tcProphet');
  prophet.hidden = fs.phase !== 'play';
  const cost = prophetCost(state);
  prophet.textContent = `Send a prophet (${cost} ✦)`;
  prophet.disabled = fs.devotion[PLAYER] < cost;
}

function renderPerks() {
  const fs = state.faith;
  const tree = $('perkTree');
  const branches = [...new Set(PERKS.map((p) => p.branch))];
  const blurb = { Word: 'how it travels', Rite: 'how it holds a town', Wonder: 'how it reads the sky' };
  tree.innerHTML = branches.map((br) => `<div class="branch"><h4>${br} · ${blurb[br] || ''}</h4>${
    PERKS.filter((p) => p.branch === br).map((p) => {
      const owned = has(state, PLAYER, p.id);
      const locked = !owned && p.req && !has(state, PLAYER, p.req);
      const cls = owned ? 'owned' : locked ? 'locked' : '';
      const afford = canBuy(state, p.id);
      const req = locked ? ` Needs ${PERKS.find((q) => q.id === p.req).name}.` : '';
      return `<button class="perk ${cls}" data-perk="${p.id}" ${owned || !afford ? 'disabled' : ''}>`
        + `<b>${p.name}<em>${owned ? 'kept' : `${p.cost} ✦`}</em></b><span>${p.desc}${req}</span></button>`;
    }).join('')}</div>`).join('');
  $('perkPurse').textContent = `You have ${Math.floor(fs.devotion[PLAYER])} ✦.`;
  const theirs = fs.perks[RIVAL].map((id) => PERKS.find((p) => p.id === id).name);
  $('rivalPerks').textContent = fs.rivalOrigin == null ? 'No rival has risen yet.'
    : `The Choir keeps: ${theirs.length ? theirs.join(', ') : 'nothing yet'}.`;
}

function togglePerks() {
  const el = $('perks');
  el.hidden = !el.hidden;
  if (!el.hidden) renderPerks();
}

function bindGameUi() {
  $('speedctl').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const n = +b.dataset.speed;
    if (n === 0) { paused = !paused; syncPause(); } else setSpeed(n);
  };
  $('openPerks').onclick = togglePerks;
  $('openChronicle').onclick = () => {
    $('panel').hidden = !$('panel').hidden;
    dpr = resizeCamera(cam, canvas, g);
    clampCamera(cam);
  };
  $('nextOmen').onclick = nextOmen;
  $('townbar').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (b) selectTown(+b.dataset.id);
  };
  $('perkTree').onclick = (e) => {
    const b = e.target.closest('.perk');
    if (b && buyPerk(state, b.dataset.perk)) renderPerks();
  };
  for (const b of document.querySelectorAll('[data-close]')) {
    b.onclick = () => {
      if (b.dataset.close === 'towncard') selectTown(null);
      else $(b.dataset.close).hidden = true;
    };
  }
  $('tcBegin').onclick = () => {
    if (ui.selected != null && beginFaith(state, ui.selected)) syncPhase();
  };
  $('tcProphet').onclick = () => {
    if (ui.selected != null) sendProphet(state, ui.selected);
    refreshTownCard();
  };
  $('tcFly').onclick = () => {
    const t = state.towns.find((q) => q.id === ui.selected);
    if (t) { glideTo(t.x, t.y); if (STYLE.zoom < 0.6) applyZoom(2); }
  };
  setInterval(refreshTownbar, 1000);
}

// -------------------------------------------------------------------- boot

dpr = resizeCamera(cam, canvas, g);
bindUi();
adoptState(loadLocal() || createState());
syncPause();
requestAnimationFrame(frame);

// Handy for poking at a running game from the console.
window.CROSSROADS = {
  get state() { return state; },
  snapshot: () => snapshot(state),
  renderer: () => renderer,
  cam,
  STYLE,
  ui,
};
