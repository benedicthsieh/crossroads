// save.js — persistence and sharing.
//
// Thin on purpose. All the real work was done by keeping the game state free of
// canvases and closures, which is what makes "save" a call to JSON.stringify
// and "share" a string somebody can paste into another browser.

import { snapshot, restore, SAVE_VERSION } from './state.js';

// Versioned key rather than a versioned payload check: a v2 save describes a
// world of lone travellers and has no caravans in it at all, and a v3 one
// describes towns with no stores, no tents and no fields. Neither is worth
// migrating. Bumping the key just makes the old one invisible.
const KEY = 'crossroads.save.v4';

export function saveLocal(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot(state)));
    return true;
  } catch (err) {
    // Quota, private browsing, or a disabled storage API. Not fatal.
    console.warn('crossroads: could not save', err);
    return false;
  }
}

export function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return restore(JSON.parse(raw));
  } catch (err) {
    console.warn('crossroads: could not load save', err);
    return null;
  }
}

export function hasLocal() {
  try {
    return localStorage.getItem(KEY) != null;
  } catch {
    return false;
  }
}

export function clearLocal() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* nothing to do */ }
}

/** Size of the stored save in bytes, for the HUD. */
export function saveSize() {
  try {
    return (localStorage.getItem(KEY) || '').length;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------- share codes

// btoa only handles latin-1, so go through UTF-8 explicitly. Town names are
// ASCII today but that is not a thing to rely on.
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function b64ToUtf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** A whole game as one pasteable string. */
export function toShareCode(state) {
  return `CROSSROADS${SAVE_VERSION}:${utf8ToB64(JSON.stringify(snapshot(state)))}`;
}

export function fromShareCode(code) {
  const trimmed = (code || '').trim().replace(/\s+/g, '');
  const marker = trimmed.indexOf(':');
  if (marker < 0 || !trimmed.startsWith('CROSSROADS')) {
    throw new Error('that does not look like a Crossroads code');
  }
  const version = Number(trimmed.slice('CROSSROADS'.length, marker));
  if (version !== SAVE_VERSION) {
    throw new Error(`code is version ${version}, this build reads ${SAVE_VERSION}`);
  }
  return restore(JSON.parse(b64ToUtf8(trimmed.slice(marker + 1))));
}
