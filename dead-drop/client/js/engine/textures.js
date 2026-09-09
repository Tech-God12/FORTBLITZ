/**
 * textures.js — Procedural texture atlas for Dead Drop.
 *
 * All surface detail in the game is authored here on 2D canvases and uploaded
 * as Three.js textures. Every generator also emits a matching normal map
 * derived from the albedo luminance via Sobel, so materials react to the sun.
 *
 * Style rule: albedo is authored ~1.2x more saturated than photoreal, and
 * roughness stays high. Fortnite surfaces are matte and punchy, not glossy.
 */

import * as THREE from 'three';

const cache = new Map();

/* ------------------------------------------------------------------ */
/* Canvas helpers                                                      */
/* ------------------------------------------------------------------ */

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/** Deterministic PRNG so textures are identical across reloads. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value-noise field rendered into an ImageData-compatible array. */
function noiseField(size, scale, octaves, seed) {
  const rnd = mulberry32(seed);
  const gridSize = Math.max(2, Math.round(scale));
  const grids = [];
  for (let o = 0; o < octaves; o++) {
    const g = gridSize * Math.pow(2, o);
    const vals = new Float32Array(g * g);
    for (let i = 0; i < vals.length; i++) vals[i] = rnd();
    grids.push({ g, vals });
  }
  const out = new Float32Array(size * size);
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      let amp = 1;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        const { g, vals } = grids[o];
        const fx = (x / size) * g;
        const fy = (y / size) * g;
        const x0 = Math.floor(fx) % g;
        const y0 = Math.floor(fy) % g;
        const x1 = (x0 + 1) % g;
        const y1 = (y0 + 1) % g;
        const tx = smooth(fx - Math.floor(fx));
        const ty = smooth(fy - Math.floor(fy));
        const a = vals[y0 * g + x0];
        const b = vals[y0 * g + x1];
        const c = vals[y1 * g + x0];
        const d = vals[y1 * g + x1];
        const top = a + (b - a) * tx;
        const bot = c + (d - c) * tx;
        sum += amp * (top + (bot - top) * ty);
        norm += amp;
        amp *= 0.5;
      }
      out[y * size + x] = sum / norm;
    }
  }
  return out;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

/** Build a THREE.Texture from a canvas with sane repeat/aniso defaults. */
function toTexture(canvas, repeat = 1, aniso = 8, srgb = true) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = aniso;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Derive a tangent-space normal map from an albedo canvas using a Sobel
 * operator on luminance. `strength` scales the perceived bumpiness.
 */
export function normalFromCanvas(srcCanvas, strength = 2.0) {
  const size = srcCanvas.width;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const src = sctx.getImageData(0, 0, size, size).data;

  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    lum[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  }

  const out = makeCanvas(size);
  const octx = out.getContext('2d');
  const img = octx.createImageData(size, size);
  const at = (x, y) => lum[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        at(x + 1, y - 1) - 2 * at(x + 1, y) - at(x + 1, y + 1);
      const gy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        at(x - 1, y + 1) - 2 * at(x, y + 1) - at(x + 1, y + 1);
      let nx = -gx * strength;
      let ny = -gy * strength;
      const nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz / len) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/** Produce a roughness map canvas from a noise field. */
function roughnessCanvas(size, base, variation, seed) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const n = noiseField(size, 8, 4, seed);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(1, base + (n[i] - 0.5) * variation)) * 255;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------ */
/* Surface generators                                                  */
/* ------------------------------------------------------------------ */

/** Bright saturated Fortnite grass with clumping and blade speckle. */
function genGrass(size, seed = 7, baseHex = '#4A8C2A', darkHex = '#2F6B1B', liteHex = '#6FB33F') {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const base = hexToRgb(baseHex);
  const dark = hexToRgb(darkHex);
  const lite = hexToRgb(liteHex);

  const clump = noiseField(size, 5, 4, seed);
  const fine = noiseField(size, 22, 3, seed + 91);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const t = clump[i] * 0.65 + fine[i] * 0.35;
    let r, g, b;
    if (t < 0.5) {
      const k = t / 0.5;
      r = mix(dark[0], base[0], k);
      g = mix(dark[1], base[1], k);
      b = mix(dark[2], base[2], k);
    } else {
      const k = (t - 0.5) / 0.5;
      r = mix(base[0], lite[0], k);
      g = mix(base[1], lite[1], k);
      b = mix(base[2], lite[2], k);
    }
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Blade speckle for close-up detail.
  const rnd = mulberry32(seed + 5);
  for (let i = 0; i < size * 12; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const l = 2 + rnd() * 4;
    ctx.strokeStyle = `rgba(${Math.round(mix(lite[0], 255, rnd() * 0.3))},${Math.round(lite[1])},${Math.round(lite[2])},${0.15 + rnd() * 0.3})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 2, y - l);
    ctx.stroke();
  }
  return c;
}

/** Sand / riverbank. */
function genSand(size, seed = 21) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const base = hexToRgb('#D9C48A');
  const dark = hexToRgb('#BFA96D');
  const n = noiseField(size, 10, 4, seed);
  const fine = noiseField(size, 40, 2, seed + 3);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const t = n[i] * 0.7 + fine[i] * 0.3;
    img.data[i * 4] = mix(dark[0], base[0], t);
    img.data[i * 4 + 1] = mix(dark[1], base[1], t);
    img.data[i * 4 + 2] = mix(dark[2], base[2], t);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const rnd = mulberry32(seed);
  for (let i = 0; i < size * 3; i++) {
    ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.12})`;
    ctx.fillRect(rnd() * size, rnd() * size, 1, 1);
  }
  return c;
}

/** Rock / cliff face. */
function genRock(size, seed = 33) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const base = hexToRgb('#7A7469');
  const dark = hexToRgb('#4E4A43');
  const lite = hexToRgb('#9A9488');
  const n = noiseField(size, 6, 5, seed);
  const strata = noiseField(size, 3, 2, seed + 17);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const y = Math.floor(i / size);
    const band = Math.sin((y / size) * Math.PI * 6 + strata[i] * 4) * 0.12;
    const t = Math.max(0, Math.min(1, n[i] + band));
    let r, g, b;
    if (t < 0.5) {
      const k = t / 0.5;
      r = mix(dark[0], base[0], k); g = mix(dark[1], base[1], k); b = mix(dark[2], base[2], k);
    } else {
      const k = (t - 0.5) / 0.5;
      r = mix(base[0], lite[0], k); g = mix(base[1], lite[1], k); b = mix(base[2], lite[2], k);
    }
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Crack lines.
  const rnd = mulberry32(seed + 8);
  ctx.strokeStyle = 'rgba(40,36,32,0.5)';
  for (let i = 0; i < 18; i++) {
    ctx.lineWidth = 0.6 + rnd() * 1.4;
    ctx.beginPath();
    let x = rnd() * size, y = rnd() * size;
    ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += (rnd() - 0.5) * size * 0.16;
      y += (rnd() - 0.5) * size * 0.16;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return c;
}

/** Pale pine planks — the wood building material. */
function genWoodPlanks(size, seed = 51) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed);
  const planks = 6;
  const ph = size / planks;
  const grain = noiseField(size, 30, 3, seed + 2);

  for (let p = 0; p < planks; p++) {
    const shade = 0.86 + rnd() * 0.24;
    const r = 196 * shade, g = 158 * shade, b = 104 * shade;
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(0, p * ph, size, ph);
    // Grain streaks along the plank.
    for (let i = 0; i < 26; i++) {
      const y = p * ph + rnd() * ph;
      ctx.strokeStyle = `rgba(${(r * 0.72) | 0},${(g * 0.68) | 0},${(b * 0.6) | 0},${0.12 + rnd() * 0.26})`;
      ctx.lineWidth = 0.5 + rnd() * 1.6;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= size; x += 16) {
        ctx.lineTo(x, y + Math.sin(x * 0.03 + p) * 1.8 + (grain[(Math.floor(y) % size) * size + (x % size)] - 0.5) * 3);
      }
      ctx.stroke();
    }
    // Knot.
    if (rnd() > 0.55) {
      const kx = rnd() * size, ky = p * ph + ph * 0.5;
      for (let ring = 5; ring > 0; ring--) {
        ctx.strokeStyle = `rgba(${(r * 0.55) | 0},${(g * 0.5) | 0},${(b * 0.42) | 0},0.5)`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(kx, ky, ring * 2.2, ring * 1.4, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Plank seam.
    ctx.fillStyle = 'rgba(60,42,24,0.55)';
    ctx.fillRect(0, p * ph, size, 2);
  }
  return c;
}

/** Red-brown masonry — the brick building material. */
function genBrick(size, seed = 63) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed);
  ctx.fillStyle = '#B9B2A6'; // mortar
  ctx.fillRect(0, 0, size, size);

  const rows = 10;
  const bh = size / rows;
  const bw = size / 5;
  for (let r = 0; r < rows; r++) {
    const offset = r % 2 === 0 ? 0 : bw / 2;
    for (let i = -1; i < 6; i++) {
      const x = i * bw + offset;
      const y = r * bh;
      const shade = 0.82 + rnd() * 0.32;
      const cr = Math.min(255, 168 * shade);
      const cg = Math.min(255, 74 * shade);
      const cb = Math.min(255, 52 * shade);
      ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
      ctx.fillRect(x + 1.5, y + 1.5, bw - 3, bh - 3);
      // Surface mottling.
      for (let s = 0; s < 8; s++) {
        ctx.fillStyle = `rgba(${(cr * 0.8) | 0},${(cg * 0.75) | 0},${(cb * 0.7) | 0},${rnd() * 0.25})`;
        ctx.fillRect(x + 2 + rnd() * (bw - 6), y + 2 + rnd() * (bh - 6), 2 + rnd() * 6, 1 + rnd() * 3);
      }
    }
  }
  return c;
}

/** Grey steel panel with rivets — the metal building material. */
function genMetal(size, seed = 77) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed);
  const n = noiseField(size, 12, 3, seed);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 122 + (n[i] - 0.5) * 34;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v + 3;
    img.data[i * 4 + 2] = v + 8;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Panel division lines.
  ctx.strokeStyle = 'rgba(60,64,70,0.75)';
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, size - 8, size - 8);
  ctx.beginPath();
  ctx.moveTo(size / 2, 4);
  ctx.lineTo(size / 2, size - 4);
  ctx.stroke();

  // Rivets around the panel border.
  const rivet = (x, y) => {
    const g = ctx.createRadialGradient(x - 1, y - 1, 0.5, x, y, 4);
    g.addColorStop(0, '#d8dde4');
    g.addColorStop(0.6, '#9aa1aa');
    g.addColorStop(1, '#5c626b');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 3.4, 0, Math.PI * 2);
    ctx.fill();
  };
  const step = size / 8;
  for (let i = 0; i < 8; i++) {
    rivet(14 + i * step, 14);
    rivet(14 + i * step, size - 14);
    rivet(14, 14 + i * step);
    rivet(size - 14, 14 + i * step);
  }
  // Scratches.
  for (let i = 0; i < 30; i++) {
    ctx.strokeStyle = `rgba(200,208,216,${rnd() * 0.25})`;
    ctx.lineWidth = rnd() * 1.2;
    ctx.beginPath();
    const x = rnd() * size, y = rnd() * size;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 40, y + (rnd() - 0.5) * 12);
    ctx.stroke();
  }
  return c;
}

/** Asphalt road with painted lane markings handled separately. */
function genAsphalt(size, seed = 88) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const n = noiseField(size, 26, 4, seed);
  const fine = noiseField(size, 64, 2, seed + 4);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const t = n[i] * 0.6 + fine[i] * 0.4;
    const v = 54 + t * 34;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v + 1;
    img.data[i * 4 + 2] = v + 4;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const rnd = mulberry32(seed);
  // Aggregate speckle.
  for (let i = 0; i < size * 8; i++) {
    const v = 90 + rnd() * 70;
    ctx.fillStyle = `rgba(${v | 0},${v | 0},${(v + 6) | 0},${0.2 + rnd() * 0.4})`;
    ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd(), 1 + rnd());
  }
  return c;
}

/** Concrete for urban buildings. */
function genConcrete(size, seed = 99) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const n = noiseField(size, 9, 4, seed);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 158 + (n[i] - 0.5) * 40;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v - 2;
    img.data[i * 4 + 2] = v - 6;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const rnd = mulberry32(seed + 1);
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = `rgba(120,116,110,${rnd() * 0.18})`;
    ctx.fillRect(rnd() * size, rnd() * size, 10 + rnd() * 60, 6 + rnd() * 30);
  }
  return c;
}

/** Roof shingles. */
function genRoof(size, seed = 111, hex = '#8C3A2E') {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed);
  const [br, bg, bb] = hexToRgb(hex);
  ctx.fillStyle = `rgb(${(br * 0.6) | 0},${(bg * 0.6) | 0},${(bb * 0.6) | 0})`;
  ctx.fillRect(0, 0, size, size);
  const rows = 12;
  const rh = size / rows;
  const tw = size / 8;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * tw * 0.5;
    for (let i = -1; i < 9; i++) {
      const s = 0.82 + rnd() * 0.3;
      ctx.fillStyle = `rgb(${Math.min(255, br * s) | 0},${Math.min(255, bg * s) | 0},${Math.min(255, bb * s) | 0})`;
      const x = i * tw + off;
      const y = r * rh;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1, tw - 2, rh * 1.6, 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  return c;
}

/** Corrugated metal for warehouses. */
function genCorrugated(size, seed = 123) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const cols = 24;
  const cw = size / cols;
  for (let i = 0; i < cols; i++) {
    const g = ctx.createLinearGradient(i * cw, 0, (i + 1) * cw, 0);
    g.addColorStop(0, '#6f7680');
    g.addColorStop(0.45, '#b6bec8');
    g.addColorStop(0.55, '#c2cad4');
    g.addColorStop(1, '#6f7680');
    ctx.fillStyle = g;
    ctx.fillRect(i * cw, 0, cw, size);
  }
  const rnd = mulberry32(seed);
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(120,86,54,${rnd() * 0.3})`; // rust
    ctx.beginPath();
    ctx.ellipse(rnd() * size, rnd() * size, 2 + rnd() * 14, 2 + rnd() * 8, rnd() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/** Pine bark for tree trunks. */
function genBark(size, seed = 131) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const n = noiseField(size, 4, 4, seed);
  const v = noiseField(size, 40, 2, seed + 9);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const ridge = Math.abs(Math.sin(x * 0.11 + n[i] * 5)) * 0.4;
    const t = n[i] * 0.5 + v[i] * 0.2 + ridge;
    img.data[i * 4] = 62 + t * 78;
    img.data[i * 4 + 1] = 44 + t * 56;
    img.data[i * 4 + 2] = 30 + t * 36;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Water surface normal-ripple source. */
function genWater(size, seed = 141) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const n1 = noiseField(size, 8, 3, seed);
  const n2 = noiseField(size, 18, 2, seed + 5);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const t = n1[i] * 0.6 + n2[i] * 0.4;
    img.data[i * 4] = 30 + t * 40;
    img.data[i * 4 + 1] = 90 + t * 70;
    img.data[i * 4 + 2] = 150 + t * 70;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Generic tinted panel used for shop fronts, hulls and props. */
function genPanel(size, seed, hex, wear = 0.2) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const [r, g, b] = hexToRgb(hex);
  const n = noiseField(size, 10, 3, seed);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const t = (n[i] - 0.5) * 30 * wear;
    img.data[i * 4] = Math.max(0, Math.min(255, r + t));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, g + t));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, b + t));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------ */
/* Damage overlay (building crack states)                              */
/* ------------------------------------------------------------------ */

/**
 * Crack overlay used to show structure damage states. `level` 0..1.
 * Returned as an RGBA canvas with transparent background so it can be
 * composited over any building material.
 */
export function genCrackOverlay(size, level, seed = 5) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  if (level <= 0) return c;
  const rnd = mulberry32(seed);
  const branches = Math.round(4 + level * 16);
  ctx.lineCap = 'round';
  for (let i = 0; i < branches; i++) {
    let x = size * 0.5 + (rnd() - 0.5) * size * 0.8;
    let y = size * 0.5 + (rnd() - 0.5) * size * 0.8;
    const segs = 3 + Math.round(rnd() * 5);
    ctx.strokeStyle = `rgba(18,14,10,${0.35 + level * 0.5})`;
    ctx.lineWidth = 0.8 + level * 2.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    let ang = rnd() * Math.PI * 2;
    for (let s = 0; s < segs; s++) {
      ang += (rnd() - 0.5) * 1.4;
      const len = (6 + rnd() * 22) * (0.5 + level);
      x += Math.cos(ang) * len;
      y += Math.sin(ang) * len;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Punch-through holes at heavy damage.
  if (level > 0.7) {
    const holes = Math.round((level - 0.7) * 10);
    for (let i = 0; i < holes; i++) {
      ctx.fillStyle = 'rgba(10,8,6,0.85)';
      ctx.beginPath();
      ctx.ellipse(rnd() * size, rnd() * size, 4 + rnd() * 12, 4 + rnd() * 10, rnd() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const GENERATORS = {
  grass: (s) => genGrass(s, 7),
  grass_highland: (s) => genGrass(s, 19, '#7D9142', '#5E6F30', '#9BAF5E'),
  grass_forest: (s) => genGrass(s, 27, '#35661F', '#22470F', '#4E8130'),
  sand: (s) => genSand(s),
  rock: (s) => genRock(s),
  oceanfloor: (s) => genSand(s, 45),
  wood: (s) => genWoodPlanks(s),
  brick: (s) => genBrick(s),
  metal: (s) => genMetal(s),
  asphalt: (s) => genAsphalt(s),
  concrete: (s) => genConcrete(s),
  roof_red: (s) => genRoof(s, 111, '#8C3A2E'),
  roof_grey: (s) => genRoof(s, 113, '#5A5F66'),
  roof_blue: (s) => genRoof(s, 117, '#3D5A80'),
  corrugated: (s) => genCorrugated(s),
  bark: (s) => genBark(s),
  water: (s) => genWater(s),
  hedge: (s) => genGrass(s, 61, '#2C5418', '#1A3A0D', '#3F7024'),
  crop: (s) => genGrass(s, 71, '#C2A03A', '#967A22', '#DDBE5C'),
  swampwater: (s) => genPanel(s, 81, '#3A4A2E', 0.6),
  stucco_white: (s) => genPanel(s, 91, '#EDE6D8', 0.25),
  stucco_cream: (s) => genPanel(s, 93, '#E4D2A8', 0.25),
  siding_blue: (s) => genPanel(s, 95, '#7FA8C9', 0.2),
  siding_green: (s) => genPanel(s, 97, '#8FB07A', 0.2),
  siding_yellow: (s) => genPanel(s, 101, '#E0C86A', 0.2),
  barn_red: (s) => genPanel(s, 103, '#A32E22', 0.3),
  glass: (s) => genPanel(s, 105, '#8FBFD8', 0.15),
  tile_floor: (s) => genPanel(s, 107, '#CFC9BE', 0.18),
};

/**
 * Get a cached procedural texture set: { map, normalMap, roughnessMap }.
 *
 * @param {string} id     one of GENERATORS
 * @param {object} opts   { size, repeat, normalStrength, roughness, roughVariation }
 */
export function getMaterialMaps(id, opts = {}) {
  const {
    size = 512,
    repeat = 1,
    normalStrength = 2.0,
    roughness = 0.85,
    roughVariation = 0.25,
    anisotropy = 8,
  } = opts;

  const key = `${id}|${size}|${repeat}|${normalStrength}|${roughness}`;
  if (cache.has(key)) return cache.get(key);

  const gen = GENERATORS[id];
  if (!gen) throw new Error(`textures: unknown generator "${id}"`);

  const albedoCanvas = gen(size);
  const normalCanvas = normalFromCanvas(albedoCanvas, normalStrength);
  const roughCanvas = roughnessCanvas(size, roughness, roughVariation, id.length * 13 + 1);

  const maps = {
    map: toTexture(albedoCanvas, repeat, anisotropy, true),
    normalMap: toTexture(normalCanvas, repeat, anisotropy, false),
    roughnessMap: toTexture(roughCanvas, repeat, anisotropy, false),
    canvas: albedoCanvas,
  };
  cache.set(key, maps);
  return maps;
}

/**
 * Convenience: a ready-to-use MeshStandardMaterial in the cartoon-PBR style.
 */
export function makeMaterial(id, opts = {}) {
  const maps = getMaterialMaps(id, opts);
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    roughness: opts.roughness ?? 0.9,
    metalness: opts.metalness ?? 0.0,
    color: opts.color ?? 0xffffff,
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1.0,
  });
  if (opts.normalScale) {
    mat.normalScale = new THREE.Vector2(opts.normalScale, opts.normalScale);
  }
  return mat;
}

export function clearTextureCache() {
  for (const maps of cache.values()) {
    maps.map?.dispose();
    maps.normalMap?.dispose();
    maps.roughnessMap?.dispose();
  }
  cache.clear();
}

export const textureIds = Object.keys(GENERATORS);

export default { getMaterialMaps, makeMaterial, normalFromCanvas, genCrackOverlay, textureIds, clearTextureCache };
