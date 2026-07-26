# Decisions

Why this is built the way it is. Kept short on purpose — the reasoning behind
choices that would otherwise look arbitrary, and the ones worth revisiting.

The first half of this file is about the game engine. The art decisions below it
were made during the art test that now lives in `demo/`, and still hold.

## Foundations

**Static files, no build step, no dependencies.** ES modules straight to the
browser. It also means GitHub Pages serves the repo verbatim.

**Game state is separated from the renderer, strictly.** `js/sim/` has no DOM,
no canvas, no timers and no `Math.random()`; `js/render/` reads state and never
writes it. This was the first thing built and everything else was shaped around
it, because it is what buys three things at once: the game can be snapshotted
between any two frames, resumed from localStorage, and handed to another client
as a string. Retrofitting that separation later is close to impossible — the
sprite you cached on a traveller becomes the reason the save doesn't round-trip.

**All sim randomness runs through one seeded generator whose state is a single
uint32.** Four bytes in the save file, and two clients restoring the same
snapshot then stay in exact lockstep. Anything that has to be random *from its
coordinates* rather than from a position in a stream (terrain noise, dither,
a traveller's private path jitter) uses a stateless hash instead.

**Terrain is a pure function of the seed and is never stored.** A 300x200 map is
60,000 tiles; saving it would dwarf everything else in the file. Saves store the
seed plus the one thing the sim actually changes — road wear — and regenerate
terrain, gates and scenery on load. That takes a save of a busy map to about
40 kB, most of which is run-length-encoded wear.

## The map

**Terrain exists to be annoying in specific places.** Roads only form where
traffic concentrates, and traffic only concentrates if some ground is much worse
than other ground. Hence the cost ladder: grass 1, forest 2.2, hills 3.2,
mountain 8, river 60 — with a ford at 5. Mountains and rivers are not walls;
they're detours expensive enough that everyone chooses the same gap.

**Fords are placed deliberately, every ~26 tiles of river.** Left to chance, a
river is either impassable or porous everywhere, and neither produces a
crossroads. A small number of known crossings is what makes traffic converge,
and convergence is the whole game.

**Rivers are steepest descent with an outlet bias.** Pure steepest descent dies
in the first basin it finds and leaves a chain of ponds, which is no barrier at
all. Biasing each river toward the nearest map edge keeps terrain in charge of
the route while guaranteeing the river reaches the edge and cuts the map. Two
bugs were worth the comments they now carry: without excluding already-visited
tiles, the meander jitter makes a river oscillate between two squares and spend
its whole step budget there; and the bed has to be carved downward as it goes or
the river runs uphill.

**Terrain proportions are set by percentile, not by absolute height.** Every
seed then lands the same mix — ~9% mountain, ~15% hills, ~20% forest, ~54%
grass, ~2% water — so "mostly passable" is a property of the generator rather
than something to get lucky with.

## Roads and towns

**There is no road-building code.** There is only wear: walking scuffs the
ground, worn ground is cheaper, cheaper ground attracts the next traveller.
Every road on the map is that loop running.

**Road cost blends toward a flat road cost rather than scaling terrain down.**
A finished road over a mountain pass should cost about what a road over grass
costs — that's what makes a pass worth wearing in at all, and what turns a busy
ford into a bridge.

**Wear spills onto the four neighbours at about a third strength.** That is what
makes a road *widen* with traffic instead of staying one tile across forever: a
rarely used track never lifts its neighbours over the visible threshold, a trunk
road drags a two-tile verge along with it.

**Each traveller perturbs the cost field by ±12%, seeded from their own id.**
Without it, identical journeys produce byte-identical paths and the first road
comes out one tile wide and unnaturally straight — a hairline, not a road. The
jitter lets early crossings fan out; traffic consolidates them afterwards.

**Junctions are counted as arcs on a ring, not as neighbouring tiles.** A road
passing through gives two opposite arms; a real crossroads gives three or more.
Counting adjacent road tiles instead just measures how wide the road is.

**Towns are founded, not placed.** A junction with three or more arms and enough
traffic gets a well; buildings accumulate from the traffic that keeps arriving,
each one dearer than the last so towns slow down instead of exploding. Current
tuning lands 4–5 towns on a map in about five minutes at 16x.

## Rendering

**Bake scale and zoom are separate numbers.** Pixel art wants sprites baked on
whole pixels; a map with five towns on it wants to zoom out to half size. So
`STYLE.scale` is the integer size a sprite pixel is baked at (1–3) and
`STYLE.zoom` is screen pixels per world unit (0.5–3), and the renderer closes
the gap with one canvas transform. Art only re-bakes when zoom crosses an
integer bracket, so dragging the slider stays smooth.

**The zoom control is named, not numbered.** "2.0x pixel size" is a renderer
implementation detail; the stops are labelled Whole map / Region / Roads / Town
/ Street / Close up because that's what the player is actually choosing.

**Terrain is baked at one pixel per world unit and blitted scaled.** A
pre-upscaled 3x version of the map would be a 13-megapixel canvas that has to be
rebuilt every time the zoom bracket changes. Blitting only the visible slice
costs one `drawImage` per frame instead.

**Roads live on their own canvas, repainted per dirty tile.** They're the one
part of the map that changes constantly. A full-size ImageData plus a per-tile
dirty check plus one `putImageData` with a dirty rect keeps a map with 9,000
road tiles on it at 60fps.

**Wear is sampled bilinearly when painting, and dithered with a Bayer matrix.**
Per-tile sampling gives a staircase of six-pixel squares; a pure hash threshold
gives TV static. Together they give a track that fades in at the verges.

**Scenery is derived from terrain, not stored, and disappears under roads.**
Trees and crags come from the same seed, so they cost nothing to save. Anything
standing on a worn tile stops being drawn, which reads as the road having
cleared it — a free detail that came out of the derivation rather than being
designed.

**Bridge decking is deliberately lighter than the road either side.** A plank
pattern in road-brown over blue water just reads as more road. The point of a
bridge is that you can see where the network had to build something.

## The look (decided in `demo/`, now locked)

**All art is generated in code as pixel art at runtime. No image files.**
Trade-off accepted knowingly: hand-drawn sprites would look better per-sprite,
but code-generated art made every style parameter a live knob, so two looks
could be compared back to back. For an art *test* that iteration speed beat
per-sprite quality.

**Selective outlining over a black keyline.** Silhouettes are wrapped in a
*darker version of whatever pixel they touch*. Softer than flat black and it
keeps colour in the shadows.

**Rim light as a whole pass, not per-sprite shading.** Any pixel whose
sky-facing neighbour is empty gets brightened. One rule, applied everywhere.

**Faces get a lighter tone than the body**, and **the fringe row is darker than
the rest of the hair.** Both exist so 1px eyes and the hairline read on every
skin tone in the palette, rather than lightening the palette itself. An earlier
attempt that recoloured hair for contrast turned dark-skinned villagers
grey-haired, which was worse.

**Oblique 3/4 projection for buildings, not true isometric.** The front wall
stays face-on so doors and windows read; only the depth axis recedes. One shared
`shell()` means the projection can't drift between buildings.

**Side walls are derived from the front colour and pushed much darker.** The
value step across the corner *is* the 3D effect; reusing the front wall's own
shading made buildings read flat.

**Specialised buildings are distinguished by silhouette, not detail.** At this
size colour and trim don't survive; an open front, an oversized chimney, a hip
roof on posts and cart-sized doors do.

**Depth sorting by ground contact point, with a `sortY` override.** That
override is how a stallholder sits between their own awning and their own
counter.

**Shadows are baked to cached canvases and blitted.** A path fill per sprite per
frame was the single biggest cost in a wide shot.

## Known rough edges

- A few rivers still end in a pond rather than reaching the map edge; a proper
  priority-flood would fix it.
- Town buildings can overlap slightly — the spacing check is a squashed-circle
  distance, not the real sprite footprint.
- Travellers don't avoid each other and pile up at a busy town.
- Residents wander between buildings but have no jobs. Towns have no internal
  economy yet.
- At the widest zoom the map is smaller than a large viewport, so it sits in a
  letterbox.

## The thing this is all for

The map now builds itself. What it doesn't have is anything to *do*: no player,
no goods moving between towns, no reason for one town to outgrow another beyond
the accident of where the roads went. The demo's step-script behaviours
(`demo/js/agents.js`) are the shape that goes into towns next, and the sim/state
split is what should let a real economy be added without the save format or the
renderer having to care.
