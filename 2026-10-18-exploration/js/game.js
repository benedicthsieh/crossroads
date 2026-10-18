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
  CREEDS, PLAYER, CHOIR, OLDWAYS, PERKS, ASPECTS, faithOf, shares, beginFaith, chooseAspect,
  claimOmen, buyPerk, canBuy, has, perkCost, sendProphet, prophetCost, endPrologue, canBeginEarly,
  insightCap, insightEta, marksFor, affinity,
} from './sim/faith.js';
import { drawFaithOverlay, floatText, tickFloaters, clearFloaters } from './render/faithPaint.js';
import { smoke } from './fx.js';

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
 * Sim seconds per real second, once the game proper has begun. Locked: the
 * omens are timed in sim seconds, and a speed control meant every one of them
 * had a different deadline depending on a dial the player had touched ten
 * minutes ago. Two is the pace at which a caravan crossing a region is
 * watchable and a town visibly grows inside a session.
 */
const SIM_RATE = 2;

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
  // The corner feed: the last few things that happened, newest first.
  feed: [],
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
  const watching = fs.phase === 'prologue' || fs.phase === 'choose' || fs.phase === 'aspect' || !origin;
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
  ui.feed = [];
  $('feed').innerHTML = '';
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
  // The clock holds while the player is choosing where to begin and what the
  // creed is the creed of: decisions that should not be made against a timer.
  if (!paused && phase !== 'choose' && phase !== 'aspect') {
    if (phase === 'prologue') {
      const t0 = performance.now();
      do step(state, 0.05);
      while (performance.now() - t0 < PROLOGUE_BUDGET && state.faith.phase === 'prologue');
    } else {
      const dt = raw * SIM_RATE;
      // Long steps are split so travellers can't tunnel through a tile without
      // laying any wear down in it.
      const slices = Math.min(16, Math.ceil(dt / 0.05));
      for (let i = 0; i < slices; i++) step(state, dt / slices);
    }
    updateFx(raw);
    tickFloaters(raw);
    tickCaravans(renderer, state, raw);
    tickSmoke(renderer, state, raw);
    tickFireSmoke(raw);
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
    if (h.type === 'omen') {
      if (state.faith.insight < 1) {
        toast(`No insight left. The next comes in ${Math.ceil(insightEta(state) / SIM_RATE)}s — or let this one pass, and your faithful will read it for less.`);
      } else claimOmen(state, h.id);
      return;
    }
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
  const b = document.getElementById('pauseBtn');
  b.textContent = paused ? '▶' : '❚❚';
  b.classList.toggle('on', paused);
}

function bindUi() {
  const zoom = document.getElementById('zoom');
  zoom.max = String(ZOOM_STOPS.length - 1);
  zoom.oninput = () => applyZoom(+zoom.value);


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
const $ = (id) => document.getElementById(id);
const OLD_KEYS = [PLAYER, CHOIR, OLDWAYS];

function glideTo(x, y) {
  cam.follow = null;
  renderer.follow = null;
  ui.glide = { x, y };
}

function newMap() {
  adoptState(createState());
  toast('A new map. The roads are forming.');
}

/** Fill a .bar element with one segment per creed, Lantern first. */
function fillBar(el, f) {
  let html = '';
  let at = 0;
  for (const k of OLD_KEYS) {
    const w = Math.max(0, f[k] || 0);
    html += `<i style="left:${(at * 100).toFixed(1)}%;width:${(w * 100).toFixed(1)}%;background:${CREEDS[k].color}"></i>`;
    at += w;
  }
  el.innerHTML = html;
}

/** Who a town mostly keeps, or -1. */
function keeperOf(f) {
  for (const k of OLD_KEYS) if (f[k] >= 0.5) return k;
  return -1;
}

/** Fly to the most important omen, then the next one on the next press. */
function nextOmen() {
  const fs = state.faith;
  if (!fs.omens.length) { toast('No omens right now — watch the sky.'); return; }
  const list = [...fs.omens].sort((a, b) => b.tier - a.tier || (a.born + a.life) - (b.born + b.life));
  const o = list[ui.omenCursor++ % list.length];
  glideTo(o.x, o.y);
}

// ----------------------------------------------------------------- the feed
//
// A short list in the corner of the map of what just happened, after Civ's
// notification stack. Renderer-side and never saved: it is a view of the
// events the sim emitted this session, and a loaded game starts it empty.

const FEED_MAX = 6;
/** Real seconds before an entry dims, and before it goes. */
const FEED_DIM = 30;
const FEED_LIFE = 90;

function feed(text, x, y, color = null) {
  const li = document.createElement('li');
  li.innerHTML = `<span></span><small>${clock(state.time)}</small>`;
  li.firstChild.textContent = text;
  if (color) li.style.borderLeftColor = color;
  if (x != null) li.onclick = () => glideTo(x, y);
  $('feed').prepend(li);
  ui.feed.unshift({ li, t: 0 });
  while (ui.feed.length > FEED_MAX) ui.feed.pop().li.remove();
}

function tickFeed(dt) {
  for (let i = ui.feed.length - 1; i >= 0; i--) {
    const f = ui.feed[i];
    f.t += dt;
    if (f.t > FEED_DIM) f.li.classList.add('old');
    if (f.t > FEED_LIFE) { f.li.remove(); ui.feed.splice(i, 1); }
  }
}

/** Smoke off a few tiles of every burning front, so a fire is visible from across the map. */
function tickFireSmoke(dt) {
  for (const fire of state.nature.fires) {
    if (!fire.front.length || Math.random() > dt * 14) continue;
    const i = fire.front[(Math.random() * fire.front.length) | 0];
    smoke((i % MAP.w + 0.5) * TILE, ((i / MAP.w | 0) + 0.5) * TILE - 4);
  }
}

/** Sim events the HUD cares about. Read before the renderer drains the queue. */
function handleEvents(events) {
  const lantern = CREEDS[PLAYER].color;
  for (const e of events) {
    switch (e.type) {
      case 'omenClaimed': {
        // One you let pass gets a quiet grey note; one you read gets the gold.
        floatText(e.x, e.y, `+${e.value} ✦`, e.by === 'faithful' ? 'rgba(185,174,154,0.75)' : lantern);
        if (e.by === 'seer') floatText(e.x, e.y - 18, 'a seer speaks', lantern);
        if (e.by === 'hand' && e.tier >= 3) feed(`You read it: ${e.label.toLowerCase()} (+${e.value} ✦)`, e.x, e.y, lantern);
        break;
      }
      case 'omen':
        // Fires and floods have their own, fuller lines below.
        if (e.tier >= 2 && e.kind !== 'wildfire' && e.kind !== 'flood') feed(e.label, e.x, e.y, '#c9b48a');
        break;
      case 'fire':
        feed(`Lightning! The forest is burning near ${e.near}`, e.x, e.y, '#ff5a3a');
        break;
      case 'fireOut':
        feed(`The fire is out: ${e.burnt} tiles of forest are ash`, e.x, e.y, '#8a7d6c');
        break;
      case 'flood':
        feed(`The river floods near ${e.near}${e.ford ? '; the silt leaves a new ford' : ''}`, e.x, e.y, '#5aa0d8');
        break;
      case 'mark':
        feed(`Chronicle: ${e.text}`, null, null, lantern);
        toast(`${e.text}. Your insight is refreshed.`);
        if (!$('perks').hidden) renderPerks();
        break;
      case 'faithBegun':
        toast(`${CREEDS[PLAYER].name}, the creed of ${ASPECTS[e.aspect].name}, is lit in ${e.name}.`);
        feed(`The Lantern is lit in ${e.name}`, e.x, e.y, lantern);
        glideTo(e.x, e.y);
        applyZoom(1);
        break;
      case 'prophet':
        floatText(e.x, e.y, 'a preacher arrives', lantern);
        break;
      case 'perk':
        feed(`Rite adopted: ${e.name}`, null, null, lantern);
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
      + 'it, and stop where the roads meet. They bring two old faiths with them — the Veiled Choir '
      + 'from one side of the world, the Old Ways from the other — and the world runs ahead until '
      + 'it has towns for a new creed to walk into.';
    $('ovProgress').hidden = false;
    const early = button('Begin now', () => { endPrologue(state); syncPhase(); }, true);
    early.id = 'ovEarly';
    early.disabled = !canBeginEarly(state);
  } else if (fs.phase === 'choose') {
    ov.hidden = false;
    $('ovTitle').textContent = 'Where is the word first spoken?';
    $('ovBody').textContent = 'Tap a town. Its colours show who already keeps it: the Choir in violet, '
      + 'the Old Ways in green. The ground around it decides what your creed can become.';
    button('The largest town', () => {
      const t = [...state.towns].sort((a, b) => b.pop - a.pop)[0];
      if (t) selectTown(t.id);
    });
  } else if (fs.phase === 'aspect') {
    ov.hidden = false;
    const town = state.towns.find((t) => t.id === fs.origin);
    $('ovTitle').textContent = 'What is it the word of?';
    $('ovBody').textContent = `The land around ${town ? town.name : 'your first town'} offers three. `
      + 'Choose one; the others close for good. It decides where the creed is strong, which omens are '
      + 'worth twice as much to you, and two rites nobody else is dealt.';
    for (const id of fs.aspectOffer) {
      const a = ASPECTS[id];
      const b = document.createElement('button');
      b.className = 'aspect primary';
      const here = town ? Math.round(affinity(state, town, id) * 100) : 0;
      b.innerHTML = `<b>${a.name}</b><span>${a.desc} Here: ${here}%.</span>`;
      b.onclick = () => { if (chooseAspect(state, id)) syncPhase(); };
      buttons.append(b);
    }
  } else {
    ov.hidden = true;
  }
  refreshTownCard();
  refreshTownbar();
}

function refreshGameHud() {
  const fs = state.faith;
  const sh = shares(state);
  const playing = fs.phase === 'play';
  $('creedName').textContent = CREEDS[PLAYER].name;
  $('aspectName').textContent = fs.aspect ? `of ${ASPECTS[fs.aspect].name}` : '';
  $('devotion').textContent = Math.floor(fs.devotion);
  const cap = insightCap(state);
  const full = Math.floor(fs.insight);
  $('insightPips').innerHTML = `${'◆'.repeat(full)}<span class="off">${'◇'.repeat(Math.max(0, cap - full))}</span>`;
  const eta = insightEta(state);
  $('insightEta').textContent = playing && eta > 0 ? `${Math.ceil(eta / SIM_RATE)}s` : '';
  fillBar($('shareBar'), sh);
  $('shareText').textContent = fs.phase === 'prologue' || fs.phase === 'choose' || fs.phase === 'aspect'
    ? `${state.towns.length} towns · Choir ${pct(sh[CHOIR])} · Old Ways ${pct(sh[OLDWAYS])}`
    : `Lantern ${pct(sh[PLAYER])} · Choir ${pct(sh[CHOIR])} · Old Ways ${pct(sh[OLDWAYS])}`;
  $('omenCount').textContent = fs.omens.length;
  $('nextOmen').classList.toggle('live', fs.omens.some((o) => o.tier >= 2));
  $('nextOmen').hidden = !playing;
  $('perkBadge').hidden = !fs.hand.some((id) => canBuy(state, id));
  tickFeed(0.5);

  if (fs.phase === 'prologue') {
    $('ovProgressBar').style.width = pct(Math.min(1, state.towns.length / 5));
    const early = $('ovEarly');
    if (early) early.disabled = !canBeginEarly(state);
  }

  // Announce a town changing hands. The first sighting of each town only
  // records it, so loading a game doesn't announce everything at once.
  for (const t of state.towns) {
    const now = keeperOf(faithOf(t));
    const before = ui.keeps.get(t.id);
    ui.keeps.set(t.id, now);
    if (before === undefined || before === now || !playing) continue;
    if (now === PLAYER) feed(`${t.name} keeps the Lantern`, t.x, t.y, CREEDS[PLAYER].color);
    else if (before === PLAYER) feed(`${t.name} slips back to ${CREEDS[now] ? CREEDS[now].name : 'nothing in particular'}`, t.x, t.y, '#8a7d6c');
  }

  // Where the HUD sits over the canvas, so off-screen omen pointers can stay
  // clear of it. Measured rather than assumed: the top bar wraps on a phone.
  const stage = canvas.getBoundingClientRect();
  ui.inset = {
    top: $('topbar').getBoundingClientRect().bottom - stage.top + 24,
    bottom: stage.bottom - $('townbar').getBoundingClientRect().top + 24,
  };
  // The feed hangs under the top bar wherever it has wrapped to, and gets out
  // of the way while a phase card is asking the player something.
  $('feed').style.top = `${ui.inset.top - 16}px`;
  $('feed').hidden = !$('overlay').hidden;

  refreshTownCard();
  if (!$('perks').hidden) $('perkPurse').textContent = `You have ${Math.floor(fs.devotion)} ✦.`;
}

/** The strip of town chips along the bottom: a map index that is always in reach. */
function refreshTownbar() {
  const bar = $('townbar');
  const scroll = bar.scrollLeft;
  const towns = [...state.towns].sort((a, b) => a.region - b.region || a.founded - b.founded);
  bar.innerHTML = towns.map((t) => {
    const f = faithOf(t);
    const cls = keeperOf(f) === PLAYER ? 'mine' : '';
    return `<button class="chip ${cls}${ui.selected === t.id ? ' sel' : ''}" data-id="${t.id}">`
      + `${t.name}<small>${Math.round(t.pop)}</small><div class="bar"></div></button>`;
  }).join('');
  bar.querySelectorAll('.chip').forEach((b, i) => fillBar(b.querySelector('.bar'), faithOf(towns[i])));
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
    + `the ${region.name}${region.arid ? ' (arid)' : ''}${fs.origin === t.id ? ' · where you began' : ''}`;
  fillBar($('tcBar'), f);
  const rest = pct(Math.max(0, 1 - f[0] - f[1] - f[2]));
  const ground = fs.aspect ? ` Ground for ${ASPECTS[fs.aspect].name}: ${pct(affinity(state, t, fs.aspect))}.` : '';
  $('tcLine').textContent = `${pct(f[PLAYER])} Lantern · ${pct(f[CHOIR])} Choir · ${pct(f[OLDWAYS])} Old Ways · `
    + `${rest} nothing.${ground}`;
  $('tcBegin').hidden = fs.phase !== 'choose';
  $('tcBegin').textContent = `Begin in ${t.name}`;
  const prophet = $('tcProphet');
  prophet.hidden = fs.phase !== 'play';
  const cost = prophetCost(state);
  prophet.textContent = `Send a preacher (${cost} ✦)`;
  prophet.disabled = fs.devotion < cost;
}

function renderPerks() {
  const fs = state.faith;
  $('aspectLine').textContent = fs.aspect
    ? `Your creed is the creed of ${ASPECTS[fs.aspect].name}. ${ASPECTS[fs.aspect].desc}`
    : 'Your creed has not chosen what it is the word of yet.';
  const tree = $('perkTree');
  tree.className = 'hand';
  tree.innerHTML = fs.hand.length ? fs.hand.map((id) => {
    const p = PERKS.find((q) => q.id === id);
    const cost = perkCost(state, id);
    const afford = canBuy(state, id);
    const partner = p.excl ? PERKS.find((q) => q.id === p.excl) : null;
    const fork = partner && !fs.gone.includes(partner.id) && !has(state, partner.id)
      ? `<span class="excl">Closes ${partner.name} for good.</span>` : '';
    return `<button class="perk${p.aspect ? ' aspect' : ''}" data-perk="${p.id}" ${afford ? '' : 'disabled'}>`
      + `<b>${p.name}<em>${cost} ✦</em></b><span>${p.desc}</span>${fork}</button>`;
  }).join('') : '<p class="tiny">Every rite has been revealed and kept.</p>';
  $('perkPurse').textContent = `You have ${Math.floor(fs.devotion)} ✦.`;
  const kept = fs.perks.map((id) => PERKS.find((p) => p.id === id).name);
  const closed = fs.gone.map((id) => PERKS.find((p) => p.id === id).name);
  $('ownedPerks').textContent = (kept.length ? `Kept: ${kept.join(', ')}.` : 'No rites kept yet.')
    + (closed.length ? ` Closed: ${closed.join(', ')}.` : '');
  $('marks').innerHTML = marksFor(state).map((m) => {
    const at = fs.marks[m.id];
    const when = at != null && fs.started != null ? ` <small>${clock(Math.max(0, at - fs.started) / SIM_RATE)}</small>` : '';
    return `<li class="${at != null ? 'done' : ''}">${m.text}${when}</li>`;
  }).join('');
}

function togglePerks() {
  const el = $('perks');
  el.hidden = !el.hidden;
  if (!el.hidden) renderPerks();
}

function bindGameUi() {
  $('pauseBtn').onclick = () => { paused = !paused; syncPause(); };
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
