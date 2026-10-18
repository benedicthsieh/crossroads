# 2026-10-18 — exploration

A candidate for the next version of the faith game, built from the main build
as of `6632310`. The aim was to turn the game from a race into an exploration:
less spreadsheet, less competition, more "what is happening over there?"

Everything below the faith layer (terrain, roads, caravans, towns, economy) is
the main build's, apart from one new module: fires and floods that change
the map.

## What changed

**No race and no loss.** The rival prophet is gone. Instead, the map already
believes something when you arrive. Two old faiths, **the Veiled Choir** and
**the Old Ways**, come in with the settlers from opposite sides of the world
along a seeded axis, so the prologue builds a real geography of belief: Choir
country, Old Ways country, and a mixed middle. The Lantern is the insurgent.
The old faiths never hunt you, buy rites or read omens. They hold what they
have, fill empty ground slowly, consolidate towns toward one faith or the
other, and win back the wavering. Converting their people is the slow half of
the game; the unbelievers are the fast half.

**The chronicle replaces victory.** It is a list of firsts: a foothold beyond
your first town, a town that is mostly yours, the word reaching each named
region, reading a wonder yourself, one soul in ten, a quarter, outnumbering
each old faith, half, three in four. Nothing can be lost. Each first written
refills your insight and pays a little devotion, and one of them (a town
mostly yours) unlocks the Seers rite.

**Locked speed.** The game runs at a fixed 2 sim seconds per real second
(`SIM_RATE` in `js/game.js`); only pause remains. The prologue still
fast-forwards, because nothing in it is timed.

**Omens are the news.** Most omens are now raised by things that actually
happened, noticed by diffing each town against the previous second
(`news()` in `faith.js`):

| Tier | Example | Source |
| --- | --- | --- |
| sign | a star falls; thunder on the heights | ambient, weighted toward towns that are building |
| portent | a new hearth is lit; strange goods reach a town for the first time; hunger | the town's own news |
| marvel | the river breaks its banks | a real flood |
| wonder | the forest burns; an eclipse | a real fire, or rare ambient |

Bigger tiers are larger bubbles with hotter rings, last longer, and are worth
more. Only portents and up get an off-screen pointer, so a sign in the corner
does not nag you.

**Insight: tapping is a budget.** Every omen gets read eventually: when it
fades, your faithful explain it themselves for 30% of its worth. Reading one
yourself costs one **insight** and gives the full value in devotion and
converts. You hold three (◆◆◆ in the top bar), and one comes back every 35
real seconds. The decision every time a bubble appears is whether this is the
one, or whether to save it for the fire that might start in a minute. Each
bubble shows its full value next to it, and the price tag greys out when you
have no insight.

**Fires and floods change the map** (`js/sim/nature.js`). Lightning every
2½–5 minutes starts a fire in some town's forest. It spreads tile by tile with
the wind, leaves a burn scar of ash and blackened snags, and permanently turns
that forest into open ground, so the nearest town loses wood and gains
farmland. Floods drown the lowest ground beside a river into a new mere,
wiping any road through it, and often drop a silt bar that makes a new ford
the roads can re-route through. Towns keep a 22-tile firebreak, so disasters
happen in a town's country, never in its streets.

The design rule "terrain is derived, never stored" survives as **terrain is
the seed plus a list of scars**. Every changed tile is appended to
`state.nature.scars`; a snapshot stores the list; `restore` regenerates the map
and replays it before anything surveys the land. Everything derived from
terrain keys off `terrain.rev`: the path guide, a town's survey, the terrain
bake (now repaintable per tile, see `repaintTiles` in `terrainPaint.js`) and
the scenery (`weather()` in `scenery.js`).

**Aspects: a fork at the start.** After picking where the word is first
spoken, you choose what it is the word *of*, from three aspects offered by the
land around that town: **the River, the Waste, the Heights, the Grove**, or
**the Road** (busy towns, which is always in contention). An aspect makes the
creed up to 70% stronger in towns on its kind of ground, doubles the worth of
its kind of omen (floods for the River, fires for the Grove, hearths and
strange goods for the Road), and adds two rites to the deck that nobody else
gets. Floodtide, for example, makes floods twice as common and reads every one
for you in full.

**Rites are dealt, not listed.** Three are face up at a time. Buying one deals
the next, and aspect rites are dealt twice as readily. Two pairs are forks
where taking one closes the other for good: The Open Door (convert the old
faiths' people twice as fast) against The Narrow Gate (they almost never win
anyone back), and A Deep Well (hold five insight) against A Quick Tongue
(insight returns twice as fast). Each rite bought adds 30% of its base price to every rite after it,
so the deck lasts a session.

**The feed.** The last six things that happened sit in the top-left corner,
Civ-style, and clicking one flies the camera there: fires, floods, new
hearths, strange goods, hunger, chronicle entries, rites, and towns going over
to the Lantern or slipping back. On a phone it shows three.

## Pace

`node tools/balance.mjs <seed> <idle|greedy|patient> [minutes]` plays it
headlessly. Minutes are real minutes at the locked speed. These are the
numbers for seeds 1, 5 and 9 at the current constants:

| Player | Lantern at 10 / 20 / 30 / 40 min | Half of all souls | Three in four |
| --- | --- | --- | --- |
| idle (never taps) | 8–10% / 12–19% / 26–44% / 59–77% | 32–37 min | 39–45 min |
| greedy (taps everything it can) | 13–16% / 26–44% / 68–87% / 89–97% | 22–27 min | 26–32 min |
| patient (saves insight for portents and up) | 13–17% / 27–49% / 63–89% / 88–97% | 20–29 min | 26–34 min |

So attention is worth ten to fifteen minutes over idling. Patient play beats
greedy on two seeds of three and loses on the third, so saving insight pays
but not reliably yet: insight is still a little too plentiful, or the tiers
too close together. The levers are `INSIGHT_TIME`, `PASSIVE` and the `mult` column of `TIERS` in
`faith.js`.

## Performance

Fires bump `terrain.rev` every second they burn. The path guide only rebuilds
its block prices on its ten-second refresh, the town survey is lazy, and the
terrain repaint covers only the fire's bounding box, so none of this shows in
the frame. A 30-minute game carries a few hundred scarred tiles, a few kB of the
snapshot.

## Open questions

- **Patient vs greedy** (above) is the main tuning gap.
- **Late game.** Past three in four, nothing is left to do but watch. The
  chronicle could keep going: hold every region's largest town, link all four
  regions by a pilgrimage route, or a schism where your far-flung towns become
  a third old faith.
- **The old faiths are inert.** They are a backdrop with mass. They could have
  their own slow politics (a state church per region, or the Choir and the Old
  Ways contesting the middle) without becoming a rival to you.
- **Fog.** The other half of "exploration" would be not knowing the map: towns
  the word has not reached could appear as rumours, and regions could be named
  only when you reach them. Not attempted here.
- **Disasters only touch forest and riverbank.** Landslides in the passes
  (closing a road for a while) and drought in the arid region are the obvious
  next two.
- **Icons.** World omens reuse existing icons (heart, wheat, coin, the luxury
  icons). A hearth or a flood deserves its own art.
