// faithPaint.js — the game layer, drawn over the world.
//
// Everything here is drawn in CSS pixels rather than in world space, and that
// is the point of it being a separate pass. A town banner or an omen bubble is
// interface, not scenery: it has to be the same size and just as tappable at
// whole-map zoom as it is at street level, because whole-map zoom is where the
// game is mostly played. The world pass shrinks with the camera; this one does
// not.
//
// Like the rest of the renderer it reads state and never writes it. What the
// player taps is reported back as a list of hit rectangles on `ui.hits`, and
// game.js turns a tap into a sim command.

import { STYLE } from '../palette.js';
import { iconSprite } from '../sprites.js';
import { toScreen } from './camera.js';
import { TILE, MAP } from '../sim/terrain.js';
import {
  CREEDS, PLAYER, CHOIR, OLDWAYS, faithOf, omenValue,
} from '../sim/faith.js';

const INK = 'rgba(20,16,13,0.78)';
const PAPER = '#f6efe2';
const UNBELIEF = 'rgba(214,204,186,0.35)';

/** Floating "+4 ✦" style notes, in world space, owned by the renderer. */
const floaters = [];

export function floatText(x, y, text, color) {
  floaters.push({ x, y, text, color, t: 0 });
}

export function tickFloaters(dt) {
  for (let i = floaters.length - 1; i >= 0; i--) {
    floaters[i].t += dt;
    if (floaters[i].t > 1.8) floaters.splice(i, 1);
  }
}

export function clearFloaters() {
  floaters.length = 0;
}

/** Lantern from the left, then the two old faiths; whatever is left believes nothing. */
function shareBar(g, x, y, w, h, f) {
  g.fillStyle = INK;
  g.fillRect(x - 1, y - 1, w + 2, h + 2);
  g.fillStyle = UNBELIEF;
  g.fillRect(x, y, w, h);
  let at = x;
  for (const k of [PLAYER, CHOIR, OLDWAYS]) {
    const n = Math.round(w * f[k]);
    g.fillStyle = CREEDS[k].color;
    g.fillRect(at, y, Math.min(n, x + w - at), h);
    at += n;
  }
}

/** Who a town mostly keeps, or null if nobody has half of it. */
function keeper(f) {
  for (const k of [PLAYER, CHOIR, OLDWAYS]) if (f[k] >= 0.5) return k;
  return null;
}

/** How each tier of omen looks: bubble size, and the colour of its ring. */
const TIER_LOOK = [
  null,
  { r: 13, ring: '#cfc4ae' },
  { r: 16, ring: '#f2c14b' },
  { r: 19, ring: '#f08a3c' },
  { r: 22, ring: '#ff5a3a' },
];

function pill(g, x, y, w, h) {
  const r = h / 2;
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Draw the overlay and rebuild the hit list.
 * `ui` carries render-only choices: which town is selected, which phase the
 * HUD thinks it is in.
 */
export function drawFaithOverlay(g, cam, state, ui, dpr, now) {
  const fs = state.faith;
  const k = STYLE.zoom / STYLE.scale;
  const W = g.canvas.width / dpr;
  const H = g.canvas.height / dpr;
  const css = (wx, wy) => {
    const [bx, by] = toScreen(cam, wx, wy);
    return [bx * k, by * k];
  };
  const hits = [];
  ui.hits = hits;

  g.save();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  // ------------------------------------------------------------ caravans
  // A pennant over any train that is carrying the word. This is how the
  // player sees the faith *travel*, which is the thing the whole game is about.
  if (fs.phase !== 'prologue') {
    for (const c of state.caravans) {
      // Only the Lantern flies a pennant. The old faiths travel too, but they
      // are the background the player is reading the map against.
      if (!c.faith) continue;
      const lead = PLAYER;
      const share = c.faith[lead];
      if (share < 0.2) continue;
      const [x, y] = css(c.x, c.y);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      const py = y - Math.max(14, 30 * STYLE.zoom);
      g.globalAlpha = Math.min(1, 0.35 + share);
      g.fillStyle = INK;
      g.fillRect(x - 1, py - 1, 2, 12);
      g.beginPath();
      g.moveTo(x + 1, py - 1);
      g.lineTo(x + 11, py + 3);
      g.lineTo(x + 1, py + 7);
      g.closePath();
      g.fillStyle = CREEDS[lead].color;
      g.fill();
      g.strokeStyle = INK;
      g.lineWidth = 1;
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  // --------------------------------------------------------------- towns
  const choosing = fs.phase === 'choose' || fs.phase === 'prologue';
  g.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  for (const t of state.towns) {
    const [x, y0] = css(t.x, t.y);
    if (x < -80 || y0 < -40 || x > W + 80 || y0 > H + 60) continue;
    const y = y0 - Math.max(22, 46 * STYLE.zoom);
    const f = faithOf(t);
    const keeps = keeper(f);
    const mark = fs.origin === t.id ? '✶ ' : '';
    const label = `${mark}${t.name}`;
    const tw = Math.ceil(g.measureText(label).width);
    const w = Math.max(48, tw + 16);
    const h = 26;
    const bx = Math.round(x - w / 2), by = Math.round(y - h / 2);

    if (fs.phase === 'choose' || (fs.phase === 'aspect' && fs.origin === t.id)) {
      // Every town is a candidate: make them throb so the choice is obvious.
      const pulse = 0.5 + 0.5 * Math.sin(now * 4 + t.id);
      g.strokeStyle = `rgba(242,193,75,${0.35 + 0.5 * pulse})`;
      g.lineWidth = 2;
      g.beginPath();
      g.ellipse(x, y0, 26 + 6 * pulse, 12 + 3 * pulse, 0, 0, Math.PI * 2);
      g.stroke();
    }

    pill(g, bx, by, w, h);
    g.fillStyle = INK;
    g.fill();
    if (ui.selected === t.id) {
      g.strokeStyle = PAPER;
      g.lineWidth = 2;
      g.stroke();
    } else if (keeps != null) {
      g.strokeStyle = CREEDS[keeps].color;
      g.lineWidth = 1.5;
      g.stroke();
    }
    g.fillStyle = keeps != null ? CREEDS[keeps].color : PAPER;
    g.fillText(label, x, by + 9);
    if (!choosing) shareBar(g, bx + 8, by + 17, w - 16, 3, f);
    else {
      g.fillStyle = 'rgba(246,239,226,0.6)';
      g.font = '10px ui-sans-serif, system-ui, sans-serif';
      g.fillText(`${Math.round(t.pop)}`, x, by + 19);
      g.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    }

    // The banner and the ground under it both count, so a tap on the town
    // itself works as well as a tap on its name.
    hits.push({ type: 'town', id: t.id, x0: bx - 4, y0: by - 4, x1: bx + w + 4, y1: y0 + 18 });
  }

  // --------------------------------------------------------------- fires
  // Flames on every tile of the burning front. Drawn here rather than as world
  // sprites because they have to read at whole-map zoom, where a fire is the
  // most interesting thing on the screen and a world-space flame is a pixel.
  const flame = Math.max(2, 5 * STYLE.zoom);
  for (const fire of state.nature.fires) {
    const [fx, fy] = css(fire.x, fire.y);
    if (fx < -300 || fy < -300 || fx > W + 300 || fy > H + 300) continue;
    for (const i of fire.front) {
      const wx = ((i % MAP.w) + 0.5) * TILE, wy = (((i / MAP.w) | 0) + 0.5) * TILE;
      const [x, y] = css(wx, wy);
      const flick = 0.6 + 0.4 * Math.sin(now * 13 + i * 1.7);
      g.fillStyle = 'rgba(255,120,40,0.35)';
      g.fillRect(x - flame, y - flame * 1.2, flame * 2, flame * 1.6);
      g.fillStyle = '#ff7a2a';
      g.fillRect(x - flame * 0.5, y - flame * (0.8 + flick), flame, flame * (0.8 + flick));
      g.fillStyle = '#ffd66b';
      g.fillRect(x - flame * 0.25, y - flame * 0.6 * flick, flame * 0.5, flame * 0.6 * flick);
    }
  }

  // --------------------------------------------------------------- omens
  for (const o of fs.omens) {
    const [gx, gy] = css(o.x, o.y);
    const rem = Math.max(0, 1 - (state.time - o.born) / o.life);
    const lift = 34;
    const bob = Math.sin(now * 3 + o.id) * 2;
    const onScreen = gx > 18 && gy > lift + 18 && gx < W - 18 && gy < H - 8;
    const icon = iconSprite(o.icon || o.kind, 2);
    const look = TIER_LOOK[o.tier] || TIER_LOOK[1];
    // Whether a tap would do anything. Without insight the bubble still shows,
    // but its price tag goes grey: it will be read by the faithful when it fades.
    const able = fs.insight >= 1;

    if (onScreen) {
      const bx = gx, by = gy - lift + bob;
      // Glow on the ground where it happened.
      const gr = 18 + o.tier * 8;
      const glow = g.createRadialGradient(gx, gy, 0, gx, gy, gr);
      glow.addColorStop(0, o.tier >= 3 ? 'rgba(255,150,90,0.6)' : 'rgba(255,226,140,0.5)');
      glow.addColorStop(1, 'rgba(255,226,140,0)');
      g.fillStyle = glow;
      g.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
      bubble(g, bx, by, look.r, icon, rem, look.ring, now, o.tier);
      // The price tag: what reading it yourself is worth, against what it is
      // worth if you let it pass. That pair is the whole decision.
      const tag = `${omenValue(state, o)} ✦`;
      g.font = '700 11px ui-sans-serif, system-ui, sans-serif';
      g.lineWidth = 3;
      g.strokeStyle = INK;
      g.strokeText(tag, bx + look.r + 14, by - look.r + 4);
      g.fillStyle = able ? CREEDS[PLAYER].color : '#9a9183';
      g.fillText(tag, bx + look.r + 14, by - look.r + 4);
      if (o.tier >= 2) {
        g.font = '600 10px ui-sans-serif, system-ui, sans-serif';
        g.strokeText(o.label, bx, gy + 14);
        g.fillStyle = PAPER;
        g.fillText(o.label, bx, gy + 14);
      }
      // Tail to the spot.
      g.fillStyle = PAPER;
      g.strokeStyle = INK;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(bx - 5, by + 15);
      g.lineTo(bx, by + 24);
      g.lineTo(bx + 5, by + 15);
      g.fill();
      g.stroke();
      hits.push({
        type: 'omen', id: o.id, x0: bx - look.r - 7, y0: by - look.r - 7, x1: bx + look.r + 7, y1: by + look.r + 11,
      });
    } else if (o.tier >= 2) {
      // Only portents and up get a pointer from the edge of the screen. A sign
      // off in the corner is not worth turning your head for; a fire is.
      // Off-screen: pin a smaller bubble to the edge, on the line from the
      // centre of the view toward it. Tapping this one flies there.
      // The frame it is pinned to is inset past the HUD: the top bar and the
      // town strip both sit over the canvas, and a pointer under either of them
      // is a pointer nobody can see.
      const inset = ui.inset || { top: 78, bottom: 72 };
      const top = inset.top, bottom = H - inset.bottom, left = 26, right = W - 26;
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      const dx = gx - cx, dy = gy - cy;
      const sx = ((right - left) / 2) / Math.max(1e-6, Math.abs(dx));
      const sy = ((bottom - top) / 2) / Math.max(1e-6, Math.abs(dy));
      const s = Math.min(sx, sy);
      const ex = cx + dx * s, ey = cy + dy * s;
      const a = Math.atan2(dy, dx);
      g.fillStyle = look.ring;
      g.beginPath();
      g.moveTo(ex + Math.cos(a) * 20, ey + Math.sin(a) * 20);
      g.lineTo(ex + Math.cos(a + 0.5) * 13, ey + Math.sin(a + 0.5) * 13);
      g.lineTo(ex + Math.cos(a - 0.5) * 13, ey + Math.sin(a - 0.5) * 13);
      g.closePath();
      g.fill();
      bubble(g, ex, ey, Math.max(13, look.r - 4), icon, rem, look.ring, now, o.tier);
      hits.push({ type: 'omenEdge', id: o.id, x0: ex - 20, y0: ey - 20, x1: ex + 20, y1: ey + 20 });
    }
  }

  // ------------------------------------------------------------ floaters
  g.font = '700 13px ui-sans-serif, system-ui, sans-serif';
  for (const q of floaters) {
    const [x, y] = css(q.x, q.y);
    const rise = 44 + q.t * 26;
    g.globalAlpha = q.t > 1.2 ? Math.max(0, 1 - (q.t - 1.2) / 0.6) : 1;
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.strokeText(q.text, x, y - rise);
    g.fillStyle = q.color;
    g.fillText(q.text, x, y - rise);
  }
  g.globalAlpha = 1;
  g.restore();
}

function bubble(g, x, y, r, icon, rem, ring, now, tier) {
  const pulse = 1 + (0.03 + 0.02 * tier) * Math.sin(now * (5 + tier));
  const rr = r * pulse;
  g.fillStyle = PAPER;
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, rr, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // The timer: a ring that drains clockwise from the top.
  g.strokeStyle = ring;
  g.lineWidth = 2 + tier * 0.5;
  g.beginPath();
  g.arc(x, y, rr + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * rem);
  g.stroke();
  const scale = r >= 19 ? 1.25 : r >= 16 ? 1 : 0.75;
  const w = icon.canvas.width * scale, h = icon.canvas.height * scale;
  g.drawImage(icon.canvas, Math.round(x - w / 2), Math.round(y - h / 2), w, h);
}
