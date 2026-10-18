# The faith game

Crossroads is a simulation that runs itself. The faith layer (`js/sim/faith.js`)
is the game played on top of it, and it is built around one constraint: the
player's hand stays small. You never place a town, steer a caravan or build
anything. You choose where the word is first spoken, you read omens, you buy
rites and you send the odd prophet. Everything else has to travel the way
everything on this map already travels — in wagons, along roads, at the pace of
trade.

The model is Plague Inc.'s. Its genre gets called a "real-time strategy
simulation", and the bubble-popping, the three-branch upgrade tree and the
"pick where it starts" opening all come from it. The difference is the
transmission network. Plague Inc. needs airports and shipping lanes authored
into its map. This map grows its own, so the routes the faith rides are the
same roads the player watched form during the prologue.

## The loop

1. **Prologue.** The world runs as fast as the frame budget allows (about 26 ms
   of sim per frame, so roughly 100× real time) until there are five towns in
   at least three regions. The player can cut it short once there are three.
   It is worth seeing, because it is why the map looks the way it does, but
   not at 1×.
2. **Choose.** The clock stops and every town pulses. Picking one gives it a
   30% foothold. A busy town sends the word out on more wagons; a remote one is
   slower but further from where the rival will appear.
3. **Play.** 75 seconds in, a rival prophet rises in the town that is furthest
   away, preferring another region. From then on the two creeds race for the
   unbelievers and push against each other.
4. **Over.** You win at 75% of all settled souls. You lose if the rival reaches
   60%, or if your last believer is gone. The world keeps running afterwards.

## What moves a town

Each town holds a pair of shares, `town.faith = [yours, rival's]`; whatever is
left over believes nothing. Each caravan carries the same pair.

- **Inside a town**, each creed grows logistically into the unbelievers
  (`GROWTH`), lapses slowly (`LAPSE`), and pushes on the other creed
  (`CONTEST`). The push goes to whichever side has more rites behind it
  (Zeal, Feast Days).
- **A caravan leaving a town** takes that town's mix with it, or a more devout
  one if the town has Missions.
- **A caravan calling at a town** preaches in proportion to its headcount
  against the town's (`TRANSMIT`), and its own mix drifts toward the town's
  (`LISTEN`). That second half is how a trade run from an unbelieving town comes
  home carrying the word.
- **A caravan passing through** does the same thing at a small fraction of the
  strength (`PASSING`).
- **Settlers** — founding, joining, or a trade run coming home — are mixed into
  the town by headcount. A town founded by a faithful caravan is born faithful.

So a town that trades a lot converts a lot and is converted a lot. That is the
property Plague Inc. gets from its airports, and this map already had it.

## Omens

Omens are the player's income and their only direct reach. One appears every
7–13 seconds near people (an omen nobody saw is just weather). Its kind comes
from the ground it lands on: forest burns, water floods, high ground thunders,
the desert sees things. Reading one pays devotion in proportion to how many
people witnessed it, and it converts some of the witnesses. It converts far
more where your creed already has a voice, but it plants something even where
you have none. That is how the word reaches a town no caravan has carried it
to.

**The answer to "this feels demeaning".** An omen you ignore is not simply
lost. Partway through its life the rival tries to claim it, and it succeeds
in proportion to how many of its own people saw it. So the tapping is a race,
and where you spend your attention is a real decision: an omen in the
middle of Choir country is probably theirs whatever you do. The timer ring
turns the rival's colour once the rival can still take the omen.

**Automation is the late game.** Wandering Preachers let faithful caravans read
the omens they pass, and Seers let devout towns read anything in sight of
them. That is the "priests who do the clicking" idea, and it is the obvious
direction for an idle game: the player's job moves from tapping to placing the
faith where it will tap for them.

## Rites and prophets

There are three branches, after Plague Inc.'s transmission / symptoms /
abilities split:

- **Word**, how it travels: Wayside Hymns, Pilgrimage, Missions.
- **Rite**, how it holds a town: Hearth Shrines, Feast Days, Tithes, Zeal.
- **Wonder**, how it reads the sky: Watchful Eyes, Lasting Signs, Wandering
  Preachers, Seers.

The rival buys a fixed Word-and-Rite build. It never taps anything, so it has
no use for Wonder. To make up for that it gets a standing edge, `RIVAL_GROWTH`
and `RIVAL_TITHE`: it is the older, better-organised church. Without that edge,
a player who taps diligently meets no opposition at all.

Prophets are the devotion sink. Once both sides own every rite the contest
settles into a standing split that nothing moves, and devotion piles up
uselessly. A prophet converts 30% of one town's remaining souls, unbelievers
first and the rival second, at a price that climbs by half each time. The rival
sends them too, once its rites are all bought.

## Tuning

`node tools/balance.mjs <seed> <tapRate> <reactSeconds>` plays a whole game
headlessly with a scripted player. These are the targets the current constants
were set against. Each figure is minutes after the first sermon, measured
across seeds 1, 5, 9 and 777:

| Player | tapRate | Result |
| --- | --- | --- |
| Idle | 0 | loses, 12–20 min |
| Half-attentive | 0.5 | usually wins, 12–16 min; sometimes a long tug-of-war |
| Diligent | 0.9 | wins, 9–15 min |

Pace is mostly `GROWTH` and the omen conversion term in `claimOmen`. Difficulty
is mostly `RIVAL_GROWTH`, `RIVAL_TITHE`, `RIVAL_DELAY` and the perk costs. If
diligent players win too fast, raise the rival's edge rather than slowing
everything down; slowing everything down just makes the idle player lose more
slowly.

## Open questions

- **Nations.** Not yet, and possibly never as a separate system. The four
  regions already work as proto-nations: they are separated by ranges, they
  hold different luxuries, and trade between them is what the long roads are
  for. The cheapest version of "nations" is to let a region's majority creed
  become its state church, with a border-crossing penalty for the other one.
  That gives the map political shape without a new layer of authored state.
- **More than one rival.** The model is already a pair of shares per town;
  going to N creeds is mostly mechanical. The interesting question is whether
  rivals should fight each other as well as the player.
- **Schism.** A creed that has spread across a mountain range could split, so
  that your own far-flung towns become the new rival. This is the most on-theme
  late-game threat available, because it falls straight out of the road
  network.
- **Victory.** "75% of souls" is a placeholder. Holding every region's largest
  town, or a pilgrimage route that links all four, would be more about the map.
