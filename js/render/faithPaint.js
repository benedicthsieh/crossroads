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
import { CREEDS, PLAYER, RIVAL, faithOf } from '../sim/faith.js';

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

function shareBar(g, x, y, w, h, f) {
  g.fillStyle = INK;
  g.fillRect(x - 1, y - 1, w + 2, h + 2);
  g.fillStyle = UNBELIEF;
  g.fillRect(x, y, w, h);
  const a = Math.round(w * f[PLAYER]);
  const b = Math.round(w * f[RIVAL]);
  g.fillStyle = CREEDS[PLAYER].color;
  g.fillRect(x, y, a, h);
  g.fillStyle = CREEDS[RIVAL].color;
  g.fillRect(x + w - b, y, b, h);
}

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
      if (!c.faith) continue;
      const lead = c.faith[PLAYER] >= c.faith[RIVAL] ? PLAYER : RIVAL;
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
    const keeps = f[PLAYER] >= 0.5 ? PLAYER : f[RIVAL] >= 0.5 ? RIVAL : null;
    const mark = fs.origin === t.id || fs.rivalOrigin === t.id ? '✶ ' : '';
    const label = `${mark}${t.name}`;
    const tw = Math.ceil(g.measureText(label).width);
    const w = Math.max(48, tw + 16);
    const h = 26;
    const bx = Math.round(x - w / 2), by = Math.round(y - h / 2);

    if (choosing && fs.phase === 'choose') {
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
    if (fs.phase !== 'prologue') shareBar(g, bx + 8, by + 17, w - 16, 3, f);
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

  // --------------------------------------------------------------- omens
  const rivalLive = fs.rivalOrigin != null;
  for (const o of fs.omens) {
    const [gx, gy] = css(o.x, o.y);
    const rem = Math.max(0, 1 - (state.time - o.born) / o.life);
    const lift = 34;
    const bob = Math.sin(now * 3 + o.id) * 2;
    const onScreen = gx > 18 && gy > lift + 18 && gx < W - 18 && gy < H - 8;
    const icon = iconSprite(o.kind, 2);
    // Late in its life, while the rival could still take it, the timer turns
    // the rival's colour. That is the cue that ignoring it has a cost.
    const urgent = rivalLive && !o.tried && rem < 0.6;

    if (onScreen) {
      const bx = gx, by = gy - lift + bob;
      // Glow on the ground where it happened.
      const glow = g.createRadialGradient(gx, gy, 0, gx, gy, 26);
      glow.addColorStop(0, 'rgba(255,226,140,0.55)');
      glow.addColorStop(1, 'rgba(255,226,140,0)');
      g.fillStyle = glow;
      g.fillRect(gx - 26, gy - 26, 52, 52);
      bubble(g, bx, by, 17, icon, rem, urgent, now);
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
      hits.push({ type: 'omen', id: o.id, x0: bx - 24, y0: by - 24, x1: bx + 24, y1: by + 28 });
    } else {
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
      g.fillStyle = urgent ? CREEDS[RIVAL].color : CREEDS[PLAYER].color;
      g.beginPath();
      g.moveTo(ex + Math.cos(a) * 20, ey + Math.sin(a) * 20);
      g.lineTo(ex + Math.cos(a + 0.5) * 13, ey + Math.sin(a + 0.5) * 13);
      g.lineTo(ex + Math.cos(a - 0.5) * 13, ey + Math.sin(a - 0.5) * 13);
      g.closePath();
      g.fill();
      bubble(g, ex, ey, 13, icon, rem, urgent, now);
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

function bubble(g, x, y, r, icon, rem, urgent, now) {
  const pulse = 1 + 0.05 * Math.sin(now * 7);
  const rr = r * pulse;
  g.fillStyle = PAPER;
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, rr, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // The timer: a ring that drains clockwise from the top.
  g.strokeStyle = urgent ? CREEDS[RIVAL].color : CREEDS[PLAYER].color;
  g.lineWidth = 3;
  g.beginPath();
  g.arc(x, y, rr + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * rem);
  g.stroke();
  const scale = r >= 16 ? 1 : 0.75;
  const w = icon.canvas.width * scale, h = icon.canvas.height * scale;
  g.drawImage(icon.canvas, Math.round(x - w / 2), Math.round(y - h / 2), w, h);
}
