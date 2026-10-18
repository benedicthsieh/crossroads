// nature.js — the few things that change the map itself.
//
// Terrain is a pure function of the seed, and that rule is worth keeping: it is
// why a save is a few kilobytes. But a map that can never change is a map with
// no news on it, and the omens were reporting weather that left no mark. So a
// lightning strike now starts a fire that really burns the forest down, and a
// flood really drowns a few fields and moves a crossing.
//
// The rule survives as "terrain is the seed plus a list of scars". Every tile
// this file changes is appended to `state.nature.scars`, the snapshot stores
// that list, and `restore` regenerates the map and replays it. Anything derived
// from terrain keys on `terrain.rev`, which every scar bumps: the path guide in
// paths.js, a town's survey of its land, the renderer's bake and scenery.
//
// Disasters stay clear of towns. A town is its buildings and its buildings sit
// on tiles; flooding them would need a whole story about ruins that nothing
// else in the sim tells yet. So every town keeps a firebreak (`SHELTER`), and
// the drama happens in the country a town works rather than in its streets.

import { MAP, T, TILE, tileIndex } from './terrain.js';

/** Tiles of radius around a town centre that no fire or flood will touch. */
const SHELTER = 22;
/** Sim seconds between lightning strikes. Rare: a fire is meant to be news. */
const BOLT_GAP = [280, 560];
/** Sim seconds between floods. */
const FLOOD_GAP = [380, 760];
/** Chance a burning tile lights each forest neighbour, per second. */
const SPREAD = 0.3;
/** How much the wind favours one direction. */
const WIND = 1.9;
/** A fire that has burnt this many tiles gutters out. */
const FIRE_CAP = [120, 320];
/** Land tiles a flood claims. */
const FLOOD_TILES = [16, 40];

export function createNature() {
  return {
    fires: [],
    nextBolt: 200,
    nextFlood: 320,
    // [tileIndex, code] pairs, in the order they happened. See `scarCode`.
    scars: [],
    // What happened this second, for faith.js to turn into omens. Filled and
    // emptied inside one upkeep tick, so it is always empty in a snapshot.
    news: [],
  };
}

// ------------------------------------------------------------------- scars

/** Pack what a tile became into one small int: kind, ford, burnt. */
const scarCode = (kind, ford, burnt) => kind | (ford ? 8 : 0) | (burnt ? 16 : 0);

function burntOf(terrain) {
  if (!terrain.burnt) terrain.burnt = new Uint8Array(MAP.w * MAP.h);
  return terrain.burnt;
}

function setTile(terrain, i, code) {
  terrain.kind[i] = code & 7;
  terrain.ford[i] = code & 8 ? 1 : 0;
  burntOf(terrain)[i] = code & 16 ? 1 : 0;
  terrain.rev = (terrain.rev || 0) + 1;
}

/** Change one tile for good, and remember that it happened. */
function scar(state, i, kind, ford = 0, burnt = 0) {
  const code = scarCode(kind, ford, burnt);
  setTile(state.terrain, i, code);
  state.nature.scars.push(i, code);
}

/** Replay a saved scar list onto freshly generated terrain. */
export function applyScars(terrain, scars) {
  for (let k = 0; k + 1 < scars.length; k += 2) setTile(terrain, scars[k], scars[k + 1]);
}

/** Towns whose survey of the land is now out of date. Re-surveyed lazily. */
function resurvey(state, tiles) {
  if (!tiles.length) return;
  let x0 = MAP.w, y0 = MAP.h, x1 = 0, y1 = 0;
  for (const i of tiles) {
    const x = i % MAP.w, y = (i / MAP.w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  for (const t of state.towns) {
    const tx = t.x / TILE, ty = t.y / TILE;
    if (tx > x0 - 40 && tx < x1 + 40 && ty > y0 - 40 && ty < y1 + 40) t.land = null;
  }
}

function sheltered(state, tx, ty) {
  for (const t of state.towns) {
    const dx = t.x / TILE - tx, dy = t.y / TILE - ty;
    if (dx * dx + dy * dy < SHELTER * SHELTER) return true;
  }
  return false;
}

// ------------------------------------------------------------------ ticking

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

/** Called once per upkeep second from `step`. */
export function tickNature(state) {
  const nat = state.nature;
  if (!state.towns.length) return;
  for (const f of [...nat.fires]) burn(state, f);
  if (state.time >= nat.nextBolt) {
    // Kindling and Floodtide (faith.js) are the only rites that reach the
    // weather, and they only change how often it happens.
    const kindling = state.faith.perks.includes('kindling') ? 2 : 1;
    nat.nextBolt = state.time + state.rng.range(BOLT_GAP[0], BOLT_GAP[1]) / kindling;
    strike(state);
  }
  if (state.time >= nat.nextFlood) {
    const tide = state.faith.perks.includes('floodtide') ? 2 : 1;
    nat.nextFlood = state.time + state.rng.range(FLOOD_GAP[0], FLOOD_GAP[1]) / tide;
    flood(state);
  }
}

/** Somewhere in a town's country: near enough that people saw it, outside its firebreak. */
function nearSomeone(state, lo, hi) {
  const rng = state.rng;
  const t = rng.pick(state.towns);
  const a = rng.next() * Math.PI * 2;
  const d = rng.range(lo, hi);
  const tx = Math.round(t.x / TILE + Math.cos(a) * d);
  const ty = Math.round(t.y / TILE + Math.sin(a) * d);
  if (tx < 2 || ty < 2 || tx >= MAP.w - 2 || ty >= MAP.h - 2) return null;
  return { tx, ty, town: t };
}

// -------------------------------------------------------------------- fire

function strike(state) {
  const rng = state.rng;
  for (let attempt = 0; attempt < 30; attempt++) {
    const at = nearSomeone(state, SHELTER + 4, 90);
    if (!at) continue;
    const i = tileIndex(at.tx, at.ty);
    if (state.terrain.kind[i] !== T.FOREST || sheltered(state, at.tx, at.ty)) continue;
    const wind = rng.int(8);
    const fire = {
      id: state.nextId++,
      x: (at.tx + 0.5) * TILE, y: (at.ty + 0.5) * TILE,
      front: [i], burnt: 0, cap: Math.round(rng.range(FIRE_CAP[0], FIRE_CAP[1])),
      wind, near: at.town.id,
    };
    state.nature.fires.push(fire);
    state.nature.news.push({ kind: 'fire', x: fire.x, y: fire.y, fire: fire.id });
    state.events.push({ type: 'fire', id: fire.id, x: fire.x, y: fire.y, near: at.town.name });
    return fire;
  }
  return null;
}

/** One second of a fire: the front burns out, and lights what it touches. */
function burn(state, fire) {
  const { terrain, rng } = state;
  const next = [];
  const lit = new Set();
  const changed = [];
  for (const i of fire.front) {
    if (terrain.kind[i] !== T.FOREST) continue;
    scar(state, i, T.GRASS, 0, 1);
    changed.push(i);
    fire.burnt++;
    if (fire.burnt >= fire.cap) break;
    const x = i % MAP.w, y = (i / MAP.w) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= MAP.w || ny >= MAP.h) continue;
      const ni = ny * MAP.w + nx;
      if (lit.has(ni) || terrain.kind[ni] !== T.FOREST) continue;
      const p = SPREAD * (d === fire.wind ? WIND : 1) * (d >= 4 ? 0.7 : 1);
      if (!rng.chance(p) || sheltered(state, nx, ny)) continue;
      lit.add(ni);
      next.push(ni);
    }
  }
  // Capped so a fire racing through a big forest stays a fire and not a
  // second-by-second rewrite of half the region.
  fire.front = next.slice(0, 60);
  if (changed.length) {
    resurvey(state, changed);
    state.events.push({ type: 'terrain', tiles: changed });
  }
  if (!fire.front.length || fire.burnt >= fire.cap) {
    state.nature.fires.splice(state.nature.fires.indexOf(fire), 1);
    state.events.push({ type: 'fireOut', id: fire.id, x: fire.x, y: fire.y, burnt: fire.burnt });
  }
}

// ------------------------------------------------------------------- flood

/**
 * A river breaks its banks. The lowest ground beside it goes under for good —
 * a new mere where there were fields — and, half the time, the silt it drops
 * makes a ford somewhere nearby that was not there before. Roads that ran
 * through the flooded ground are gone; the one that crosses at the new ford is
 * waiting to be worn in.
 */
function flood(state) {
  const { terrain, rng } = state;
  for (let attempt = 0; attempt < 40; attempt++) {
    const at = nearSomeone(state, SHELTER + 4, 80);
    if (!at) continue;
    // Walk to the nearest river tile within a few tiles of the pick.
    let src = -1;
    for (let r = 0; r <= 6 && src < 0; r++) {
      for (let dy = -r; dy <= r && src < 0; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = at.tx + dx, y = at.ty + dy;
          if (x < 1 || y < 1 || x >= MAP.w - 1 || y >= MAP.h - 1) continue;
          const i = tileIndex(x, y);
          if (terrain.kind[i] === T.WATER && terrain.flow[i] > 0 && terrain.flow[i] < 1) { src = i; break; }
        }
      }
    }
    if (src < 0) continue;

    // Low ground first: a priority walk outward from the bank, cheapest
    // elevation next, over land only and never into a town's shelter.
    const want = Math.round(rng.range(FLOOD_TILES[0], FLOOD_TILES[1]));
    const sx = src % MAP.w, sy = (src / MAP.w) | 0;
    const seen = new Set([src]);
    const open = [src];
    const taken = [];
    while (open.length && taken.length < want) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (terrain.elev[open[k]] < terrain.elev[open[bi]]) bi = k;
      const cur = open.splice(bi, 1)[0];
      if (cur !== src) taken.push(cur);
      const x = cur % MAP.w, y = (cur / MAP.w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 1 || ny < 1 || nx >= MAP.w - 1 || ny >= MAP.h - 1) continue;
        if (Math.hypot(nx - sx, ny - sy) > 9) continue;
        const ni = ny * MAP.w + nx;
        if (seen.has(ni)) continue;
        seen.add(ni);
        const k = terrain.kind[ni];
        if (k === T.WATER || k === T.MOUNTAIN || sheltered(state, nx, ny)) continue;
        open.push(ni);
      }
    }
    if (taken.length < 6) continue;

    for (const i of taken) {
      scar(state, i, T.WATER);
      state.wear[i] = 0;
    }
    const changed = [...taken];

    // The silt bar: a river tile nearby with land on two opposite sides.
    if (rng.chance(0.6)) {
      for (let k = 0; k < 60; k++) {
        const x = sx + rng.int(25) - 12, y = sy + rng.int(25) - 12;
        if (x < 1 || y < 1 || x >= MAP.w - 1 || y >= MAP.h - 1) continue;
        const i = tileIndex(x, y);
        if (terrain.kind[i] !== T.WATER || terrain.ford[i]) continue;
        const land = (j) => terrain.kind[j] !== T.WATER;
        if (!((land(i - 1) && land(i + 1)) || (land(i - MAP.w) && land(i + MAP.w)))) continue;
        scar(state, i, T.WATER, 1);
        changed.push(i);
        break;
      }
    }

    resurvey(state, changed);
    state.events.push({ type: 'terrain', tiles: changed });
    state.nature.news.push({ kind: 'flood', x: (sx + 0.5) * TILE, y: (sy + 0.5) * TILE });
    state.events.push({
      type: 'flood', x: (sx + 0.5) * TILE, y: (sy + 0.5) * TILE, near: at.town.name,
      tiles: taken.length, ford: changed.length > taken.length,
    });
    return true;
  }
  return false;
}

// ------------------------------------------------------------- persistence

export function snapshotNature(nat) {
  return {
    nextBolt: Math.round(nat.nextBolt),
    nextFlood: Math.round(nat.nextFlood),
    scars: [...nat.scars],
    fires: nat.fires.map((f) => ({ ...f, front: [...f.front] })),
  };
}

export function restoreNature(snap) {
  const nat = { ...createNature(), ...(snap || {}), news: [] };
  nat.scars = [...nat.scars];
  nat.fires = nat.fires.map((f) => ({ ...f, front: [...f.front] }));
  return nat;
}
