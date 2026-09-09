/**
 * heightfield.js — Deterministic procedural terrain for Dead Drop Island.
 *
 * This module is intentionally dependency-free and isomorphic: it is imported by
 * the renderer (terrain.js), the navmesh baker (tools/), the loot placer, and the
 * unit tests. Every consumer must agree on the exact same ground height for a
 * given (x, z) or props will float and bots will path into hillsides.
 *
 * Coordinate space: world metres, origin at island centre, X east, Z south.
 * Y is up. Sea level is y = 0. Peak elevation ~160m on the northeast ridge.
 */

import mapConfig from '../config/map.json' with { type: 'json' };

const { halfSize, maxElevation } = mapConfig;
const F = mapConfig.terrainFeatures;

/* ------------------------------------------------------------------ */
/* Deterministic value noise                                           */
/* ------------------------------------------------------------------ */

/** Integer hash → [0,1). Stable across platforms (uses Math.imul). */
export function hash2(ix, iz, seed = 0) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/** 2D value noise with smoothstep interpolation. Domain: noise cells of size 1. */
export function valueNoise2D(x, z, seed = 0) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = smoothstep(x - x0);
  const fz = smoothstep(z - z0);
  const n00 = hash2(x0, z0, seed);
  const n10 = hash2(x0 + 1, z0, seed);
  const n01 = hash2(x0, z0 + 1, seed);
  const n11 = hash2(x0 + 1, z0 + 1, seed);
  const nx0 = n00 + (n10 - n00) * fx;
  const nx1 = n01 + (n11 - n01) * fx;
  return nx0 + (nx1 - nx0) * fz;
}

/** Fractal Brownian motion. Returns roughly [0,1]. */
export function fbm(x, z, octaves = 5, lacunarity = 2.03, gain = 0.5, seed = 0) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2D(x * freq, z * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise — produces sharp mountain crests rather than rolling blobs. */
export function ridged(x, z, octaves = 4, seed = 0) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise2D(x * freq, z * freq, seed + o * 733) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothFalloff(dist, radius, feather) {
  if (dist >= radius) return 0;
  if (dist <= radius - feather) return 1;
  return smoothstep((radius - dist) / feather);
}

/** Shortest distance from point to a polyline, plus the parametric position. */
export function distanceToPolyline(x, z, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0;
    t = clamp(t, 0, 1);
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) best = d;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Island shape                                                        */
/* ------------------------------------------------------------------ */

/**
 * Island mask: 1 deep inland, 0 out at sea. Uses a noisy radial falloff so the
 * coastline is irregular (bays, headlands) rather than a perfect circle.
 */
export function islandMask(x, z) {
  const nx = x / halfSize;
  const nz = z / halfSize;
  // Slightly elliptical — the island is wider east-west, like OG Chapter 1.
  const r = Math.sqrt(nx * nx * 0.94 + nz * nz * 1.06);
  // Coastline wobble.
  const angle = Math.atan2(nz, nx);
  const wobble =
    0.045 * Math.sin(angle * 3.0 + 1.3) +
    0.030 * Math.sin(angle * 5.0 - 0.7) +
    0.018 * Math.sin(angle * 8.0 + 2.4) +
    0.04 * (fbm(x * 0.0011, z * 0.0011, 3, 2.0, 0.5, 71) - 0.5);
  const coast = 0.965 + wobble;
  // 1 inside, 0 outside, feathered over the last 14% for beaches.
  return clamp((coast - r) / 0.14, 0, 1);
}

/* ------------------------------------------------------------------ */
/* Named-location flattening                                           */
/* ------------------------------------------------------------------ */

// Precompute the location list once; getHeight is called millions of times.
const LOCATIONS = mapConfig.namedLocations.map((l) => ({
  x: l.x,
  z: l.z,
  radius: l.radius,
  elevation: l.elevation,
  flatten: l.flatten ?? 0.9,
  isLake: !!l.isLake,
}));

/* ------------------------------------------------------------------ */
/* Core height function                                                */
/* ------------------------------------------------------------------ */

/**
 * Ground height in metres at world position (x, z).
 * Below sea level values are real (the ocean floor) — callers that need a
 * walkable surface should clamp against the water plane themselves.
 */
export function getHeight(x, z) {
  const mask = islandMask(x, z);

  // --- Base rolling terrain -----------------------------------------
  const broad = fbm(x * 0.00042, z * 0.00042, 4, 2.05, 0.52, 11);
  const mid = fbm(x * 0.0016, z * 0.0016, 4, 2.02, 0.5, 29);
  const detail = fbm(x * 0.0075, z * 0.0075, 3, 2.1, 0.45, 53);

  // Rolling hills: a second broad band at a different frequency and phase
  // keeps the central plain from reading as a uniform green table.
  const hills = fbm(x * 0.00085, z * 0.00085, 3, 2.0, 0.55, 167);
  const hillMask = smoothstep(clamp((hills - 0.35) / 0.5, 0, 1));

  let h = broad * 58 + mid * 26 + detail * 5.0 + hillMask * hills * 34;

  // --- Northeast highland ridge (Whisper Woods) ---------------------
  const ridgeCfg = F.ridge;
  const ridgeDist = Math.hypot(x - ridgeCfg.x, z - ridgeCfg.z);
  const ridgeInf = smoothFalloff(ridgeDist, ridgeCfg.radius, ridgeCfg.radius * 0.85);
  if (ridgeInf > 0) {
    const crest = ridged(x * 0.0021, z * 0.0021, 4, 91);
    h += ridgeInf * (ridgeCfg.height * (0.42 + 0.58 * crest));
  }

  // --- Eastern coastal cliffs ---------------------------------------
  const cliff = F.cliffs;
  if (x > cliff.dropStart) {
    const t = clamp((x - cliff.dropStart) / (cliff.x - cliff.dropStart), 0, 1);
    // Sharp shelf then a plunge to the sea.
    const plunge = smoothstep(t);
    h += cliff.height * (1 - plunge) * 0.55;
    h -= plunge * plunge * (h + 40) * 0.9;
  }

  // --- Western beach gradient ---------------------------------------
  const beach = F.beach;
  if (x < beach.gradientStart) {
    const t = clamp((beach.gradientStart - x) / (beach.gradientStart - beach.x), 0, 1);
    h *= 1 - smoothstep(t) * 0.86;
    h += 1.5 * (1 - t);
  }

  // --- Apply island mask so natural terrain sinks into the ocean -----
  // This happens BEFORE town flattening: named locations sit on designed
  // pads that must survive the coastal falloff (Highcliff Estates is on a
  // clifftop, Bogwater Basin is low but must stay above the waterline).
  const oceanFloor = -22 - fbm(x * 0.0009, z * 0.0009, 3, 2.0, 0.5, 131) * 12;
  h = oceanFloor + (h - oceanFloor) * smoothstep(mask);

  // --- Named location flattening ------------------------------------
  // Towns need buildable ground. Blend the natural height toward the
  // location's designed elevation across its radius.
  for (let i = 0; i < LOCATIONS.length; i++) {
    const loc = LOCATIONS[i];
    if (loc.isLake) continue;
    const dx = x - loc.x;
    const dz = z - loc.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > loc.radius * 1.5) continue;
    const infl = smoothFalloff(d, loc.radius * 1.5, loc.radius * 1.2) * loc.flatten;
    if (infl > 0) h = h * (1 - infl) + loc.elevation * infl;
  }

  // --- Lake depression (Mirror Lake) --------------------------------
  const lake = F.lake;
  const lakeDist = Math.hypot(x - lake.x, z - lake.z);
  if (lakeDist < lake.radius * 1.35) {
    const bowl = smoothFalloff(lakeDist, lake.radius * 1.35, lake.radius * 1.1);
    // Parabolic basin bottoming out at -depth relative to shoreline.
    const inner = clamp(1 - lakeDist / lake.radius, 0, 1);
    h = h * (1 - bowl) + (lake.waterLevel - lake.depth * inner * inner) * bowl;
  }

  // --- River carving -------------------------------------------------
  const river = F.river;
  const riverDist = distanceToPolyline(x, z, river.points);
  if (riverDist < river.width * 2.2) {
    const carve = smoothFalloff(riverDist, river.width * 2.2, river.width * 1.7);
    const bed = clamp(1 - riverDist / river.width, 0, 1);
    h -= carve * river.depth * (0.35 + 0.65 * bed * bed);
  }

  // --- Ravine (north-centre travel barrier) --------------------------
  const rav = F.ravine;
  const ravDist = distanceToPolyline(x, z, rav.points);
  if (ravDist < rav.width) {
    const cut = smoothFalloff(ravDist, rav.width, rav.width * 0.72);
    const floorT = clamp(1 - ravDist / (rav.width * 0.45), 0, 1);
    h -= cut * rav.depth * (0.3 + 0.7 * smoothstep(floorT));
  }

  return clamp(h, -46, maxElevation + 20);
}

/* ------------------------------------------------------------------ */
/* Derived queries                                                     */
/* ------------------------------------------------------------------ */

/** Surface normal via central differences. `eps` in metres. */
export function getNormal(x, z, eps = 1.0, out = { x: 0, y: 1, z: 0 }) {
  const hL = getHeight(x - eps, z);
  const hR = getHeight(x + eps, z);
  const hD = getHeight(x, z - eps);
  const hU = getHeight(x, z + eps);
  let nx = hL - hR;
  let ny = 2 * eps;
  let nz = hD - hU;
  const len = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / len;
  out.y = ny / len;
  out.z = nz / len;
  return out;
}

/** Slope in degrees from horizontal. */
export function getSlope(x, z, eps = 1.0) {
  const n = getNormal(x, z, eps);
  return Math.acos(clamp(n.y, -1, 1)) * (180 / Math.PI);
}

/** True when the point is under water (lake, river or ocean). */
export function isWater(x, z) {
  return getHeight(x, z) < getWaterLevel(x, z);
}

/** Water surface height at a position — lake surface inland, 0 at sea. */
export function getWaterLevel(x, z) {
  const lake = F.lake;
  const d = Math.hypot(x - lake.x, z - lake.z);
  if (d < lake.radius * 1.2) return lake.waterLevel;
  return 0;
}

/**
 * Terrain layer index (0-5) for texture splatting and footstep surface audio.
 * Matches mapConfig.terrainLayers ordering.
 */
export function getLayerIndex(x, z) {
  const h = getHeight(x, z);
  const slope = getSlope(x, z, 1.5);
  if (slope > 38) return 5; // bare rock on cliff faces
  if (h < -2.0) return 0; // ocean floor
  if (h < 4.0) return 1; // beach sand / riverbank
  if (h > 100) return 4; // highland
  const forest = fbm(x * 0.0013, z * 0.0013, 3, 2.0, 0.5, 211);
  if (h > 70) return forest > 0.5 ? 4 : 3;
  return forest > 0.62 ? 3 : 2;
}

/** Footstep surface id used by the audio engine. */
export function getSurfaceType(x, z) {
  if (isWater(x, z)) return 'water';
  const layer = getLayerIndex(x, z);
  switch (layer) {
    case 0:
    case 1:
      return 'sand';
    case 5:
      return 'gravel';
    default:
      return 'grass';
  }
}

/**
 * Sample the height of the highest walkable surface, clamped to water level so
 * swimming entities float rather than sinking to the lakebed.
 */
export function getWalkHeight(x, z) {
  const ground = getHeight(x, z);
  const water = getWaterLevel(x, z);
  return ground < water ? water : ground;
}

/** Distance from island centre to the coastline along the ray to (x,z). */
export function isInsidePlayableArea(x, z) {
  return Math.abs(x) < halfSize && Math.abs(z) < halfSize && islandMask(x, z) > 0.02;
}

export const heightfieldConfig = { halfSize, maxElevation };

export default {
  getHeight,
  getNormal,
  getSlope,
  getWalkHeight,
  getWaterLevel,
  getLayerIndex,
  getSurfaceType,
  isWater,
  islandMask,
  isInsidePlayableArea,
  fbm,
  ridged,
  valueNoise2D,
  hash2,
  distanceToPolyline,
};
