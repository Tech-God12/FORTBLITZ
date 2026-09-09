/**
 * materials.js — Build material definitions and shared THREE materials.
 *
 * HP values and build-up times are the OG Chapter 1 numbers:
 *   wood  90 -> 200 over 3s   (fast to place, weakest)
 *   brick 100 -> 300 over 5s
 *   metal 75 -> 400 over 8s   (weakest on placement, strongest at full)
 *
 * The build-up is what makes metal a commitment: you place it *before* you
 * need it, because for the first few seconds it is the flimsiest option.
 */

import * as THREE from 'three';
import { makeMaterial, genCrackOverlay } from '../engine/textures.js';

export const BUILD_MATERIALS = {
  wood: {
    id: 'wood',
    name: 'Wood',
    initialHP: 90,
    maxHP: 200,
    buildUpTime: 3.0,
    cost: 10,
    texture: 'wood',
    color: 0xffffff,
    tint: 0xd9a961,
    hudColor: '#e0b070',
    placeSound: 'build.wood',
    breakSound: 'build.break_wood',
    harvestSound: 'harvest.wood',
    particleColor: 0xc89b5a,
    roughness: 0.88,
    metalness: 0.0,
    /** Placement speed multiplier — wood is the fastest to throw down. */
    placeSpeed: 1.0,
  },
  brick: {
    id: 'brick',
    name: 'Brick',
    initialHP: 100,
    maxHP: 300,
    buildUpTime: 5.0,
    cost: 10,
    texture: 'brick',
    color: 0xffffff,
    tint: 0xa8483a,
    hudColor: '#d98a72',
    placeSound: 'build.brick',
    breakSound: 'build.break_brick',
    harvestSound: 'harvest.stone',
    particleColor: 0xa8483a,
    roughness: 0.95,
    metalness: 0.0,
    placeSpeed: 1.0,
  },
  metal: {
    id: 'metal',
    name: 'Metal',
    initialHP: 75,
    maxHP: 400,
    buildUpTime: 8.0,
    cost: 10,
    texture: 'metal',
    color: 0xffffff,
    tint: 0x9aa3ad,
    hudColor: '#cfd6e0',
    placeSound: 'build.metal',
    breakSound: 'build.break_metal',
    harvestSound: 'harvest.metal',
    particleColor: 0x9aa3ad,
    roughness: 0.55,
    metalness: 0.72,
    placeSpeed: 1.0,
  },
};

export const MATERIAL_ORDER = ['wood', 'brick', 'metal'];
export const MAX_MATERIAL = 999;

/* ------------------------------------------------------------------ */
/* Shared THREE materials                                              */
/* ------------------------------------------------------------------ */

const _cache = {
  solid: new Map(),
  damaged: new Map(),
  ghost: new Map(),
};

/** Number of discrete damage texture states (0 = pristine). */
export const DAMAGE_STATES = 4;

/**
 * Build a canvas that composites a crack overlay onto a base material texture.
 * Discrete states keep the texture count bounded (3 materials x 4 states).
 */
function makeDamagedTexture(materialId, state) {
  const base = makeMaterial(BUILD_MATERIALS[materialId].texture, { size: 512 });
  const src = base.map.image;

  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0);

  const level = state / (DAMAGE_STATES - 1);
  if (level > 0) {
    const cracks = genCrackOverlay(src.width, level, materialId.length * 7 + state);
    ctx.drawImage(cracks, 0, 0);
    // Darken as it degrades.
    ctx.fillStyle = `rgba(20, 14, 10, ${level * 0.18})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Get the shared MeshStandardMaterial for a build material at a damage state.
 * Structures share these instances so the renderer can batch them.
 */
export function getStructureMaterial(materialId, damageState = 0) {
  const key = `${materialId}:${damageState}`;
  if (_cache.damaged.has(key)) return _cache.damaged.get(key);

  const def = BUILD_MATERIALS[materialId];
  const baseMaps = makeMaterial(def.texture, { size: 512 });

  const mat = new THREE.MeshStandardMaterial({
    map: damageState > 0 ? makeDamagedTexture(materialId, damageState) : baseMaps.map,
    normalMap: baseMaps.normalMap,
    roughnessMap: baseMaps.roughnessMap,
    roughness: def.roughness,
    metalness: def.metalness,
    color: def.color,
  });
  mat.normalScale = new THREE.Vector2(0.8, 0.8);
  mat.name = `struct_${key}`;

  _cache.damaged.set(key, mat);
  return mat;
}

/**
 * Ghost preview material. Green = valid placement, red = invalid.
 * Uses the real material colour so the player can tell wood from metal
 * before committing (TRAP-02).
 */
export function getGhostMaterial(materialId, valid) {
  const key = `${materialId}:${valid ? 'v' : 'i'}`;
  if (_cache.ghost.has(key)) return _cache.ghost.get(key);

  const def = BUILD_MATERIALS[materialId];
  const base = new THREE.Color(def.tint);
  const tint = new THREE.Color(valid ? 0x55ff77 : 0xff4444);
  // Blend the material's own colour with the validity tint so the ghost
  // communicates BOTH which material and whether it can be placed.
  const color = base.clone().lerp(tint, 0.62);

  const mat = new THREE.MeshStandardMaterial({
    color,
    transparent: true,
    opacity: 0.46,
    roughness: 0.6,
    metalness: 0.0,
    depthWrite: false,
    emissive: color.clone().multiplyScalar(0.35),
    side: THREE.DoubleSide,
  });
  mat.name = `ghost_${key}`;
  _cache.ghost.set(key, mat);
  return mat;
}

/** Damage state index (0..DAMAGE_STATES-1) from an HP fraction. */
export function damageStateFor(hpFraction) {
  if (hpFraction > 0.75) return 0;
  if (hpFraction > 0.5) return 1;
  if (hpFraction > 0.25) return 2;
  return 3;
}

export function disposeMaterialCache() {
  for (const m of _cache.damaged.values()) {
    m.map?.dispose();
    m.dispose();
  }
  for (const m of _cache.ghost.values()) m.dispose();
  _cache.damaged.clear();
  _cache.ghost.clear();
  _cache.solid.clear();
}

export default BUILD_MATERIALS;
