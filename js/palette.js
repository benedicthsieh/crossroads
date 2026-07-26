// palette.js — the art-direction dials.
//
// Three complete looks. Swapping one re-bakes every sprite and the ground, so
// this is the fastest way to judge an art style side by side.
//
// The art test is over: the game runs on the values below and never changes
// them. Only `demo/index.html` still exposes them as live controls, which is
// what they exist for now — a lab for re-deciding the look, not a game setting.
// The one dial that survived into the game is zoom, and it is a camera control
// rather than an art one.

export const STYLE = {
  // --- locked -------------------------------------------------------------
  outline: 'selout',   // 'selout' | 'hard' | 'off'
  rim: 0.2,            // rim-light strength
  shadow: 'soft',      // 'soft' | 'hard' | 'off'
  palette: 'storybook',
  dayNight: true,
  timeOfDay: 0.32,     // 0..1, 0 = midnight

  // --- live ---------------------------------------------------------------
  // `scale` is the integer size a sprite pixel is *baked* at. `zoom` is how
  // many screen pixels one world unit actually covers, and the renderer makes
  // up the difference with a canvas transform. Keeping them apart is what lets
  // zoom be continuous (0.5–3) while the pixel art stays baked on whole pixels.
  scale: 2,
  zoom: 2,
  labels: false,
  speed: 1,
};

const SHARED = {
  eye: '#2b1f1a',
  mouth: '#7a4b3a',
  white: '#f6efe2',
  coin: '#f2c14b',
  coinDark: '#b8862a',
};

export const PALETTES = {
  // Warm, saturated, slightly desaturated shadows. Reads like a picture book.
  storybook: {
    name: 'Storybook',
    grass: ['#6ea84c', '#77b455', '#639b46', '#82be5e'],
    grassDeep: '#4f7f39',
    dirt: ['#bd8f5f', '#c69a6b', '#b0824f'],
    dirtDeep: '#9b6c41',
    plaza: ['#c8a377', '#d0ad82', '#bd9569'],
    stone: '#a2aab4',
    stoneDark: '#7d8794',
    wood: '#8d5f3c',
    woodDark: '#6b452b',
    woodLight: '#a97a4f',
    plaster: '#efe0c2',
    plasterDark: '#d8c4a0',
    roof: ['#b5503f', '#c2604a', '#8f3f34'],
    roofAlt: ['#5b7fa8', '#6a90ba', '#47658a'],
    leaf: ['#4f8b3f', '#5e9c4a', '#417531'],
    leafAlt: ['#6b9a45', '#7cab52'],
    trunk: '#7a5334',
    wheat: '#e0b452',
    wheatDark: '#b98c33',
    water: '#5f9fd0',
    cloth: [
      ['#c2564a', '#96382f'], // red
      ['#4f7fb5', '#375f8e'], // blue
      ['#6f9a4a', '#4f7533'], // green
      ['#b3823f', '#8a5f27'], // ochre
      ['#8a6aa8', '#654c80'], // plum
      ['#c98a4a', '#9c6531'], // orange
      ['#5d6b7a', '#414d5a'], // slate
      ['#c9b487', '#a08a5e'],
    ],
    skin: [
      ['#f0c39a', '#d19f74'],
      ['#e0a877', '#bb8253'],
      ['#c08757', '#9a663d'],
      ['#8d5c3a', '#6d4227'],
      ['#5f3d28', '#472a1a'],
    ],
    hair: ['#4a3327', '#2f231c', '#8a5a2e', '#c9993f', '#6b4a3a', '#3d3d42'],
    night: '#16233f',
    nightStrength: 0.68,
    lamp: '#ffd27a',
  },

  // Cooler and lower-contrast — closer to the muted look of a strategy game
  // where the units need to read against a busy map.
  muted: {
    name: 'Muted',
    grass: ['#6f8c5c', '#7a9765', '#657f53', '#84a06d'],
    grassDeep: '#54704a',
    dirt: ['#a89078', '#b19a82', '#9c8369'],
    dirtDeep: '#8a7057',
    plaza: ['#b3a189', '#bcab94', '#a6947c'],
    stone: '#9aa0a4',
    stoneDark: '#787f85',
    wood: '#7e6249',
    woodDark: '#5f4936',
    woodLight: '#98785a',
    plaster: '#e2d8c4',
    plasterDark: '#c8bca6',
    roof: ['#9a5a4e', '#a86a5c', '#7d4740'],
    roofAlt: ['#5e7488', '#6d8398', '#4b5e70'],
    leaf: ['#517045', '#5d7d50', '#44603a'],
    leafAlt: ['#63804a', '#708c57'],
    trunk: '#6d5540',
    wheat: '#cdae6f',
    wheatDark: '#a88d4f',
    water: '#6b93ad',
    cloth: [
      ['#a5605a', '#7f453f'],
      ['#5b7590', '#41576e'],
      ['#6b8560', '#4e6545'],
      ['#a08757', '#7d6740'],
      ['#7d6b8a', '#5c4e68'],
      ['#a87a58', '#805a3e'],
      ['#61696f', '#464c52'],
      ['#b0a288', '#8b7e66'],
    ],
    skin: [
      ['#e6c1a0', '#c49f7e'],
      ['#d4a880', '#ae8460'],
      ['#b58a63', '#8f6944'],
      ['#8a6044', '#68452e'],
      ['#5d4130', '#432d21'],
    ],
    hair: ['#4a3a30', '#332a24', '#7d6042', '#b39a5f', '#63504a', '#43444a'],
    night: '#1a2432',
    nightStrength: 0.62,
    lamp: '#f0cf94',
  },

  // Punchy and toy-like. Good for testing whether the silhouettes hold up.
  vivid: {
    name: 'Vivid',
    grass: ['#5fbc4a', '#6ecd55', '#52a840', '#7fdc63'],
    grassDeep: '#3f8c34',
    dirt: ['#d09a5c', '#dba769', '#bd8a4c'],
    dirtDeep: '#a36f38',
    plaza: ['#e0b478', '#ecc186', '#cea369'],
    stone: '#adb8c4',
    stoneDark: '#84909e',
    wood: '#9a6538',
    woodDark: '#734825',
    woodLight: '#bb8548',
    plaster: '#fdf0cd',
    plasterDark: '#e8d3a6',
    roof: ['#e0523c', '#f06546', '#b03c2c'],
    roofAlt: ['#4f8bd0', '#5f9ee4', '#3a6aa8'],
    leaf: ['#48a63c', '#57ba48', '#38872e'],
    leafAlt: ['#78bd42', '#8ad04f'],
    trunk: '#8a5a2f',
    wheat: '#ffca4f',
    wheatDark: '#d19a2c',
    water: '#4fb0e8',
    cloth: [
      ['#e05a4a', '#b0372c'],
      ['#4f8fd8', '#3663a8'],
      ['#6fbc46', '#4a8a2c'],
      ['#e0a03c', '#b07826'],
      ['#a06fd0', '#7549a0'],
      ['#f0904a', '#c0632a'],
      ['#5f7590', '#425468'],
      ['#f0dc96', '#c0a860'],
    ],
    skin: [
      ['#ffd0a4', '#e0aa7c'],
      ['#f0b47f', '#c88c58'],
      ['#cc9058', '#a26c3c'],
      ['#96603a', '#704326'],
      ['#66402a', '#4a2a1c'],
    ],
    hair: ['#503524', '#2f2018', '#96602c', '#e0b44a', '#74503c', '#40404a'],
    night: '#131f45',
    nightStrength: 0.7,
    lamp: '#ffdc8a',
  },
};

// Guard rail: a single bad hex literal would otherwise show up as invisible
// pixels scattered through the sprites, which is a miserable thing to debug.
const HEX = /^#[0-9a-fA-F]{6}$/;
function scrub(value, fallback) {
  if (typeof value === 'string') return HEX.test(value) ? value : fallback;
  if (Array.isArray(value)) return value.map((v) => scrub(v, fallback));
  return value;
}
for (const pal of Object.values(PALETTES)) {
  for (const key of Object.keys(pal)) {
    if (key === 'name' || typeof pal[key] === 'number') continue;
    pal[key] = scrub(pal[key], '#b08a5a');
  }
  Object.assign(pal, SHARED);
}

export function pal() {
  return PALETTES[STYLE.palette];
}

/**
 * Cache key for every baked sprite. Anything in here that changes invalidates
 * the art, so it must cover every field that affects how a pixel is drawn.
 */
export function styleKey() {
  return `${STYLE.palette}|${STYLE.scale}|${STYLE.outline}|${STYLE.rim}`;
}
