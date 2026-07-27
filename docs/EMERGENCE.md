# How a map settles itself

Nothing in Crossroads places a road, a junction or a town. There is no planner,
no zoning pass, no "found a settlement here" rule watching the map from above.
What there is instead is a handful of agents that each want something cheap and
local, and a world that is deliberately awkward to cross. Everything you end up
looking at — the trunk roads, the fords that became bridges, the dozen or so
towns and the empty quarters between them — falls out of the interaction.

One thing *is* authored, and it is worth naming up front because everything in
section 2 leans on it: the map is divided into four **regions**, and the
division is drawn into the terrain rather than enforced by a rule. Four seeded
sites carve the world into warped territories, the seams between them are lifted
into mountain ranges, and the rivers draining those ranges run away from the
seam on both sides. Nothing downstream knows about regions except as an ordinary
tile property. What the division buys is scarcity with a *geography*: spice grows
only in the arid territory, herbs change with latitude, and gems come out of a
few scattered lodes. A town cannot supply itself with all three, so the roads
between regions get walked — and those are roads that timber and stone would
never have justified.

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

The map itself decides nothing, but it holds two things the actors read
constantly: which region a tile is in, and what that region can grow
(`js/sim/terrain.js`, `js/sim/luxuries.js`).

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

**Found a town at the best empty crossroads — one option per region.**

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

`bestJunctions` keeps the best candidate *in each region*, and all of them are
scored together. That plural is doing real work. With a single global frontier
there is only ever one place on offer, it is always in whichever territory the
roads are thickest, and every caravan on the map scores the same junction — the
busiest region takes slot after slot and the far side of the mountains is never
looked at. With one per region, a caravan standing in the desert weighs the
desert's own passable crossroads against a much better one three hundred tiles
away, and distance decides. That is the whole mechanism by which every territory
ends up settled; nothing assigns quotas.

`distance` is measured in `LEG_UNIT`s — 40% of the map's width — rather than in
a fixed thousand world units. That indirection is not tidiness. Every weight
above is a ratio against it, so on a map two and a half times wider a fixed unit
would price a trip to the next region at five points against a founding bonus of
three, no caravan would ever cross a range again, and the world would settle into
four sealed pockets that never trade.

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
frontierPressure(state) = 0.5 ^ (time / 4400)
```

This is the single most important number for making a map *finish*. It multiplies
the value of founding anything, and it halves every 4400 simulated seconds. A new
world is desperate for settlements; an old one would much rather you moved into
one that exists. The half-life went up with the map, because what it has to
outlast is the *road network* rather than the clock, and a network four times the
area takes correspondingly longer to grow its junctions.

Without it, a long game slowly grows a village at every junction, because
junctions keep appearing as the road network thickens. With it, the map lands on
eleven to fourteen towns across the four regions inside about forty simulated
minutes and then *stops*, which is the behaviour that matters — the count
converges, and the same seed lands on roughly the same number every time.

The ceiling has two halves now. `MAX_TOWNS` is 14 and `MAX_PER_REGION` is 5, and
14 is deliberately below 4 × 5: the regions compete for the last few slots, so a
well-connected territory can finish with five where a mountainous one gets two,
but none of them can take the lot. Two to five per region is the shape to expect,
and the arid one usually comes in at the bottom of that — which is the ground
telling the truth about itself rather than a fault.

The pace is deliberately brisk — the first town usually lands inside a minute at
16×. Slowing it down is a matter of raising `FOUND_WEAR` in `state.js` (how worn
a junction must be before anyone will consider it) or shortening the wear rate
in `caravans.js`. Shortening `FRONTIER_HALFLIFE` is *not* the way to do it: that
changes where the run ends up, not how long it takes to get there.

`MAX_TOWNS` is the ceiling and it does get reached on a good map; the pressure
curve is what decides whether a *particular* map gets there or settles for
eleven.
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

Where a town *is* now decides more than how fast it grows. `surveyLand` counts
desert apart from open ground rather than folding it in, and that one line is the
whole characterisation of the waste: sand grows no scrub to cut, feeds no game
and cannot be ploughed, so every ceiling downstream quietly skips it and
`wantsField` refuses to ask for a plot the town could never site. A desert town
buys its dinner or it shrinks. What it has instead is the only spice on the map,
and that turns out to be enough — the arid region's towns run some of the highest
standing on a settled map, because everyone comes to them.

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

### The regions, and what they are for

Four territories, drawn by four seeded sites and a warped Voronoi split, with
the seams lifted into mountain ranges and the rivers running off both flanks of
each seam. The lift is modulated by a noise field so it dips in places, and those
dips are the passes — which is the same trick the rest of the map already plays,
one level up: make the ground expensive in a shape, leave a handful of gaps, and
let traffic find them.

What the regions *are* is an excuse for scarcity that has a geography to it.
Three families of luxury, and each is scarce in a deliberately different shape
(`js/sim/luxuries.js`):

| | Where it comes from | The shape of the scarcity |
| --- | --- | --- |
| **Spice** | desert tiles in reach | **one place has it** — one region in four is arid |
| **Herbs** | any wild ground, but the *variety* is set by latitude | **everywhere has a different one** |
| **Gems** | a lode in reach, *and* a quarry to work it | **hardly anywhere has any** |

Those three cover the three ways a thing can be hard to get, and between them
they guarantee that no town can supply itself. A caravan that wants all three has
to trade in three directions.

None of it is a building material. That is the load-bearing restraint: a
settlement that can never buy spice should be *poorer*, not stuck, and the
economy already has enough ways to hard-stall on a material it cannot reach.
What luxuries buy instead is **standing** — and standing is multiplied by how
many different families are on the shelf, not by how much is on it. Three
families fully stocked score 3 × 1.8 rather than 3. A desert town sitting on a
mountain of its own spice is worth less than one that swapped half of it away.

Standing feeds back in exactly two places, and both are ordinary:

```
standing → town.traffic  (0.05 a second per point — see LUXURY_TRAFFIC)
standing → prosperity in the caravan's join score
```

Traffic is what every building in the game is already paid for with, so a town
that trades in three directions visibly builds faster than one that trades in
none, without a single new entry in `MATERIALS`. And because prosperity pulls
caravans in, a well-supplied town fills its beds faster, grows faster, and sends
more trade runs out. That is the loop closing.

The counterpressure is that luxuries are *consumed*, continuously, by everybody,
and the shelf only holds fourteen of anything. A single delivery does not settle
the matter. The trade has to be a standing arrangement, which is what keeps the
long roads alive after the borders have gone quiet.

### Trade goes where the goods aren't

A trade run used to pick the nearest one or two towns. That is the right answer
when everything on the map is timber and rock — a staple is a staple wherever you
buy it, so you buy it next door — and it is the wrong answer the moment regions
hold different things. So `spawnTradeCaravan` scores partners on

```
complementarity × 0.9  −  distance in LEG_UNITs  ±  noise
```

where complementarity counts the families each end has that the other lacks, in
both directions. Distance is still a real cost; complementarity is now a reason
to pay it. A settlement with a full shelf trades locally. One that has never seen
a gem will send its wagons over a mountain range.

`tradeAt` finishes the job at the other end. Staples come off the wagon at a flat
share, because everybody wants timber. Luxuries come off in proportion to how
much the receiving town actually *lacks* them — so a wagon carrying mosswort
through mosswort country is politely relieved of almost none of it and carries the
rest on south to somewhere that has never smelled the stuff. The route a circuit
takes is not planned anywhere; it falls out of who wanted what.

One more small thing with a large effect: `loadCargo` fills the wagon with
luxuries *first* and lets staples take what is left. A prosperous town has fifty
spare timber and four jars of spice, and by weight the timber would take the
entire load. The four jars are the reason anybody is making the journey.

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
the base rate — which is why a couple of dozen caravans can wear in a network
that used to take fifty individual travellers. The base rate itself went up when
the map did: four times the ground carrying twice the traffic means each tile
sees half the boots, and without the adjustment the first junction would take
four times as long to mature as the frontier stays open for. The weighting is front-loaded rather than
proportional because most caravans are one wagon: a lone wagon still has to lay
down enough of a rut to matter, or a map of mostly-single wagons would never
grow a road at all.

Terrain exists purely to make step 1 non-uniform. If every tile cost the same,
traffic would spread evenly and no road would ever form. Rivers, lakes and
mountain ridges are near-walls with a handful of gaps; the gaps are where the
roads go; where the roads cross is where somebody decides to stop. Sand is the
one terrain that argues in a different currency — it is only moderately expensive
to cross and thoroughly unrewarding to live on, so traffic skirts it without
being stopped by it, and the roads that do cross it are there for the spice.

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
- **The pass.** The first road to cross a region boundary does not go over the
  range, it goes through one notch in it, because that notch is where the lift
  noise dipped. Every subsequent crossing uses the same notch, and it darkens
  into the busiest tile on that half of the map.
- **The spice arriving.** Watch the panel for a town in a green region listing
  spice among what it trades in. It cannot have grown a grain of it — there is no
  sand within thirty tiles — so it came up the road, and something had to walk
  the length of the map to bring it.
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
| `sim/caravans.js` | `LEG_UNIT` | what a long journey is worth; every weight in `W` is a ratio against it |
| `sim/towns.js` | `MAX_PER_REGION`, `MAX_TOWNS` | 2–5 towns a region, and no region taking the lot |
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
| `sim/terrain.js` | `DIVIDE_WIDTH`, the `lift` term | how firmly the regions are walled off, and how many passes through |
| `sim/terrain.js` | `LODES`, `LODE_REACH` | how rare gems are — one or two gem towns on most maps |
| `sim/luxuries.js` | `SATED`, `VARIETY_BONUS` | how much variety beats tonnage |
| `sim/luxuries.js` | `LUXURY_CAP`, `USE_PER_PERSON` | how often a town has to re-import to stay supplied |
| `sim/economy.js` | `LUXURY_TRAFFIC` | what standing is worth, in buildings |
| `sim/caravans.js` | `TRADE_APPEAL` | how far a run will go for something it cannot get at home |
