// agents.js — who's doing what, and why.
//
// Behaviour is deliberately shallow: each villager runs a looping script of
// simple steps (walk here, work for a bit, hand this over). That's enough to
// make the crossroads look busy and, more importantly, it's the same shape the
// real idle-game sim will need — jobs, routes, and goods changing hands at a
// market. Nothing here knows how anything is drawn.

import { POI, FIELDS, WORLD, walkable } from './world.js';
import { roleLook } from './sprites.js';
import { popIcon, sparkle, dust, drawBubble } from './fx.js';

export const stats = { trades: 0, coins: 0, goods: 0, travelers: 0 };

let seedCounter = 0;
const rand = (a = 1, b = 0) => b + Math.random() * (a - b);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const NAMES = [
  'Mira', 'Tomas', 'Bran', 'Odette', 'Pell', 'Yara', 'Cass', 'Nim', 'Rook',
  'Sable', 'Fen', 'Dov', 'Wren', 'Halla', 'Gus', 'Idris', 'Lune', 'Perrin',
];

export class Actor {
  constructor(opts) {
    this.role = opts.role;
    this.look = roleLook(opts.role, opts.seed ?? seedCounter++);
    this.look.key = `${opts.role}:${opts.seed ?? seedCounter}`;
    this.name = opts.name || pick(NAMES);
    this.x = opts.x;
    this.y = opts.y;
    this.speed = opts.speed ?? rand(19, 14);
    this.script = opts.script || [];
    this.step = 0;
    this.timer = 0;
    this.item = null;
    this.tool = null;
    this.view = 'front';
    this.walked = 0;
    this.frame = 0;
    this.idleT = rand(6);
    this.bubble = null;
    this.bubbleT = 0;
    this.target = null;
    this.dead = false;
    this.dustT = 0;
    this.z = 0;                      // little hop offset, used for reactions
  }

  say(icon, time = 1.6) {
    this.bubble = icon;
    this.bubbleT = time;
  }

  /** Resolve the current script step into a concrete action. */
  begin(all) {
    const s = this.script[this.step];
    if (!s) return;
    // `enter` fires as the step starts, `then` as it finishes. Anything that
    // should hold for the duration of a step (the bakery's oven, say) needs
    // `enter` — using `then` would switch it on just as the step ended.
    if (s.enter) s.enter(this);
    if (s.go) {
      const t = typeof s.go === 'function' ? s.go(this) : s.go;
      this.target = { x: t.x, y: t.y, tol: s.tol ?? 3.5 };
    } else if (s.wait != null) {
      this.timer = typeof s.wait === 'function' ? s.wait() : s.wait;
      this.tool = s.tool || null;
      if (s.say) this.say(s.say, Math.min(this.timer, 2));
      if (s.view) this.view = s.view;
    } else if (s.take !== undefined) {
      this.item = s.take;
      if (s.take) this.say(s.take === 'water' ? 'water' : s.take, 1.1);
    } else if (s.trade) {
      this.timer = s.trade.time ?? 1.1;
      this.startTrade(s.trade, all);
    } else if (s.face) {
      this.view = s.face;
    }
  }

  startTrade(t, all) {
    // Find the counterpart so both of them react — a one-sided transaction
    // looks like someone talking to a wall.
    const other = t.with ? all.find((a) => a.keeper && a.role === t.with && !a.dead) : null;
    if (other) {
      other.view = other.y > this.y ? 'back' : 'front';
      if (Math.abs(other.x - this.x) > 8) other.view = other.x > this.x ? 'left' : 'side';
      other.say(t.give || 'coin', 1.4);
      other.z = 2;
    }
    this.say(t.get || 'coin', 1.4);
    this.z = 2;
    const hx = other ? (this.x + other.x) / 2 : this.x;
    const hy = (other ? Math.min(this.y, other.y) : this.y) - 16;
    if (t.give) popIcon(hx - 5, hy, t.give, -6);
    if (t.get) popIcon(hx + 5, hy, t.get, 6);
    sparkle(hx, hy + 4, 7);
    stats.trades++;
    if (t.get === 'coin' || t.give === 'coin') stats.coins++;
    if (t.get && t.get !== 'coin') stats.goods++;
  }

  update(dt, all) {
    if (this.bubbleT > 0) this.bubbleT -= dt;
    else this.bubble = null;
    if (this.z > 0) this.z = Math.max(0, this.z - dt * 6);

    const s = this.script[this.step];
    if (!s) { this.dead = this.role === 'traveler'; return; }

    if (this.target) {
      const dx = this.target.x - this.x;
      const dy = this.target.y - this.y;
      const d = Math.hypot(dx, dy);
      if (d <= this.target.tol) {
        this.target = null;
        this.advance(all);
      } else {
        const nx = dx / d, ny = dy / d;
        let vx = nx * this.speed, vy = ny * this.speed;

        // Nudge apart from anyone standing too close. Cheap, and it stops the
        // market from turning into a single pile of villagers.
        for (const o of all) {
          if (o === this || o.dead) continue;
          const ox = this.x - o.x, oy = (this.y - o.y) * 1.6;
          const od = Math.hypot(ox, oy);
          if (od > 0.01 && od < 9) {
            vx += (ox / od) * 10;
            vy += (oy / od) * 10;
          }
        }

        const stepX = vx * dt, stepY = vy * dt;
        // Keep to the roads and the square where we can, but never get stuck.
        if (walkable(this.x + stepX, this.y + stepY) || d > 40) {
          this.x += stepX;
          this.y += stepY;
        } else {
          this.x += stepX * 0.5;
          this.y += stepY * 0.5;
        }
        this.x = Math.max(-40, Math.min(WORLD.w + 40, this.x));
        this.y = Math.max(-40, Math.min(WORLD.h + 40, this.y));

        this.walked += Math.hypot(stepX, stepY);
        this.frame = Math.floor(this.walked / 3.2) % 4;
        this.view = Math.abs(vx) > Math.abs(vy) * 1.15
          ? (vx > 0 ? 'side' : 'left')
          : (vy > 0 ? 'front' : 'back');

        this.dustT += dt;
        if (this.dustT > 0.28) {
          this.dustT = 0;
          dust(this.x, this.y);
        }
      }
      return;
    }

    if (this.timer > 0) {
      this.timer -= dt;
      // Working / idling animation: a slow two-frame sway rather than a walk.
      this.idleT += dt;
      this.frame = Math.floor(this.idleT * 2.2) % 2 === 0 ? 0 : 2;
      if (this.timer <= 0) {
        this.tool = null;
        this.advance(all);
      }
      return;
    }

    this.advance(all);
  }

  advance(all) {
    const s = this.script[this.step];
    if (s && s.then) s.then(this);
    this.step++;
    if (this.step >= this.script.length) {
      if (this.loop === false) { this.dead = true; return; }
      this.step = 0;
    }
    this.begin(all);
  }
}

// ------------------------------------------------------------------- the cast

function fieldSpot(field) {
  return () => ({
    x: field.x + rand(field.w),
    y: field.y + rand(field.h),
  });
}

function plazaSpot(pad = 0) {
  return () => ({
    x: 300 + rand(58, -58) - pad,
    y: 212 + rand(44, -44),
  });
}

export function buildCast() {
  const cast = [];

  // --- stall keepers: the anchors of the whole scene ------------------------
  const keeperA = new Actor({
    role: 'merchant', seed: 101, name: 'Odette',
    x: POI.stallAKeeper.x, y: POI.stallAKeeper.y,
    script: [
      { face: 'front' },
      { wait: () => rand(5, 3) },
      { wait: 1.2, say: 'chat' },
      { wait: () => rand(6, 3) },
    ],
  });
  const keeperB = new Actor({
    role: 'baker', seed: 102, name: 'Tomas',
    x: POI.stallBKeeper.x, y: POI.stallBKeeper.y,
    script: [
      { face: 'front' },
      { wait: () => rand(6, 4) },
      { wait: 1.2, say: 'bread' },
      { wait: () => rand(5, 3) },
    ],
  });
  keeperA.keeper = true;
  keeperB.keeper = true;
  cast.push(keeperA, keeperB);

  // --- farmers: harvest, haul to the produce stall, get paid ---------------
  FIELDS.forEach((field, i) => {
    cast.push(new Actor({
      role: 'farmer', seed: 200 + i, speed: rand(17, 14),
      x: field.x + field.w / 2, y: field.y + field.h / 2,
      script: [
        { go: fieldSpot(field) },
        { wait: () => rand(3.4, 2.2), tool: 'scythe', say: 'wheat' },
        { take: 'wheat' },
        { go: POI.stallA, tol: 6 },
        { face: 'back' },
        { trade: { give: 'wheat', get: 'coin', with: 'merchant' } },
        { take: null },
        { wait: () => rand(1.4, 0.6) },
      ],
    }));
    // A second hand working the same field, offset in time.
    cast.push(new Actor({
      role: 'villager', seed: 210 + i, speed: rand(16, 13),
      x: field.x + 20, y: field.y + 20,
      script: [
        { wait: () => rand(4, 1) },
        { go: fieldSpot(field) },
        { wait: () => rand(4, 2.5), tool: 'broom', say: 'wheat' },
        { take: 'basket' },
        { go: POI.stallA, tol: 7 },
        { face: 'back' },
        { trade: { give: 'basket', get: 'coin', with: 'merchant' } },
        { take: null },
        { wait: () => rand(2, 1) },
      ],
    }));
  });

  // --- the baker's loop: buy grain, bake, sell bread -----------------------
  cast.push(new Actor({
    role: 'baker', seed: 300, name: 'Pell', speed: 17,
    x: POI.bakeryCounter.x, y: POI.bakeryCounter.y,
    script: [
      { go: POI.stallA, tol: 7 },
      { face: 'back' },
      { trade: { give: 'coin', get: 'wheat', with: 'merchant' } },
      { take: 'wheat' },
      { go: POI.bakeryDoor, tol: 5 },
      { wait: 4.2, say: 'bread', view: 'back', enter: (a) => { a.baking = true; } },
      { take: 'bread', enter: (a) => { a.baking = false; } },
      { go: POI.stallB, tol: 7 },
      { face: 'back' },
      { trade: { give: 'bread', get: 'coin', with: 'baker' } },
      { take: null },
      { wait: () => rand(1.5, 0.5) },
    ],
  }));

  // --- water carrier: well to home and back -------------------------------
  cast.push(new Actor({
    role: 'matron', seed: 400, name: 'Halla', speed: 15,
    x: POI.houseDoors[0].x, y: POI.houseDoors[0].y,
    script: [
      { go: POI.well, tol: 5 },
      { face: 'back' },
      { wait: 2.6, say: 'water' },
      { take: 'water' },
      { go: POI.houseDoors[0], tol: 5 },
      { wait: 2.2, view: 'back' },
      { take: null },
      { wait: () => rand(2, 1) },
    ],
  }));

  // --- shoppers: buy bread, go home, come back ----------------------------
  [1, 2].forEach((hi, i) => {
    const door = POI.houseDoors[hi];
    cast.push(new Actor({
      role: i === 0 ? 'villager' : 'matron', seed: 500 + i, speed: rand(17, 14),
      x: door.x, y: door.y,
      script: [
        { wait: () => rand(5, 1) },
        { go: POI.plazaCentre, tol: 12 },
        { go: POI.stallB, tol: 7 },
        { face: 'back' },
        { trade: { give: 'coin', get: 'bread', with: 'baker' } },
        { take: 'bread' },
        { go: plazaSpot(), tol: 6 },
        { wait: () => rand(2.5, 1), say: 'heart' },
        { go: door, tol: 5 },
        { wait: 2, view: 'back' },
        { take: null },
        { wait: () => rand(6, 3) },
      ],
    }));
  });

  // --- kids and a guard: pure flavour, but they sell the "living town" read -
  for (let i = 0; i < 2; i++) {
    cast.push(new Actor({
      role: 'kid', seed: 600 + i, speed: rand(26, 20),
      x: 300 + rand(40, -40), y: 220,
      script: [
        { go: plazaSpot(), tol: 5 },
        { wait: () => rand(1.6, 0.4), say: i === 0 ? 'chat' : 'heart' },
        { go: plazaSpot(), tol: 5 },
        { wait: () => rand(1.2, 0.3) },
        { go: POI.well, tol: 10 },
        { wait: () => rand(2, 0.8) },
      ],
    }));
  }
  cast.push(new Actor({
    role: 'guard', seed: 700, name: 'Bran', speed: 12,
    x: 332, y: 200,
    script: [
      { go: { x: 244, y: 200 }, tol: 4 },
      { wait: () => rand(4, 2), tool: 'spear' },
      { go: { x: 356, y: 216 }, tol: 4 },
      { wait: () => rand(4, 2), tool: 'spear' },
      { go: { x: 300, y: 250 }, tol: 4 },
      { wait: () => rand(3, 1.5), tool: 'spear' },
    ],
  }));

  return cast;
}

// ------------------------------------------------------------------ travellers
//
// Travellers are the reason the crossroads exists. They come in off one road,
// do business in the square, maybe stop at the inn, and leave by another road.

export function spawnTraveler(all) {
  const gates = POI.gates;
  const from = pick(gates);
  let to = pick(gates);
  let guard = 0;
  while (to === from && guard++ < 8) to = pick(gates);

  const wantsInn = Math.random() < 0.5;
  const stall = Math.random() < 0.5 ? POI.stallA : POI.stallB;
  const partner = stall === POI.stallA ? 'merchant' : 'baker';
  const role = Math.random() < 0.45 ? 'peddler' : 'traveler';

  const script = [
    { go: POI.plazaCentre, tol: 14 },
    { go: stall, tol: 7 },
    { face: 'back' },
    { trade: { give: 'coin', get: stall === POI.stallA ? 'basket' : 'bread', with: partner } },
    { take: stall === POI.stallA ? 'basket' : 'bread' },
  ];
  if (wantsInn) {
    script.push(
      { go: POI.innBench, tol: 8 },
      { wait: () => rand(5, 3), say: 'heart' },
      { go: POI.innDoor, tol: 6 },
      { wait: () => rand(3, 1.5), view: 'back' },
    );
  }
  script.push({ go: to, tol: 8 }, { take: null });

  const a = new Actor({
    role, seed: 800 + Math.floor(Math.random() * 900),
    x: from.x, y: from.y,
    speed: rand(22, 16),
    script,
  });
  a.loop = false;
  all.push(a);
  a.begin(all);
  stats.travelers++;
  return a;
}

// -------------------------------------------------------------------- critters

export class Critter {
  constructor(kind, x, y) {
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.home = { x, y };
    this.flip = false;
    this.frame = 0;
    this.t = rand(3);
    this.state = 'idle';
    this.target = null;
    this.speed = kind === 'dog' ? 26 : 14;
  }

  update(dt) {
    this.t -= dt;
    if (this.t <= 0) {
      if (this.state === 'walk') {
        this.state = Math.random() < 0.55 ? 'peck' : 'idle';
        this.t = rand(2.2, 0.6);
        this.target = null;
      } else {
        this.state = 'walk';
        this.t = rand(2.6, 0.8);
        const r = this.kind === 'dog' ? 60 : 34;
        this.target = {
          x: this.home.x + rand(r, -r),
          y: this.home.y + rand(r * 0.6, -r * 0.6),
        };
      }
    }
    if (this.state === 'walk' && this.target) {
      const dx = this.target.x - this.x, dy = this.target.y - this.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > 2) {
        this.x += (dx / d) * this.speed * dt;
        this.y += (dy / d) * this.speed * dt;
        this.flip = dx < 0;
        this.frame = Math.floor(performance.now() / 130) % 2;
      }
    } else if (this.state === 'peck') {
      this.frame = Math.floor(performance.now() / 220) % 2 === 0 ? 2 : 0;
    } else {
      this.frame = 0;
    }
  }
}

export function buildCritters() {
  const out = [];
  const flocks = [[170, 330], [470, 336], [300, 190]];
  flocks.forEach(([x, y], i) => {
    const n = i === 2 ? 2 : 3;
    for (let k = 0; k < n; k++) out.push(new Critter('chicken', x + rand(20, -20), y + rand(14, -14)));
  });
  out.push(new Critter('dog', 268, 226));
  return out;
}

export { drawBubble };
