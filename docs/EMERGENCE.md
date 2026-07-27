# How a map settles itself

Nothing in Crossroads places a road, a junction or a town. There is no planner,
no zoning pass, no "found a settlement here" rule watching the map from above.
What there is instead is a handful of agents that each want something cheap and
local, and a world that is deliberately awkward to cross. Everything you end up
looking at — the trunk roads, the fords that became bridges, the four or five
towns and the empty quarters between them — falls out of the interaction.

This document is the map of those behaviours: what each actor wants, what it
measures, and which loop it closes. It is written to be read next to the code;
every section names the file it lives in.

---

## The actors

There are exactly three things with any agency, and they operate at very
different scales.

| Actor | Lives in | Decides | How often |
| --- | --- | --- | --- |
| **Caravan** | `js/sim/caravans.js` | Where to go next, and whether to stop for good | Once per leg |
| **Town** | `js/sim/towns.js` | What to build next; when to send people away, and whether they come back | Once a second |
| **Town's economy** | `js/sim/economy.js` | What its people spend the day doing | Once a second |
| **Resident** | `js/sim/residents.js` | Which building to walk to | Once per errand |

A caravan that has a `home` is on a trade circuit and does not re-decide — a
merchant's round is not an existential choice. Everything else scores its
options every time it arrives somewhere.

Residents are the least interesting on purpose: they exist so a town looks
inhabited, and they deliberately lay down no wear. Everything structural comes
from caravans and towns.

---

## 1. The caravan's objective function

A caravan is a wagon train — one pathing entity, five people per wagon, up to
three wagons. Most are a *single* wagon: `rollWagons` is weighted hard toward
one, so a lone wagon on a long road is the everyday sight and a train of three
reads as an event, which is what a founding party or a rich town's trade run
should look like. When a caravan finishes a leg it scores every option it has
and takes the best one. All three kinds of option are scored in the same
made-up units so they can be compared directly (`chooseGoal`).

**Join an existing town.**

```
vacancy × 0.85  +  prosperity × 0.30  −  distance × 1.55  ±  noise
```

`vacancy` is free beds; `prosperity` is how many buildings the place has. A town
with **no** free beds is not scored at all — it is removed from the list. That
is a hard rule rather than a low score, because a caravan standing in the middle
of a full town has a travel cost of zero, and "low but nearest" would win
forever.

**Found a town at the best empty crossroads.**

```
(arms − 2) × 0.95  +  wear × 0.80  +  room × 1.20
  +  frontier pressure × 2.8  −  distance × 1.55  −  1.95
```

Only caravans carrying ten or more souls may consider this — two wagons, so a
single wagon that stops in the middle of nowhere is just lost rather than the
founder of anything. `arms` is how many distinct
roads meet at the junction, `wear` is how well trodden it already is, `room` is
how far it is from the nearest existing town. The flat −1.95 is the cost of
starting from nothing, and it is what stops hamlets sprouting at every fork.

**Keep going, and leave by a far border.**

```
2.05 × exp(−walked / 3400)  −  distance × 0.54  ±  noise
```

Wanderlust decays with distance already travelled. A caravan that has just come
through a gate would rather see the map; one that has crossed most of it is
measurably readier to settle for whatever is on offer. A journey that ends in a
refusal adds a penalty to `walked`, so being turned away twice makes a caravan
markedly less fussy the third time.

**Why this shape.** The three options are in genuine tension. Early on there are
no towns, so *found* only competes with *cross*, and *cross* wins until a
caravan has walked far enough for wanderlust to decay — which is exactly when it
is standing somewhere in the middle of the map where roads have started to
cross. Later, towns with spare housing beat both, and the network densifies
instead of spreading.

---

## 2. Frontier pressure — the convergence dial

```js
frontierPressure(state) = 0.5 ^ (time / 2600)
```

This is the single most important number for making a map *finish*. It multiplies
the value of founding anything, and it halves every 2600 simulated seconds. A new
world is desperate for settlements; an old one would much rather you moved into
one that exists.

Without it, a long game slowly grows a village at every junction, because
junctions keep appearing as the road network thickens. With it, the map lands on
four or five towns inside the first couple of minutes at 16× and then *stops*,
which is the behaviour that matters — the count converges, and the same seed
lands on roughly the same number every time.

The pace is deliberately brisk — the first town usually lands inside a minute at
16×. Slowing it down is a matter of raising `FOUND_WEAR` in `state.js` (how worn
a junction must be before anyone will consider it) or shortening the wear rate
in `caravans.js`. Shortening `FRONTIER_HALFLIFE` is *not* the way to do it: that
changes where the run ends up, not how long it takes to get there.

`MAX_TOWNS` is the ceiling and it does get reached on a good map; the pressure
curve is what decides whether a *particular* map gets there or settles for four.
Both halves matter, and getting the balance wrong is easy in either direction.
Set the half-life too short and the frontier closes before the road network has
matured — an early version decayed so fast that a textbook crossroads (three
arms, well worn, 1288 units from the nearest town) sat unclaimed for the rest of
the run, because founding had been priced out before the junction existed. Set
it too long and every fork grows a hamlet.

---

## 3. Where traffic comes from, and how that changes

Three sources, and the balance between them inverts over a session.

**Borders.** `borderInterval` grows as `1 + (time / 900)^1.35`. At the start a
caravan arrives every ten to twenty seconds; an hour in, it is minutes between
them. These are the caravans that have never seen the map, so they are the ones
that carve routes across virgin ground.

**Emigration.** `considerEmigration` fires for any town whose beds are more than
72% full and which has at least three buildings. It takes a wagon-load of people
off `town.pop` for good and puts them on the road. This is the demographic
pressure valve, and it is the one that founds and fills other towns.

**Trade circuits.** `considerTrade` sends one or two wagons to the nearest
towns and home again. The people come *back*, so the run costs the town nothing
permanent.

That last distinction is doing more work than it looks. Emigration is capped by
how fast a town grows — about a caravan every couple of minutes, no matter how
prosperous the place is — because you cannot export people you do not have. The
first version of this had no trade circuits, and the late-game map emptied out:
four towns, two wagons on the road between them, and roads visibly decaying
because nothing was using them. Trade runs are limited only by how much there is
to trade with, so a busy town visibly out-trades a quiet one and the roads
between settlements stay alive.

The inversion matters because it changes the *shape* of the network. Border
traffic runs edge-to-edge and produces long straight corridors. Town traffic runs
settlement-to-settlement, and that is what fills in the connecting roads, wears
the junctions between towns, and eventually creates the crossroads that the next
town gets founded on.

---

## 4. The town's own loops

### Housing pressure beats the build plan

`TOWN_PLAN` is the story of a settlement — well, stall, signpost, inn, market,
smithy, and so on. But `nextBuild` checks beds first:

```js
if (free < 4 && houses <= trades + 1) return 'house';
```

A town that is filling up builds a house even when the plan says it is due a
smithy. Houses are also much cheaper than trades (`6 + n × 1.6` against
`10 + n × 4.5`), so a town can always shelter the people who already live there.

The `houses <= trades + 1` half of that is not decoration. Without it a town on
a busy road becomes a housing estate with a well in the middle — caravans keep
arriving, beds keep running short, and the build plan never gets a look in. The
first version had no cap and produced towns of thirteen buildings, eleven of
them houses. Capping homes against trades means a town that wants to grow has to
build something worth visiting first, and a town that cannot afford to simply
stops growing, which is a perfectly good outcome.

The visible consequence is that a settlement's shape reflects its history. A
town on a quiet spur stays a tidy little market. A town on the trunk road grows
a ring of housing around a working centre, because caravan after caravan chose
it and it kept having to build somewhere to put them.

### Growth is gated on housing, not on time

```js
growPopulation: pop rises only while free beds exist
```

People arrive to fill beds that exist and are *fed*, and not otherwise. So a
town that stops building houses stops growing, a town that outruns its fields
stops too, and a town that keeps up with both keeps producing the surplus that
leaves again as caravans. This is the loop that turns one lucky crossroads into
the busiest node on the map:

```
traffic → buildings → beds  ─┐
                             ├→ population → surplus → caravans → traffic
land → labour → food ────────┘
```

The left-hand branches are the two halves of the same gate, and which one binds
tells you what kind of place you are looking at. A town short of beds and swimming
in food is on a quiet spur and has not earned its next building. A town with
empty houses and an empty larder is on good road and bad ground.

### The tents are the wagons

A town's first housing is not built. It arrives: a founding caravan unhitches
its covered wagons and pitches them, one tent per wagon, five beds each. That is
the entire reason a brand new settlement is a settlement at all rather than a
patch of worn grass — and it means the size of the founding party literally is
the size of the first camp.

Timber houses then replace tents *one at a time, on the same plot*
(`growTown`). A town you are watching therefore visibly matures: the canvas
comes down, walls go up on the same square of ground, and the last tent
disappearing is a much better signal that a place has made it than any number in
the panel.

Caravans that *join* a town instead of founding one do not pitch anything — the
vacancy rule that gates joining would be meaningless if every arrival brought
its own bed. Their wagons are broken up for timber, and their people's
provisions go in the stores. Immigration visibly pays for the next house.

### Buildings are made of somewhere

Traffic used to buy everything. It still buys the *labour* — and still escalates
with the size of the town, so settlements slow down rather than exploding — but
buildings now also cost material, and material comes off the ground the town
happens to be standing on (`js/sim/economy.js`).

| | Comes from | Gate |
| --- | --- | --- |
| **Wood** | forest in reach, plus a trickle from scrub on open ground | none — nothing may hard-stall |
| **Stone** | mountain and hill | **a quarry has to be built first**, out of wood |
| **Food** | hunting, fishing, farming | eaten continuously by everybody |

The tier line runs straight through `TOWN_PLAN`. Stall, signpost, lumberyard and
inn are timber; the well, lamps, bakery, market, warehouse and smithy are
masonry, and none of them can be started until stone is actually coming in. So
the well — which used to be the first building in the game, unconditionally — is
now the moment a camp becomes a town, and it is *earned*: somebody had to cut
twenty-two wood, put up a quarry against the nearest rock, and cut stone.

The interesting case is a town with no rock within reach at all. It cannot
quarry, so `nextBuild` falls through to housing and it stays a village of homes
and fields — until a trade run turns up with stone in the back of a wagon. That
happens on its own, and watching a market get built in a settlement that has
never seen a mountain is the clearest thing in the game that trade is real.

### Everybody eats

`FOOD_PER_PERSON` is subtracted every second for every soul. Against that sit
three sources, and they are deliberately not interchangeable:

```
hunting   0.045 food per worker-second, capped by forest in reach
fishing   0.050                        , capped by water in reach
farming   0.150                        , capped by fields you have cleared
```

Hunting and fishing are free and immediate, and the ceilings are low on purpose:
the wild feeds a hamlet and never a city. Farming is three times the yield per
pair of hands and scales with how many fields exist — but a field has to be
*broken in* first, and clearing takes the same hands that would otherwise be
feeding people. A town that decides to farm gets hungrier before it gets fed.
Woodland plots are slower still, and pay out a load of timber when the stumps
finally come out.

Labour is allocated in one fixed order every upkeep tick — clearing, then food,
then materials — with each stage taking only as many hands as it can use. That
ordering is the whole of a town's economic "AI", and it produces what you want
without anything resembling a planner: a hungry town abandons the woodpile, a
fed one goes back to it, and a town with a plot half-cleared does both a little
worse until it comes in.

Two clauses close the loop. Population only grows while there is a real larder
in hand, so a town that outruns its fields simply stops. And a town that
actually empties its stores *shrinks*, and starts pushing caravans out
regardless of how full its beds are — which is how a badly sited settlement
seeds a better one somewhere else instead of sitting there starving.

### Trade moves material, not just people

A trade run now loads up with whatever its home town has most to spare, drops
part of the load at each stop, picks up that town's surplus for the next leg,
and unloads the rest when it gets home (`loadCargo` / `tradeAt` /
`unloadCargo`). The caravan card in the panel shows what is actually in the
wagons.

This is what makes the road network worth something in material terms rather
than only in traffic: a quarry town exports stone, a forest town exports timber,
and a town on open grass with a river in it exports food and buys both. Nothing
assigns those roles — they fall straight out of `surveyLand`, which is a pure
function of the seed and where somebody happened to stop.

### Sprawl is deliberate

`findPlot` grows the placement radius faster than the building count, and pushes
houses and haystacks 1.75× further out than trades. Footprints in `FOOTPRINT` are
generous relative to the sprites, and the sprites themselves are drawn at 0.72
world units per authored pixel (`UNIT` in `js/props.js`).

All three exist for the same reason: a town that packs its buildings shoulder to
shoulder reads as one brown blob at any zoom. Leaving gaps lets the roads run
*between* the buildings, which is what makes a settlement look like something
that grew around a crossroads instead of something that was stamped there.

---

## 5. The loop underneath all of it

The caravan decisions sit on top of the original mechanic, which has not changed:

1. A caravan crosses ground it would rather not cross, and wears it slightly.
2. Worn ground is cheaper to walk (`moveCost` blends terrain toward a flat road
   cost, so a made road over a mountain pass costs about what a road over grass
   costs).
3. Cheaper ground attracts the next caravan.
4. Wear decays with a 900-second half-life, so a route nobody uses fades.

Wagons are heavier than the walkers they replaced — `1.6 + 0.8 × wagons` times
the base rate — which is why a dozen caravans can wear in a network that used to
take fifty individual travellers. The weighting is front-loaded rather than
proportional because most caravans are one wagon: a lone wagon still has to lay
down enough of a rut to matter, or a map of mostly-single wagons would never
grow a road at all.

Terrain exists purely to make step 1 non-uniform. If every tile cost the same,
traffic would spread evenly and no road would ever form. Rivers and mountain
ridges are near-walls with a handful of gaps; the gaps are where the roads go;
where the roads cross is where somebody decides to stop.

---

## 6. Reading a run

Things worth watching for, in roughly the order they happen:

- **First few minutes.** Caravans fan out from the borders. Paths look
  scattered, because each caravan perturbs the cost field with its own seed
  (`js/sim/paths.js`) — without that jitter, identical journeys produce
  byte-identical routes and roads come out one pixel wide and unnaturally
  straight.
- **Consolidation.** Fords and passes go dark first: they are the only cheap way
  through, so every route is forced across the same handful of tiles.
- **The first town.** Almost always on a ford or a pass junction, and almost
  always founded by a border caravan that has walked far enough for its
  wanderlust to have decayed.
- **The camp.** For the first minute or two the new town is three tents and a
  stall, because tents are what the founding party arrived in. Watch for the
  first timber house going up *where a tent was*.
- **The first field.** Whatever the town could hunt and fish stops covering what
  it eats, and a plot appears out past the last house: scrub and stumps first,
  then furrows, then wheat. The town is measurably poorer while that is
  happening.
- **The trade road.** Once two towns exist, emigrant caravans start running
  between them, and a road appears that no border caravan would ever have worn.
  Trade runs carry real material along it, so this is also the moment a town
  with no rock in reach gets its first stone.
- **Settling down.** Frontier pressure drops, towns fill their beds, caravans
  spend longer on the road looking for somewhere with room. The map stops
  changing shape and starts thickening.

---

## Tuning

Roughly in order of leverage. The first two decide *how many towns*; the rest
decide what they look like.

| Where | Constant | Effect |
| --- | --- | --- |
| `sim/caravans.js` | `FRONTIER_HALFLIFE` | how long the map stays keen on new towns |
| `sim/caravans.js` | `W.founding` | flat cost of starting a settlement |
| `sim/caravans.js` | `ROAM_RANGE` | how far a caravan travels before it looks to settle |
| `sim/caravans.js` | `BORDER_BASE`, the slack curve | how fast immigration tapers |
| `sim/towns.js` | `TOWN_SPACING` | how far apart settlements must be |
| `sim/towns.js` | `HOUSE_BEDS`, `TENT_BEDS`, `EMIGRATE_FULL` | how much population a town holds before it exports |
| `sim/state.js` | the rate in `considerTrade` | how busy the roads between towns look |
| `sim/economy.js` | `FOOD_PER_PERSON` | the size of everything, really — it sets what a field is worth |
| `sim/economy.js` | `HUNT_CEILING`, `FISH_CEILING` | how big a town can get before it has to farm |
| `sim/economy.js` | `FIELD_YIELD`, `PER_WORKER.farm` | how much a cleared field is worth, and how many hands it takes |
| `sim/economy.js` | `CLEAR_RATE`, `STUMP_PENALTY` | how long a field costs before it pays |
| `sim/economy.js` | `MATERIALS` | the tier line: anything with stone in it needs a quarry first |
| `sim/economy.js` | `WOOD_PER_TILE`, `SCRUB_SHARE`, `QUARRY_YIELD` | how fast a town can build at all |
| `sim/economy.js` | `STORE_BASE`, `STORE_PER_WAREHOUSE` | how much a town can bank toward a big building |
| `sim/economy.js` | `WAGON_LOAD`, `TRADE_RESERVE` | how much material a trade circuit actually moves |
| `sim/towns.js` | `FOOTPRINT`, the `findPlot` radius | how much a town sprawls |
| `props.js` | `UNIT.building` | how much ground a building sprite covers |
| `sim/roads.js` | `WEAR_FULL`, `DECAY_HALFLIFE` | how fast roads form and how long they last |
