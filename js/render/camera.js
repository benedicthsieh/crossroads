// camera.js — pan, zoom, and the one bit of coordinate trickery in the project.
//
// Pixel art wants sprites baked on whole pixels; a map with four towns on it
// wants to be zoomable out to half size. Those pull in opposite directions, so
// the two are kept separate:
//
//   STYLE.scale  how big a sprite pixel is *baked*. Always 1, 2 or 3, so the
//                rasteriser never has to deal with half a pixel.
//   STYLE.zoom   how many screen pixels one world unit actually covers. Free
//                to be 0.5 or 2.4 or anything in between.
//
// The renderer closes the gap with a single canvas transform of zoom/scale, so
// every draw call downstream can keep working in baked-pixel space exactly as
// it did when the two were the same number. Changing zoom only re-bakes the art
// when it crosses into a different integer bracket, which is why dragging the
// slider stays smooth.

import { STYLE } from '../palette.js';
import { WORLD } from '../sim/terrain.js';

/**
 * The zoom slider's stops. Named rather than numbered — "2.0x pixel size" is a
 * renderer implementation detail, and nobody playing wants to think about it.
 */
export const ZOOM_STOPS = [
  { zoom: 0.35, label: 'Whole map' },
  { zoom: 0.55, label: 'Region' },
  { zoom: 0.85, label: 'Roads' },
  { zoom: 1.4, label: 'Town' },
  { zoom: 2, label: 'Street' },
  { zoom: 3, label: 'Close up' },
];

export const DEFAULT_STOP = 3;

/**
 * Zoom is continuous between these — the slider's stops are just convenient
 * places to land, and a pinch gesture is free to sit anywhere in between.
 */
export const ZOOM_MIN = ZOOM_STOPS[0].zoom;
export const ZOOM_MAX = ZOOM_STOPS[ZOOM_STOPS.length - 1].zoom;

/** The stop a given zoom is closest to, so the slider and label can follow. */
export function nearestStop(zoom) {
  let best = 0;
  for (let i = 1; i < ZOOM_STOPS.length; i++) {
    if (Math.abs(ZOOM_STOPS[i].zoom - zoom) < Math.abs(ZOOM_STOPS[best].zoom - zoom)) best = i;
  }
  return best;
}

/**
 * Integer bake size for a given zoom.
 *
 * `current` adds hysteresis. Re-baking costs every sprite plus a full repaint
 * of the road layer, and a pinch gesture that happens to settle right on a
 * bracket boundary would otherwise pay that bill several times a second. Pass
 * the scale in use and the bracket only changes once the zoom is clearly past
 * the boundary.
 */
export function bakeScaleFor(zoom, current = 0) {
  const raw = Math.max(1, Math.min(3, Math.round(zoom)));
  if (!current || raw === current) return raw;
  const boundary = raw > current ? current + 0.5 : current - 0.5;
  return Math.abs(zoom - boundary) < 0.12 ? current : raw;
}

export function makeCamera() {
  return {
    x: WORLD.w / 2,
    y: WORLD.h / 2,
    // Viewport in baked-pixel units. Cached because the coordinate transforms
    // run thousands of times a frame and must not allocate.
    view: { w: 0, h: 0 },
    dragging: false,
    lx: 0,
    ly: 0,
    moved: 0,
    follow: null,
  };
}

/** Extra canvas scale needed on top of the baked art. */
export function drawScale() {
  return STYLE.zoom / STYLE.scale;
}

export function resizeCamera(cam, canvas, g) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  applyTransform(cam, canvas, g, dpr);
  return dpr;
}

export function applyTransform(cam, canvas, g, dpr) {
  const z = dpr * drawScale();
  g.setTransform(z, 0, 0, z, 0, 0);
  g.imageSmoothingEnabled = false;
  cam.view.w = canvas.width / z;
  cam.view.h = canvas.height / z;
}

/** World -> baked-pixel screen space. */
export function toScreen(cam, wx, wy) {
  const s = STYLE.scale;
  return [(wx - cam.x) * s + cam.view.w / 2, (wy - cam.y) * s + cam.view.h / 2];
}

export function toWorld(cam, sx, sy) {
  const s = STYLE.scale;
  return [(sx - cam.view.w / 2) / s + cam.x, (sy - cam.view.h / 2) / s + cam.y];
}

export function clampCamera(cam) {
  const s = STYLE.scale;
  const halfW = cam.view.w / (2 * s);
  const halfH = cam.view.h / (2 * s);
  cam.x = halfW * 2 > WORLD.w ? WORLD.w / 2 : Math.max(halfW, Math.min(WORLD.w - halfW, cam.x));
  cam.y = halfH * 2 > WORLD.h ? WORLD.h / 2 : Math.max(halfH, Math.min(WORLD.h - halfH, cam.y));
}

/** Visible world rectangle, with a margin for sprites that overhang it. */
export function viewBounds(cam, margin = 60) {
  const [x0, y0] = toWorld(cam, -margin * STYLE.scale, -margin * STYLE.scale);
  const [x1, y1] = toWorld(
    cam,
    cam.view.w + margin * STYLE.scale,
    cam.view.h + margin * STYLE.scale,
  );
  return { x0, y0, x1, y1 };
}
