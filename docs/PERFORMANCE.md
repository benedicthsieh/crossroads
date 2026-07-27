# Performance

What was actually slow, how that was established, and how to find out again.
Written after a round of work that stopped the frame cost growing with the age
of the map; the numbers below are from that round and are worth re-taking rather
than trusted forever.

The short version: **the simulation is not the expensive half, and never was.**
Everything that got worse over a session was in the renderer, and all of it was
work that scaled with how much of the *world* existed rather than with how much
of it was on screen.

## How to profile this game

Three things about the setup matter more than the tooling.

**Test on a phone-shaped profile, or you will measure nothing.** A desktop
browser runs this at a locked 60fps for eight minutes straight, which tells you
only that the frame fits in 16.7ms — not how much of it is left. Every
interesting number here came from a viewport of 390x844 at `deviceScaleFactor:
3` with the CPU throttled 4x, via CDP:

```js
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
```

**Get to the interesting part of the game fast.** The problems here only appear
once the map has roads, five towns and a couple of hundred buildings on it, and
waiting for that in real time is a waste of an afternoon. Two ways, in order of
preference:

- *Fast-forward headlessly.* A dynamic `import()` from the page resolves to the
  same module instance the game is already using, so you can step the live state
  without drawing anything. Six thousand sim-seconds takes about a minute:

  ```js
  await page.evaluate(async () => {
    const m = await import('/js/sim/state.js');
    for (let i = 0; i < 6000 * 30; i++) m.step(window.CROSSROADS.state, 1 / 30);
    window.CROSSROADS.renderer().rebuildWorld(window.CROSSROADS.state);
  });
  ```

- *Keep a late save.* `snapshot()` a matured game once, write it to
  `localStorage` under `crossroads.save.v3`, and reload — every run then starts
  from the same populated map, which also makes before/after comparisons honest.

Either way, **turn the speed slider up to 4x or 16x for the measurement itself**.
Traffic, road wear and building work all scale with sim time, so a slow session
simply never reaches the state where anything hurts.

**Measure work, not frame time.** With vsync in the way, `requestAnimationFrame`
deltas are 16.7ms right up until they are 33.3ms. Time the phases directly —
`step()`, `updateRoadLayer()`, `drawScene()` — and compare those. The night pass
is easy to isolate without instrumenting it: run `drawScene` at
`STYLE.timeOfDay = 0.5` and again at `0.02`, and take the difference.

`window.CROSSROADS` exposes `state`, `snapshot()`, `renderer()`, `cam` and
`STYLE`, which is enough to drive all of the above from Playwright.

For a breakdown *within* a phase, the CDP sampling profiler beats hand
instrumentation:

```js
await cdp.send('Profiler.start');            // setSamplingInterval ~80-100us
// ... run frames ...
const { profile } = await cdp.send('Profiler.stop');
```

Fold `profile.samples` against `profile.timeDeltas` into self-time per call
frame. Note that a headless Chromium here rasterises through SwiftShader, so
`drawImage` and fill-rate look far more expensive than they are on a real phone
GPU. Trust it for JavaScript, discount it for blitting.

## What was slow

Measured at ~6,600 sim seconds, five towns, ~190 buildings, ~9,500 road tiles.

| | before | after |
| --- | --- | --- |
| `updateRoadLayer` | 9–15 ms | 2.3–5.1 ms |
| pixels uploaded per frame | 1.3–2.7 M | 2–14 k |
| night pass, over daylight | +3.7 … +10.7 ms | +0.4 … +1.6 ms |
| live median frame | 50–67 ms | 33 ms |
| `step()`, one 16x frame | 1–2 ms | 1–2 ms |

The live median is the one to quote and the one that moves most between runs —
this box is shared and noisy, so it came out 1.5x better on one pass and 2x on
another. Take before and after in the same sitting or the number means nothing.

### The road layer was rescanning and re-uploading the world

Two separate costs, both paid every frame.

It found its work by comparing all 117,600 tiles of `wear` against what it had
already painted — about 3ms of pure scanning, more than the entire simulation it
was chasing. And having found the dirty tiles, it uploaded **one `putImageData`
covering the bounding box around them**. Twenty caravans are twenty smudges in
twenty different corners, so that box was routinely a third of the map. Sampled
live, the median upload was 36% of a 2520x1680 canvas, every frame, to repaint a
few hundred tiles.

Both are now avoided rather than reduced:

- The sim keeps a **touch log** — the tile indices `depositTrail` scuffed since
  the renderer last looked. It is transient and unserialised, exactly like
  `state.events`, and it is plain data, so `js/sim/` stays free of the renderer.
- **Decay is deliberately not logged.** It moves every tile at once, so logging
  it would be the full-map scan again under another name. A background sweep
  covers a thirty-second of the field per frame instead, which is ample for a
  900-second half-life. Since `EPS` now gates only fading, it could also be
  loosened from 0.02 to 0.06 — a thirtieth of the ramp from bare ground to
  finished road, well inside one step of the dither.
- Painted tiles are sorted and uploaded as **short runs along a tile row**. The
  call turns out to be cheap and the pixels expensive: 400 uploads of a 30x6 run
  cost 1.6ms between them, where the single 2520x460 rectangle they replace
  costs 2.8ms on its own. That ratio is why `MAX_RUNS` is 384 and why the
  fallback sends whole rows rather than one box round everything.

One thing that looked like free money and was not: skipping the neighbour marks
for sweep hits. Decay is uniform, so a tile that crossed `EPS` ought to sit
among neighbours that crossed it too — but a bright road tile crosses several
times as often as its faint verge, so the verge goes chronically stale instead
of catching up. It cost 0.11% more standing pixel difference and saved nothing
measurable. Both paths spread.

### The night pass got more expensive with every building ever built

`drawNight` called `createRadialGradient` once per lamp per frame, having walked
the entire lamp list to get there. `r.lights` grows monotonically for the whole
session — 0, 20, 100, 240, 300 and climbing — so a mature map spent longer
making gradients than drawing the world. This was the clearest "later days"
curve of the lot.

The falloff is identical for every lamp, so it is baked once per size and
blitted, with intensity carried on `globalAlpha` rather than the colour stops —
which is what lets one bake serve every darkness the clock passes through. A
pixel diff against the old path puts the mean difference at 5.4 out of a
possible 765 across three channels, in the soft part of a glow.

### Whole-map lists were being walked to draw a screenful

`r.statics` and `r.lights` both cover the entire map and both only get longer,
while the slice actually on screen stays about the same size: **3,349 statics to
draw fifteen of them**, 263 lamps to light 105. Both lists are already
depth-sorted, so both are now entered by binary search (`lowerBound`) and left
as soon as the depth window closes.

### Retiring a sprite emptied everybody's

Every distinct `(role, seed)` bakes its own walk cycle, and travellers churn, so
the cache has to be capped. It used to be emptied *wholesale* on reaching the
cap, which re-baked every villager and wagon on screen in a single frame — a
visible stall arriving every few hundred travellers. Looks now record the cache
keys they baked, so the least recently drawn can be dropped on their own.

## What was not slow

Worth stating plainly, because the intuition points the wrong way.

**The simulation.** A whole 16x frame — six `step()` slices — costs 1–2ms, or
under a tenth of the budget, and it does not grow: town count, resident count
and caravan count all plateau by about 2,000 sim seconds. Making caravans decide
less often would buy nothing; `chooseGoal` is already amortised behind leg
completions, and the two genuinely map-wide passes (`bestJunction`,
`countRoads`) are already on a 6-second timer. The expensive stretch for the sim
is the *first* few hundred seconds, when A* runs over virgin terrain with no
roads to follow and no JIT warm-up — the opposite end of the session from the
complaint.

**Animation sharing.** Sprites were already shared: baked once per
`(look, view, frame, item)` and reused by everyone wearing that look. The bug
was in eviction, not in sharing.

**WASM.** Not worth considering here. It would target the half of the program
that costs 5% of the frame, and it would mean a build step, which this repo
deliberately does not have. If JavaScript ever does become the bottleneck it
will be `paintTile`, and that one is a candidate for tightening in place long
before it is a candidate for another language.

## What is left

Roughly in order of what a real device would thank you for.

- **The two full-view blits.** Terrain and roads are each drawn as one scaled
  `drawImage` per frame. At whole-map zoom that downsamples a 2520x1680 source
  every frame. Caching a half-scale terrain bake for the zoomed-out brackets
  would cut the sampling work; the road layer would need the same treatment or
  it would drift out of register.
- **`paintTile`.** Now the largest single JavaScript cost in the frame (~11% of
  a throttled sample) at two `hash3` calls and a bilinear sample per pixel. The
  cheap early-out for wholly transparent tiles is in; a precomputed noise tile
  would be the next step, at some risk to the look.
- **The device pixel ratio.** `resizeCamera` caps at 2. Dropping to 1.5 on
  handsets would cut fill-rate by nearly half, but it is a visual-quality call
  and so is deliberately left alone.
- **`toScreen` allocates** a two-element array per call. It matters much less
  now that the per-frame call count is bounded by what is visible, but it is
  still on the hot path.

## Regression checks

Beyond the list in `CLAUDE.md`, one check is specific to the road layer and
worth keeping: run the incremental painter until it settles, snapshot
`layer.data`, then force `updateRoadLayer(layer, state, true)` and compare.

Read the result carefully, because there are two very different numbers here and
it is easy to quote the wrong one.

- **From a quiet map** — sim paused, painter drained — the two agree exactly:
  0 differing pixels out of 4,233,600. If that is not zero, a change is being
  *missed*, and the touch log or the sweep has a hole in it. Pause via the
  button, not just by not stepping: the page's own `requestAnimationFrame` loop
  keeps running between Playwright calls, and a map still moving under you
  yields a handful of differing pixels that mean nothing.
- **From a map that has been running hard** the two do not agree, and are not
  supposed to. A tile whose wear has drifted by less than `EPS` keeps the paint
  it has, so at any moment a fraction of the map is one threshold behind. After
  200 full sweep cycles that settles at **0.36% of pixels**, and it plateaus
  rather than accumulating (measured at 5, 20, 60, 150 and 200 cycles).

That second number is not new and was not introduced by any of this work: the
original code sits at 0.28% on the same test, with the same worst-case pixel
delta. `EPS` going from 0.02 to 0.06 is what moved it, and the difference is a
dither step on a road verge. Compare against the *previous build*, not against
zero — a `git worktree` of the old commit on a second port makes that a
two-minute job, and it is how every before/after number in this document was
taken.

## Keeping the loop fast

The checks themselves are trivial — determinism, the road-pixel comparison and
the convergence check are all sub-second. What costs time is *reaching* a mature
map: about 80 seconds, almost all of it in the first thousand sim seconds, where
A* runs over virgin terrain with no roads to follow and nothing is JIT-warm yet.

Two things cut it. Step at `1/20` rather than `1/30` — that is the largest slice
the real frame loop ever takes, so it walks the same path the game does, and it
is a third fewer steps. And **cache the matured state to a file**: `snapshot()`
it once, write the JSON, and on later runs push it into `localStorage` under
`crossroads.save.v3` and click Load. A full verification pass goes from 162
seconds to about 5, and every run starts from the identical map, which is worth
as much as the speed when comparing builds.
