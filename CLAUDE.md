# CLAUDE.md

Notes for whoever (or whatever) picks this up next. Read this before changing
anything — most of the non-obvious constraints below cost real time to
rediscover.

## Working preferences

- **Commit straight to `main`.** No feature branches, no PRs for this repo.
  Commit as you go with descriptive messages and push.
- **No build step, no dependencies, no backend.** Plain ES modules served as
  static files. Keep it that way; GitHub Pages serves the repo verbatim.
- Keep the prose in comments and docs explaining *why*, not *what*. The existing
  files set the tone.

## What this is

An idle/simulation game about roads. Nothing on the map is authored: travellers
cross terrain, walking wears the ground down, worn ground is cheaper to walk, so
traffic concentrates into roads, roads meet at crossroads, and towns grow on the
crossroads. Terrain (rivers, mountains, hills, forest, grassland) exists to make
some ground expensive so that traffic has a reason to concentrate at all.

`demo/` is the previous life of this repo — an art-style test with a hand-placed
town and live palette / outline / rim-light knobs. It still runs, it is still the
place to art-direct sprites, and the game's locked-in look was chosen with it.
The game itself no longer exposes those knobs.

## Layout

```
index.html          the game
demo/               the archived art-style test (its own index.html + sprites.html)
styles.css          shared panel styling

js/pixel.js         pixel-art rasteriser: grid, outline, rim light, colour maths
js/palette.js       three palettes; STYLE holds the locked look + live zoom/speed
js/sprites.js       villagers, critters, icons
js/props.js         buildings, stalls, trees, crags, rocks, reeds

js/sim/             GAME STATE. No DOM, no canvas, no Math.random().
  rng.js            seeded PRNG (state is one uint32) + stateless hash3
  terrain.js        map generation from a seed; tile costs; queries
  roads.js          the wear field: deposit, decay, cost blending, junctions
  paths.js          A* over the tile grid
  travelers.js      who is walking where, and the call to depositTrail()
  towns.js          founding a town at a junction, and growing it
  state.js          createState / step / snapshot / restore
  save.js           localStorage + pasteable share codes

js/render/          EVERYTHING VISUAL. Reads state, never writes it.
  camera.js         pan/zoom, and the bake-scale vs zoom split
  terrainPaint.js   bakes the map to one canvas at 1px per world unit
  roadPaint.js      incremental road overlay, repainted per dirty tile
  scenery.js        trees/crags/rocks derived from terrain (not stored)
  scene.js          draw order, depth sorting, night pass
js/game.js          boot, main loop, input, HUD, save buttons
```

## The rules that matter

**The sim/render split is the load-bearing decision.** `js/sim/` is plain data
and plain functions. It must stay free of DOM, canvas, timers and
`Math.random()`. That is what makes a snapshot cheap, a save honest, and a state
shareable between clients. If you find yourself wanting to stash a sprite, a
walk-cycle frame or a canvas on a traveller, put it in the renderer keyed by
`traveler.id` or `traveler.seed` instead.

**Determinism.** All sim randomness goes through `state.rng` (serialised) or
`hash3` (stateless, coordinate-derived). Two clients restoring the same snapshot
and stepping the same `dt` sequence stay in exact lockstep — there's a test for
it (see below). Adding a `Math.random()` inside `js/sim/` silently breaks that.

**Terrain is derived, never stored.** `generateTerrain(seed)` is pure. Snapshots
store the seed, not 60,000 tiles. Same for gates (`findGates`) and scenery
(`buildScenery`). The only thing the sim mutates about the map is `wear`.

**Bake scale ≠ zoom.** `STYLE.scale` is the integer size a sprite pixel is baked
at (1–3); `STYLE.zoom` is screen pixels per world unit (0.5–3). The renderer
closes the gap with one canvas transform of `zoom / scale`, so everything
downstream draws in baked-pixel space. Art only re-bakes when the zoom crosses
into a new integer bracket. `toScreen()` returns baked-pixel coords, not CSS
pixels — convert with `screenToWorld()` in game.js when handling mouse events.

**Roads live on their own canvas.** The terrain bake is static; wear changes
constantly. `roadPaint.js` keeps a full-size ImageData, repaints only tiles whose
wear moved by more than `EPS`, and does one `putImageData` with a dirty rect per
frame. Wear is sampled bilinearly, so touching one tile marks its neighbours
dirty too.

## Tuning knobs

If the emergent behaviour needs adjusting, these are the dials, roughly in order
of leverage:

| Where | Constant | Effect |
| --- | --- | --- |
| `sim/terrain.js` | `BASE_COST`, `FORD_COST` | how hard each terrain pushes back |
| `sim/terrain.js` | percentile thresholds in `generateTerrain` | terrain proportions (locked by percentile, so every seed matches) |
| `sim/roads.js` | `WEAR_PER_UNIT` (in travelers.js), `WEAR_FULL` | how fast roads form |
| `sim/roads.js` | `DECAY_HALFLIFE` | how long an unused road survives |
| `sim/roads.js` | `ROAD_COST` | what a finished road costs regardless of terrain |
| `sim/towns.js` | `FOUND_WEAR`, `FOUND_ARMS`, `TOWN_SPACING`, `MAX_TOWNS` | when and where towns appear |
| `sim/travelers.js` | `stride` in `findGates` | fewer gates = more concentrated traffic |

Current tuning lands 4–5 towns in roughly 5 real minutes at 16×.

## Running and testing

```sh
python3 -m http.server 8000     # ES modules need HTTP, not file://
```

There is no test suite. Verification is done by driving the real page with
Playwright — Chromium is preinstalled in the cloud environment at
`/opt/pw-browsers/chromium-*/chrome-linux/chrome`, so launch with an explicit
`executablePath`. The checks worth re-running after a sim change:

- **No console errors** and 60fps at whole-map zoom, after a few minutes at 16×.
- **Terrain proportions** across half a dozen seeds — import
  `/js/sim/terrain.js` in the page and count `kind` values. Water should be
  ~2%, mountain ~9%, hills ~15%, forest ~20%, grass ~54%.
- **Determinism**: snapshot a live game, `restore()` it twice, step both a few
  hundred ticks, and confirm rng state, wear sum and traveller positions match.
- **Save/load through the UI**: Save → New map → Load should come back to the
  original seed.

`window.CROSSROADS` exposes `state`, `snapshot()`, `renderer()` and `cam` for
poking at a running game from the console or from Playwright.

## Known rough edges

- Rivers are steepest-descent with an outlet bias rather than a proper
  priority-flood, so a few still end in a pond rather than reaching the edge.
- Town buildings can overlap slightly; the spacing check is a squashed-circle
  distance, not the actual sprite footprint.
- Travellers don't avoid each other. At a busy town gate they overlap.
- Residents wander between buildings; they don't have jobs. The demo's
  step-script behaviours (`demo/js/agents.js`) are the obvious thing to port
  when towns need an internal economy.
- Nothing culls a traveller whose path fails repeatedly; they beeline instead.
