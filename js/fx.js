// fx.js — floating popups, sparkles, dust and chimney smoke.
//
// The transactions need to be *legible*: when two villagers meet and swap goods
// you should be able to tell what changed hands from a glance at the icons.

import { iconSprite } from './sprites.js';
import { pal, STYLE } from './palette.js';

const pops = [];
const parts = [];
const smokes = [];

export function popIcon(x, y, icon, drift = 0) {
  pops.push({ x, y, icon, t: 0, life: 1.5, drift });
}

export function sparkle(x, y, n = 6, color = null) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 12 + Math.random() * 26;
    parts.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s - 14,
      t: 0, life: 0.5 + Math.random() * 0.35,
      color, size: Math.random() < 0.4 ? 2 : 1,
    });
  }
}

export function dust(x, y) {
  parts.push({
    x: x + (Math.random() - 0.5) * 3, y,
    vx: (Math.random() - 0.5) * 6, vy: -4 - Math.random() * 4,
    t: 0, life: 0.35, color: 'dust', size: 1,
  });
}

export function smoke(x, y) {
  smokes.push({ x, y, t: 0, life: 2.6 + Math.random(), r: 1.5, drift: (Math.random() - 0.5) * 6 });
}

export function updateFx(dt) {
  for (let i = pops.length - 1; i >= 0; i--) {
    const q = pops[i];
    q.t += dt;
    if (q.t >= q.life) pops.splice(i, 1);
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    const q = parts[i];
    q.t += dt;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    q.vy += 42 * dt;
    if (q.t >= q.life) parts.splice(i, 1);
  }
  for (let i = smokes.length - 1; i >= 0; i--) {
    const q = smokes[i];
    q.t += dt;
    q.y -= 7 * dt;
    q.x += q.drift * dt;
    q.r += 2.6 * dt;
    if (q.t >= q.life) smokes.splice(i, 1);
  }
}

export function drawFx(g, toScreen, scale) {
  const p = pal();

  // Chimney smoke sits behind the popups but above the world.
  for (const q of smokes) {
    const k = q.t / q.life;
    const [sx, sy] = toScreen(q.x, q.y);
    g.globalAlpha = 0.32 * (1 - k);
    g.fillStyle = '#e8e2d4';
    const r = q.r * scale;
    g.fillRect(sx - r / 2, sy - r / 2, r, r);
  }
  g.globalAlpha = 1;

  for (const q of parts) {
    const k = q.t / q.life;
    const [sx, sy] = toScreen(q.x, q.y);
    g.globalAlpha = Math.max(0, 1 - k);
    g.fillStyle = q.color === 'dust' ? p.dirtDeep : q.color || p.coin;
    const s = q.size * scale;
    g.fillRect(Math.round(sx), Math.round(sy), s, s);
  }
  g.globalAlpha = 1;

  for (const q of pops) {
    const k = q.t / q.life;
    // Quick pop up, then a slow drift, fading at the tail.
    const rise = 12 * Math.min(1, k * 3.2) + 8 * k;
    const [sx, sy] = toScreen(q.x + q.drift * k, q.y - rise);
    const spr = iconSprite(q.icon, Math.max(2, STYLE.scale - 1));
    g.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    g.drawImage(spr.canvas, Math.round(sx - spr.ax), Math.round(sy - spr.ay));
  }
  g.globalAlpha = 1;
}

/** A speech bubble with a single icon in it, drawn above an actor's head. */
export function drawBubble(g, sx, sy, icon, scale, alpha = 1) {
  const ink = '#2f2018';
  const paper = '#f6efe2';
  const spr = iconSprite(icon, scale);
  const padding = 2 * scale;
  const w = spr.canvas.width + padding * 2;
  const h = spr.canvas.height + padding * 2;
  const x = Math.round(sx - w / 2);
  const y = Math.round(sy - h);
  const t = Math.round(sx);

  g.globalAlpha = alpha;
  g.fillStyle = ink;
  g.fillRect(x - scale, y - scale, w + scale * 2, h + scale * 2);
  g.fillStyle = paper;
  g.fillRect(x, y, w, h);
  // Stepped tail, narrowing to a point.
  g.fillStyle = ink;
  g.fillRect(t - scale * 2, y + h, scale * 4, scale);
  g.fillRect(t - scale, y + h + scale, scale * 2, scale);
  g.fillStyle = paper;
  g.fillRect(t - scale, y + h, scale * 2, scale);
  g.drawImage(spr.canvas, x + padding, y + padding);
  g.globalAlpha = 1;
}

export function clearFx() {
  pops.length = 0;
  parts.length = 0;
  smokes.length = 0;
}
