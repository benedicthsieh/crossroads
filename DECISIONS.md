# Decisions

Why this demo is built the way it is. Kept short on purpose — the reasoning
behind choices that would otherwise look arbitrary, and the ones worth
revisiting once the real game starts.

## Foundations

**Static files, no build step, no dependencies.** ES modules straight to the
browser. The demo exists to judge an art style, and a toolchain would be pure
overhead. It also means GitHub Pages serves the repo verbatim.

**All art is generated in code as pixel art at runtime. No image files.**
The big one. Trade-off accepted knowingly: hand-drawn sprites would look better
per-sprite, but code-generated art made every style parameter a live knob —
palette, pixel size, outline mode, rim light, shadows all re-bake the whole town
in about a second, so two looks can be compared back to back. For an art *test*
that iteration speed beat per-sprite quality. If the style gets locked in,
exporting these to real sprite sheets and hand-editing them is the natural next
step.

**Integer scaling only, smoothing off.** Sprites authored at ~20px tall, blitted
at 2–6×. A pixel is always a crisp square.

## The look

**Selective outlining over a black keyline.** Silhouettes are wrapped in a
*darker version of whatever pixel they touch* (`pixel.js`). Softer than flat
black and it keeps colour in the shadows. The `Outline` control switches to a
hard inked line for comparison.

**Rim light as a whole pass, not per-sprite shading.** Any pixel whose
sky-facing neighbour is empty gets brightened. One rule, applied everywhere,
fakes a single soft light from above for free.

**Faces get a lighter tone than the body.** 1px eyes were illegible on the
darker skin tones. The face runs ~8% lighter than the body skin so eyes read on
every tone in the palette, rather than lightening the palette itself.

**The fringe row is darker than the rest of the hair.** A structural hairline
separates hair from forehead even when the two tones are close in value. This
replaced an earlier attempt that recoloured hair for contrast — that turned
dark-skinned villagers grey-haired, which was worse.

**Trousers come from their own colour list, not the shirt palette.** Legs kept
landing the same tone as the top, and the whole villager read as one block.

**Kids are the adult head on a shorter torso and legs.** That ratio is what
makes them read as children instead of small adults.

## Buildings

**Oblique 3/4 projection, not true isometric.** The front wall stays face-on so
doors, windows and signage stay readable at 3×; only the depth axis recedes,
up-and-right at a 2:1 pixel slope. Full isometric would have clashed with the
flat top-down ground, and would have made every facade harder to read.

**One shared `shell()` for every building.** The projection cannot drift between
buildings, and depth/roof geometry is fixed in one place.

**Side walls are derived from the front colour and pushed much darker.** First
attempt reused the front wall's own shading and the corner disappeared — the
building read flat again. The value step across the corner *is* the 3D effect.

**Hipped roofs still draw the end triangle.** Skipping it (it isn't a gable)
left the top of the side wall bare, which was the market hall's worst bug.

**Specialised buildings are distinguished by silhouette, not detail.** At this
size, colour and trim don't survive; an open front (lumberyard), an oversized
chimney (smithy), a hip roof on posts (marketplace) and cart-sized doors
(warehouse) do.

## World and sim

**Terrain is baked once.** `bakeGround()` paints the whole map at one logical
pixel per pixel — grass speckle, road dither, wheel ruts, worn patches — then
upscales. The frame loop draws terrain in a single blit.

**Roads are a distance field, not tiles.** `roadness()` returns signed distance
to the nearest road segment, which gives dithered edges, worn verges and
walkability from one function. It also means roads can later be *added* at
runtime without a tile grid to maintain.

**Depth sorting by ground contact point, with a `sortY` override.** That
override is how a stallholder sits between their own awning and their own
counter — the alternative was splitting every prop or accepting hidden NPCs.

**Behaviour is a list of steps, not a state machine or behaviour tree.** Each
villager runs a looping script of `go` / `wait` / `take` / `trade`. Shallow on
purpose, but it's the same shape a real jobs-and-routes sim needs.

**`enter` and `then` hooks are distinct.** `then` fires when a step *finishes*;
using it to switch the bakery oven on meant the oven lit just as baking ended.

**No pathfinding.** Straight lines plus a gentle separation force. The map is
laid out so it's enough. Revisit when buildings stop being hand-placed.

**Every trade is visible.** Goods and coin pop above both traders' heads and the
panel tallies them. An idle game's economy has to be legible at a glance, so
the demo treats that as an art requirement, not a debug feature.

## Performance

Both fixes came from measuring, not guessing — the widest zoom was at 48fps.

**Shadows are baked to cached canvases and blitted.** A path fill per sprite per
frame was the single biggest cost in a wide shot. Caching also bought a real
gradient for the soft mode.

**Viewport size is cached, not recomputed.** The coordinate transforms run a few
thousand times a frame and were each allocating an object. This alone took the
widest zoom from 48 to 60fps.

## Known rough edges

- Villagers bunch up at a busy stall; separation is a nudge, not collision.
- The straw hat is wide enough to dominate the side-view silhouette.
- Worn-dirt patches under buildings are ellipses, so they don't follow the
  buildings' parallelogram footprints.
- Nothing is persisted; reloading resets the town.

## The thing this is all for

The town is hand-placed. The actual premise — roads accumulating traffic,
junctions sprouting buildings — is unbuilt. `world.js` is where it goes:
`ROADS` becomes state the sim edits rather than a constant, and `PROPS` gets
placed by rules instead of by hand. The distance-field roads and the
step-script behaviours were both chosen with that in mind.
