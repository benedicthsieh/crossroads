// pixel.js — a tiny pixel-art rasterizer.
//
// Everything you see in this demo is authored as a small grid of pixels (usually
// under 24x24) and then blown up to an integer scale. That keeps the art style
// honest: no filtering, no half-pixels, and one place to tune the whole look.
//
// The two passes that do most of the "cute" heavy lifting:
//   outline()  — wraps the silhouette in a darker version of the pixel it touches
//                ("selective outlining"), which reads softer than a black keyline.
//   rimLight() — brightens any pixel whose sky-facing neighbour is empty, faking
//                a single soft light from above.

// ---------------------------------------------------------------- colour maths

function parse(c) {
  return [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ];
}

function toHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function mix(a, b, t) {
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

export const darken = (c, t) => mix(c, '#120b08', t);
export const lighten = (c, t) => mix(c, '#fff6e0', t);

/** Nudge a colour toward a hue while keeping roughly its brightness. */
export function tint(c, target, t) {
  return mix(c, target, t);
}

// ------------------------------------------------------------------ pixel grid

export class Pix {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Array(w * h).fill(null);
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  get(x, y) {
    return this.inside(x, y) ? this.d[y * this.w + x] : null;
  }

  set(x, y, c) {
    if (c && this.inside(x, y)) this.d[y * this.w + x] = c;
    return this;
  }

  /** Clear a single pixel (used to punch eyes/gaps back out). */
  clear(x, y) {
    if (this.inside(x, y)) this.d[y * this.w + x] = null;
    return this;
  }

  fill(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
    return this;
  }

  /** Filled rect, but only where a pixel already exists (shading a body part). */
  shadeOver(x, y, w, h, c) {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) if (this.get(x + i, y + j)) this.set(x + i, y + j, c);
    return this;
  }

  line(x0, y0, x1, y1, c) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return this;
  }

  disc(cx, cy, r, c) {
    const r2 = r * r + r * 0.4;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) this.set(x, y, c);
      }
    return this;
  }

  /** Horizontally mirrored copy. */
  flipped() {
    const p = new Pix(this.w, this.h);
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) p.d[y * this.w + (this.w - 1 - x)] = this.d[y * this.w + x];
    return p;
  }

  /**
   * Wrap the silhouette in an outline.
   * mode 'selout' derives the colour per-pixel from what it touches (softer),
   * mode 'hard'   uses one flat colour (crisper, more comic-like).
   */
  outline(mode = 'selout', color = '#2f2018', strength = 0.42) {
    if (mode === 'off') return this;
    const src = this.d.slice();
    const at = (x, y) => (this.inside(x, y) ? src[y * this.w + x] : null);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (at(x, y)) continue;
        const n = at(x, y - 1) || at(x + 1, y) || at(x, y + 1) || at(x - 1, y);
        if (!n) continue;
        this.d[y * this.w + x] = mode === 'hard' ? color : darken(n, strength);
      }
    }
    return this;
  }

  /** Brighten upward-facing pixels. `skip` keeps eyes/outlines from glowing. */
  rimLight(amount = 0.2, skip = new Set()) {
    if (amount <= 0) return this;
    const src = this.d.slice();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = src[y * this.w + x];
        if (!c || skip.has(c)) continue;
        const above = y > 0 ? src[(y - 1) * this.w + x] : null;
        if (!above) this.d[y * this.w + x] = lighten(c, amount);
      }
    }
    return this;
  }

  /** Multiply the whole sprite toward a colour (used for night / silhouettes). */
  wash(color, t) {
    for (let i = 0; i < this.d.length; i++)
      if (this.d[i]) this.d[i] = mix(this.d[i], color, t);
    return this;
  }

  /** Stamp another grid on top at an offset. */
  blit(other, ox, oy) {
    for (let y = 0; y < other.h; y++)
      for (let x = 0; x < other.w; x++) {
        const c = other.get(x, y);
        if (c) this.set(ox + x, oy + y, c);
      }
    return this;
  }

  /** Bake to a canvas at an integer scale, grouping by colour to cut fill calls. */
  toCanvas(scale) {
    const cv = document.createElement('canvas');
    cv.width = this.w * scale;
    cv.height = this.h * scale;
    const g = cv.getContext('2d');
    const runs = new Map();
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const c = this.d[y * this.w + x];
        if (!c) { x++; continue; }
        let len = 1;
        while (x + len < this.w && this.d[y * this.w + x + len] === c) len++;
        if (!runs.has(c)) runs.set(c, []);
        runs.get(c).push([x, y, len]);
        x += len;
      }
    }
    for (const [c, list] of runs) {
      g.fillStyle = c;
      for (const [x, y, len] of list) g.fillRect(x * scale, y * scale, len * scale, scale);
    }
    return cv;
  }
}

// ---------------------------------------------------------------- value noise

/** Deterministic 0..1 hash. Used for grass speckle, pebbles, prop jitter. */
export function hash2(x, y, seed = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
