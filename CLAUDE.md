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

An idle/simulation game about roads. Nothing on the map is authored: caravans
cross terrain, walking wears the ground down, worn ground is cheaper to walk, so
traffic concentrates into roads, roads meet at crossroads, and a caravan that
likes the look of a crossroads stops there for good. Terrain (rivers, mountains,
hills, forest, grassland) exists to make some ground expensive so that traffic
has a reason to concentrate at all.

Travel happens in **caravans** — one pathing entity, five souls per covered
wagon, up to three wagons. That is a scale decision, not a flavour one: a
hundred people crossing the map as a hundred sprites reads as an ant farm, and
as twenty wagons it reads as traffic. Every caravan scores its options at the
end of each leg (join a town, found one, push on to the far border) and takes
the best. `docs/EMERGENCE.md` is the written-up version of those behaviours and
is the right place to start if you are changing how the map settles.

`demo/` is the previous life of this repo — an art-style test with a hand-placed
town and live palette / outline / rim-light knobs. It still runs, it is still the
place to art-direct sprites, and the game's locked-in look was chosen with it.
The game itself no longer exposes those knobs.

## Layout

```
index.html          the game
demo/               the archived art-style test (its own index.html + sprites.html)
styles.css          shared panel styling
docs/EMERGENCE.md   what each actor wants, and which loops that closes

js/pixel.js         pixel-art rasteriser: grid, outline, rim light, colour maths
js/palette.js       three palettes; STYLE holds the locked look + live zoom/speed
js/sprites.js       villagers, critters, icons
js/props.js         buildings, wagons, stalls, trees, crags, rocks, reeds

js/sim/             GAME STATE. No DOM, no canvas, no Math.random().
  rng.js            seeded PRNG (state is one uint32) + stateless hash3
  terrain.js        map generation from a seed; tile costs; queries
  roads.js          the wear field: deposit, decay, cost blending, junctions
  paths.js          A* over the tile grid
  caravans.js       wagon trains, the objective function, and depositTrail()
  residents.js      the sampled crowd inside a town
  towns.js          founding, building, housing and population
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
walk-cycle frame or a canvas on a caravan, put it in the renderer keyed by
`caravan.id` or `caravan.seed` instead. `caravanParts()` in `render/scene.js` is
the model: the sim stores one position and a heading, and where each wagon and
drover actually sits is derived from the seed at draw time.

**Determinism.** All sim randomness goes through `state.rng` (serialised) or
`hash3` (stateless, coordinate-derived). Two clients restoring the same snapshot
and stepping the same `dt` sequence stay in exact lockstep — there's a test for
it (see below). Adding a `Math.random()` inside `js/sim/` silently breaks that.

**Terrain is derived, never stored.** `generateTerrain(seed)` is pure. Snapshots
store the seed, not 117,600 tiles. Same for gates (`findGates`) and scenery
(`buildScenery`). The only thing the sim mutates about the map is `wear`.

**Population is a number, not a crowd.** `town.pop` is who lives there;
`js/sim/residents.js` walks a capped *sample* of them around. That gap is the
whole reason the map stopped looking like an ant farm — a town of eighty shows a
dozen figures. Never make the drawn residents authoritative.

**Bake scale ≠ zoom ≠ world size.** Three separate things, and conflating any
two of them will bite:
- `STYLE.scale` — the integer size a sprite pixel is *baked* at (1–3).
- `STYLE.zoom` — screen pixels per world unit. Continuous (0.35–3), driven by
  the slider, the wheel and pinch. The renderer closes the gap to `scale` with
  one canvas transform of `zoom / scale`, so everything downstream draws in
  baked-pixel space. `bakeScaleFor()` has hysteresis so a pinch that settles on
  a bracket boundary doesn't re-bake the world several times a second.
- `UNIT` in `props.js` — world units per *authored* pixel, per prop family.
  Buildings sit at 0.72, so the same art claims less ground. `prop()` therefore
  returns `dw`/`dh`, and callers **must** use the nine-argument `drawImage` or
  the shrink is silently lost. `propMeta()` and `propLights()` come back in
  world units, already scaled.

`toScreen()` returns baked-pixel coords, not CSS pixels — convert with
`screenToWorld()` in game.js when handling pointer events.

**Roads live on their own canvas.** The terrain bake is static; wear changes
constantly. `roadPaint.js` keeps a full-size ImageData, repaints only tiles whose
wear moved by more than `EPS`, and does one `putImageData` with a dirty rect per
frame. Wear is sampled bilinearly, so touching one tile marks its neighbours
dirty too.

## Tuning knobs

`docs/EMERGENCE.md` explains *why* each of these matters. Roughly in order of
leverage:

| Where | Constant | Effect |
| --- | --- | --- |
| `sim/caravans.js` | `FRONTIER_HALFLIFE` | how long the map stays keen on new towns — the main convergence dial |
| `sim/caravans.js` | `W` (the weight table) | the whole join / found / keep-going trade-off |
| `sim/caravans.js` | `ROAM_RANGE` | how far a caravan goes before it starts looking to settle |
| `sim/caravans.js` | `BORDER_BASE` + the slack curve | how fast immigration from off-map tapers |
| `sim/caravans.js` | `MAX_CARAVANS`, `SOULS_PER_WAGON` | how busy the map *looks* |
| `sim/caravans.js` | `stride` in `findGates` | fewer gates = more concentrated traffic |
| `sim/terrain.js` | `MAP`, `BASE_COST`, `FORD_COST` | map size; how hard each terrain pushes back |
| `sim/terrain.js` | percentile thresholds in `generateTerrain` | terrain proportions (locked by percentile, so every seed matches) |
| `sim/roads.js` | `WEAR_PER_UNIT` (in caravans.js), `WEAR_FULL` | how fast roads form |
| `sim/roads.js` | `DECAY_HALFLIFE`, `ROAD_COST` | how long an unused road survives; what a finished one costs |
| `sim/towns.js` | `TOWN_SPACING`, `MAX_TOWNS` | how far apart towns must be, and the hard cap |
| `sim/towns.js` | `HOUSE_BEDS`, the house cap in `nextBuild` | housing supply, and how much of a town is homes |
| `sim/towns.js` | `FOOTPRINT`, the `findPlot` radius | how much a town sprawls |
| `props.js` | `UNIT.building` | how much ground a building sprite covers |

Current tuning lands 4–5 towns in roughly 4–5 real minutes at 16×, on a
420×280-tile map.

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
  hundred ticks, and confirm rng state, wear sum, caravan and resident positions
  match.
- **Save/load through the UI**: Save → New map → Load should come back to the
  original seed.
- **Towns converge**: 4–5 towns after ~5 real minutes at 16×, and a town that is
  mostly houses with a well in it means the cap in `nextBuild` has drifted.
- **A caravan can always get somewhere.** The failure mode to watch for is a
  caravan that decides, arrives, is refused, and re-decides in the same tick —
  it shows up as `state.stats.paths` climbing into the tens of thousands. Both
  refusal paths in `arriveLeg` go through `turnedAway`, which rests first for
  exactly this reason.

`window.CROSSROADS` exposes `state`, `snapshot()`, `renderer()` and `cam` for
poking at a running game from the console or from Playwright.

## Known rough edges

- Rivers are steepest-descent with an outlet bias rather than a proper
  priority-flood, so a few still end in a pond rather than reaching the edge.
- Town buildings can overlap slightly; the spacing check is a squashed-circle
  distance, not the actual sprite footprint.
- Caravans don't avoid each other, and the wagons in a train are laid out along
  the caravan's *current* heading rather than along the path it actually walked.
  Round a sharp corner the tail cuts across the bend.
- Residents wander between buildings; they don't have jobs. The demo's
  step-script behaviours (`demo/js/agents.js`) are the obvious thing to port
  when towns need an internal economy.
- Nothing culls a caravan whose path fails repeatedly; they beeline instead.
- A caravan that leaves by a far gate takes its people off the map for good.
  Population therefore leaks out over a long session, and towns refill from
  their own growth. It reads fine, but it is not a closed economy.
- `demo/` opts out of the building shrink by setting `UNIT` back to 1 at
  startup (see the top of `demo/js/demo.js`), because its town is hand-placed
  at the old scale. Anything new that imports `props.js` needs to decide which
  side of that line it is on.
