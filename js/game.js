// game.js — boot, main loop, input and HUD.
//
// The whole file is renderer-side. It owns the canvas, the camera, the DOM and
// the clock; it calls `step(state, dt)` and then draws whatever came back. It
// never reaches into the sim to nudge a traveller or place a road, which is
// what keeps "save the game" honest: everything this file holds is either
// derived from the state or is a view setting nobody needs restored.

import { STYLE } from './palette.js';
import { createState, step, snapshot } from './sim/state.js';
import { WORLD, TERRAIN_NAMES, MAP, TILE } from './sim/terrain.js';
import { saveLocal, loadLocal, hasLocal, toShareCode, fromShareCode, saveSize } from './sim/save.js';
import {
  makeCamera, resizeCamera, applyTransform, toScreen, toWorld, clampCamera,
  ZOOM_STOPS, DEFAULT_STOP, bakeScaleFor,
} from './render/camera.js';
import { createRenderer, drawScene, tickSmoke, updateFx, updateRoadLayer } from './render/scene.js';

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

function applyZoom(stop) {
  zoomStop = Math.max(0, Math.min(ZOOM_STOPS.length - 1, stop));
  const next = ZOOM_STOPS[zoomStop];
  const bake = bakeScaleFor(next.zoom);
  const rebake = bake !== STYLE.scale;
  STYLE.zoom = next.zoom;
  STYLE.scale = bake;
  applyTransform(cam, canvas, g, dpr);
  if (rebake && renderer) {
    renderer.rebakeArt(state);
    renderer.rebuildWorld(state);
  }
  clampCamera(cam);
  const slider = document.getElementById('zoom');
  slider.value = String(zoomStop);
  document.getElementById('zoomVal').textContent = next.label;
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
    const t = state.travelers.find((x) => x.id === cam.follow);
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

canvas.addEventListener('pointerdown', (e) => {
  cam.dragging = true;
  cam.lx = e.clientX;
  cam.ly = e.clientY;
  cam.moved = 0;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
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

canvas.addEventListener('pointerup', (e) => {
  cam.dragging = false;
  if (cam.moved > 4) return;
  const r = canvas.getBoundingClientRect();
  const [wx, wy] = screenToWorld(e.clientX - r.left, e.clientY - r.top);
  let best = null, bestD = 16;
  for (const t of state.travelers) {
    const d = Math.hypot(t.x - wx, (t.y - 6 - wy) * 0.8);
    if (d < bestD) { bestD = d; best = t; }
  }
  cam.follow = best ? best.id : null;
  renderer.follow = cam.follow;
  refreshHud();
});

/** CSS pixels within the canvas -> world units. */
function screenToWorld(cssX, cssY) {
  const z = STYLE.zoom / STYLE.scale;
  return toWorld(cam, cssX / z, cssY / z);
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  applyZoom(zoomStop + (e.deltaY > 0 ? -1 : 1));
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

function refreshHud() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('statTime', clock(state.time));
  set('statTowns', state.towns.length);
  set('statPop', state.travelers.length);
  set('statTravelers', state.stats.travelers);
  set('statRoads', state.stats.roadTiles);
  set('statTrades', state.stats.trades);
  set('statFps', fps);

  const card = document.getElementById('card');
  const t = cam.follow != null ? state.travelers.find((x) => x.id === cam.follow) : null;
  if (t) {
    card.hidden = false;
    const tile = state.terrain.kind[
      Math.min(MAP.h - 1, Math.floor(t.y / TILE)) * MAP.w + Math.min(MAP.w - 1, Math.floor(t.x / TILE))
    ];
    const leg = t.legs && t.legs[t.leg];
    const heading = !leg ? 'looking around'
      : leg.kind === 'town' ? `bound for ${(state.towns.find((x) => x.id === leg.townId) || {}).name || 'town'}`
        : leg.kind === 'gate' ? 'leaving by the far road' : 'running an errand';
    set('cardName', `#${t.id}`);
    set('cardRole', t.resident ? `${t.role}, local` : t.role);
    set('cardItem', `${heading} · crossing ${TERRAIN_NAMES[tile]}${t.carry ? ` · carrying ${t.carry}` : ''}`);
  } else {
    card.hidden = true;
  }
}

let lastTownCount = -1;

function refreshTowns() {
  const list = document.getElementById('townList');
  list.innerHTML = '';
  if (!state.towns.length) {
    list.innerHTML = '<li class="quiet">None yet — the roads have to meet first.</li>';
    return;
  }
  for (const t of state.towns) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${t.name}</b> — ${t.buildings.length} building${t.buildings.length === 1 ? '' : 's'},
      founded at ${clock(t.founded)}`;
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
