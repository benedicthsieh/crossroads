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

// --------------------------------------------------------------- lifecycle

function adoptState(next) {
  state = next;
  if (!renderer) renderer = createRenderer(state);
  // Always rebake: a loaded game may have a different seed, and the terrain
  // canvas belongs to the seed it was painted from.
  renderer.rebakeArt(state);
  renderer.rebuildWorld(state);
  // Open on the middle of the map; there is nothing else to look at yet.
  const focus = state.towns[0] || { x: WORLD.w / 2, y: WORLD.h / 2 };
  cam.x = focus.x;
  cam.y = focus.y;
  clampCamera(cam);
  refreshHud();
  refreshTowns();
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

  if (!paused) {
    const dt = raw * STYLE.speed;
    // Long steps at high speed are split so travellers can't tunnel through a
    // tile without laying any wear down in it.
    const slices = Math.min(8, Math.ceil(dt / 0.05));
    for (let i = 0; i < slices; i++) step(state, dt / slices);
    updateFx(raw);
    tickCaravans(renderer, state, raw);
    tickSmoke(renderer, state, raw);
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

/** Follow whatever is under this point: a caravan, or somebody on foot. */
function pickAt(cssX, cssY) {
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
  el.textContent = msg;
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
}

function bindUi() {
  const zoom = document.getElementById('zoom');
  zoom.max = String(ZOOM_STOPS.length - 1);
  zoom.oninput = () => applyZoom(+zoom.value);

  const speed = document.getElementById('speed');
  speed.value = String(STYLE.speed);
  speed.onchange = () => { STYLE.speed = +speed.value; };

  const labels = document.getElementById('labels');
  labels.checked = STYLE.labels;
  labels.onchange = () => { STYLE.labels = labels.checked; };

  document.getElementById('pause').onclick = () => { paused = !paused; syncPause(); };

  document.getElementById('newWorld').onclick = () => {
    adoptState(createState());
    toast('New map generated.');
  };

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

// -------------------------------------------------------------------- boot

dpr = resizeCamera(cam, canvas, g);
bindUi();
applyZoom(DEFAULT_STOP);
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
};
