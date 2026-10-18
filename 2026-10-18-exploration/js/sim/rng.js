// rng.js — the sim's only source of randomness.
//
// Nothing in js/sim/ is allowed to call Math.random(). Every draw goes through
// one of these generators, whose entire state is a single 32-bit integer, so a
// snapshot can capture "where the dice are" in four bytes and a restored game
// continues rolling exactly where it left off. That is the whole reason for
// this file: without it, saving and resuming would silently diverge.

/** Small, fast, well-distributed 32-bit PRNG. State is `s` and nothing else. */
export class Rng {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 1;
  }

  /** Uniform in [0, 1). */
  next() {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo, hi) {
    return lo + this.next() * (hi - lo);
  }

  /** Integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n) % n;
  }

  pick(arr) {
    return arr[this.int(arr.length)];
  }

  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }

  /** A fresh independent stream, for a sub-system that must not perturb this one. */
  fork(salt = 0) {
    return new Rng((Math.imul(this.s ^ (salt + 0x9e3779b9), 0x85ebca6b) >>> 0) || 1);
  }
}

/**
 * Stateless hash — same inputs, same output, forever. Used where a value has to
 * be reproducible from its coordinates alone (terrain noise, dither patterns,
 * a traveller's private path jitter) rather than from a position in a stream.
 */
export function hash3(x, y, z = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
