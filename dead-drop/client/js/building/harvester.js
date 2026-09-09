/**
 * harvester.js — Pickaxe harvesting with the blue weak-point system.
 *
 * Gathering rates (OG Chapter 1):
 *   trees / wooden props     +10 wood   (structures +8)
 *   rocks / boulders         +10 brick  (brick walls +8)
 *   cars / metal objects     +10 metal  (metal structures +8)
 *
 * The weak point is the skill expression: a blue circle appears on the hit
 * surface after the first swing. Hitting it grants +50% materials and the
 * circle jumps to a new position. Missing it grants the base rate.
 */

import * as THREE from 'three';
import audio from '../engine/audio.js';
import { MAX_MATERIAL } from './materials.js';

/** Pickaxe swing takes 0.6s; the damage/material event fires mid-swing. */
export const SWING_DURATION = 0.6;
export const SWING_IMPACT_TIME = 0.26;

/** Pickaxe damage. */
export const PICKAXE_PLAYER_DAMAGE = 20;
export const PICKAXE_STRUCTURE_DAMAGE = 60;
export const HARVEST_RANGE = 3.4;

/** Base material yields. */
export const YIELDS = {
  tree: { material: 'wood', amount: 10, hp: 100 },
  wood_prop: { material: 'wood', amount: 8, hp: 80 },
  rock: { material: 'brick', amount: 10, hp: 120 },
  brick_prop: { material: 'brick', amount: 8, hp: 100 },
  vehicle: { material: 'metal', amount: 10, hp: 160 },
  metal_prop: { material: 'metal', amount: 8, hp: 130 },
};

/** Bonus multiplier for striking the weak point. */
export const WEAKPOINT_BONUS = 1.5;

/* ------------------------------------------------------------------ */
/* Weak point marker                                                   */
/* ------------------------------------------------------------------ */

function makeWeakPointTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const cx = size / 2;

  // Outer glowing ring.
  const g = ctx.createRadialGradient(cx, cx, size * 0.18, cx, cx, size * 0.5);
  g.addColorStop(0, 'rgba(90,180,255,0)');
  g.addColorStop(0.62, 'rgba(90,180,255,0.15)');
  g.addColorStop(0.78, 'rgba(140,215,255,0.95)');
  g.addColorStop(0.92, 'rgba(90,180,255,0.35)');
  g.addColorStop(1, 'rgba(90,180,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // Inner target dot.
  ctx.fillStyle = 'rgba(200,240,255,0.9)';
  ctx.beginPath();
  ctx.arc(cx, cx, size * 0.075, 0, Math.PI * 2);
  ctx.fill();

  // Four tick marks.
  ctx.strokeStyle = 'rgba(190,235,255,0.95)';
  ctx.lineWidth = 4;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * size * 0.24, cx + Math.sin(a) * size * 0.24);
    ctx.lineTo(cx + Math.cos(a) * size * 0.36, cx + Math.sin(a) * size * 0.36);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Harvestable registry                                                */
/* ------------------------------------------------------------------ */

/**
 * A harvestable is any world object that yields materials. Trees, rocks and
 * vehicles register themselves here with a bounding sphere so the harvester
 * can resolve hits without a full scene raycast.
 */
export class HarvestableRegistry {
  constructor() {
    this.items = [];
    this._grid = new Map();
    this.cellSize = 24;
  }

  _key(x, z) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`;
  }

  /**
   * @param {object} o { x, y, z, radius, kind, object3D?, instanceId?, mesh? }
   */
  add(o) {
    const yieldDef = YIELDS[o.kind] || YIELDS.tree;
    const item = {
      ...o,
      hp: o.hp ?? yieldDef.hp,
      maxHp: o.hp ?? yieldDef.hp,
      kind: o.kind,
      destroyed: false,
      weakPoint: null,
      hitCount: 0,
    };
    this.items.push(item);
    const k = this._key(o.x, o.z);
    let arr = this._grid.get(k);
    if (!arr) { arr = []; this._grid.set(k, arr); }
    arr.push(item);
    return item;
  }

  /** Harvestables near a world position. */
  query(x, z, radius) {
    const out = [];
    const r = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const arr = this._grid.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (const it of arr) if (!it.destroyed) out.push(it);
      }
    }
    return out;
  }

  clear() {
    this.items.length = 0;
    this._grid.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Harvester                                                           */
/* ------------------------------------------------------------------ */

export class Harvester {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts { registry, builder, onMaterialGain, onHit }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.registry = opts.registry || new HarvestableRegistry();
    this.builder = opts.builder || null;
    this.onMaterialGain = opts.onMaterialGain || null;
    this.onHit = opts.onHit || null;

    // Swing state.
    this.swinging = false;
    this.swingTime = 0;
    this._impactFired = false;

    this._raycaster = new THREE.Raycaster();
    this._raycaster.far = HARVEST_RANGE;

    // Weak point sprite.
    this._wpTexture = makeWeakPointTexture();
    this._wpMaterial = new THREE.SpriteMaterial({
      map: this._wpTexture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      opacity: 0.95,
    });
    this.weakPointSprite = new THREE.Sprite(this._wpMaterial);
    this.weakPointSprite.scale.set(0.85, 0.85, 1);
    this.weakPointSprite.visible = false;
    this.weakPointSprite.renderOrder = 400;
    scene.add(this.weakPointSprite);

    /** The harvestable currently showing a weak point. */
    this.activeTarget = null;
    this._wpTime = 0;
  }

  /* ---------------------------------------------------------------- */

  /** Start a swing. Returns false if already swinging. */
  startSwing() {
    if (this.swinging) return false;
    this.swinging = true;
    this.swingTime = 0;
    this._impactFired = false;
    audio.play('pickaxe.swing', { volume: 0.3, rate: 0.95 + Math.random() * 0.12 });
    return true;
  }

  get swingProgress() {
    return this.swinging ? this.swingTime / SWING_DURATION : 0;
  }

  /**
   * Resolve what the swing hits.
   * Priority: player structures > harvestables > terrain.
   */
  _resolveHit(camera, origin) {
    // 1. Player-built structures.
    if (this.builder) {
      this._raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hits = this._raycaster.intersectObjects(this.builder.group.children, true);
      for (const h of hits) {
        if (h.distance > HARVEST_RANGE) break;
        const s = h.object.userData.structure || h.object.parent?.userData?.structure;
        if (s && !s.destroyed) {
          return { kind: 'structure', structure: s, point: h.point, distance: h.distance };
        }
      }
    }

    // 2. World harvestables — sphere test against the aim ray.
    this._raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const ray = this._raycaster.ray;
    const candidates = this.registry.query(origin.x, origin.z, HARVEST_RANGE + 4);
    let best = null;
    let bestT = Infinity;
    const tmp = new THREE.Vector3();

    for (const item of candidates) {
      const center = tmp.set(item.x, item.y, item.z);
      const toCenter = center.clone().sub(ray.origin);
      const t = toCenter.dot(ray.direction);
      if (t < 0 || t > HARVEST_RANGE + item.radius) continue;
      const closest = ray.direction.clone().multiplyScalar(t).add(ray.origin);
      const dist = closest.distanceTo(center);
      if (dist <= item.radius && t < bestT) {
        bestT = t;
        best = { kind: 'harvestable', item, point: closest, distance: t };
      }
    }
    if (best) return best;

    return null;
  }

  /**
   * Fire the impact of the current swing.
   * @returns {object|null} { type, material, amount, weakPoint }
   */
  _impact(camera, origin, materials) {
    const hit = this._resolveHit(camera, origin);
    if (!hit) {
      audio.play('pickaxe.swing', { volume: 0.18, rate: 1.3 });
      return null;
    }

    /* --- hitting your own build --------------------------------- */
    if (hit.kind === 'structure') {
      const s = hit.structure;
      const destroyed = this.builder.damageStructure(s, PICKAXE_STRUCTURE_DAMAGE);
      audio.play(s.def.harvestSound, {
        position: hit.point, volume: 0.55,
        rate: 0.92 + Math.random() * 0.16, refDistance: 3, maxDistance: 80,
      });
      // Deconstructing your own build refunds a small amount.
      const refund = destroyed ? 6 : 3;
      this._grantMaterial(materials, s.materialId, refund);
      this.onHit?.({ type: 'structure', point: hit.point, structure: s });
      return { type: 'structure', material: s.materialId, amount: refund, weakPoint: false };
    }

    /* --- hitting a world harvestable ----------------------------- */
    const item = hit.item;
    const def = YIELDS[item.kind] || YIELDS.tree;

    // Weak point check: is the impact point near the marker?
    let weakHit = false;
    if (item.weakPoint) {
      const d = Math.hypot(
        hit.point.x - item.weakPoint.x,
        hit.point.y - item.weakPoint.y,
        hit.point.z - item.weakPoint.z,
      );
      weakHit = d < 0.62;
    }

    const amount = Math.round(def.amount * (weakHit ? WEAKPOINT_BONUS : 1));
    this._grantMaterial(materials, def.material, amount);

    item.hp -= weakHit ? 45 : 34;
    item.hitCount++;

    // Move the weak point to a new spot on the object.
    this._placeWeakPoint(item, hit.point);
    this.activeTarget = item;

    audio.play(
      def.material === 'wood' ? 'harvest.wood' : def.material === 'brick' ? 'harvest.stone' : 'harvest.metal',
      {
        position: hit.point,
        volume: 0.6,
        rate: 0.92 + Math.random() * 0.16,
        refDistance: 3,
        rolloff: 2.2,
        maxDistance: 90,
      },
    );

    if (weakHit) {
      audio.play('harvest.weakpoint', { volume: 0.5, bus: 'ui', rate: 1.0 + Math.random() * 0.1 });
    }

    if (item.hp <= 0) {
      this._destroyHarvestable(item);
    }

    this.onHit?.({ type: 'harvestable', point: hit.point, item, weakPoint: weakHit, amount });
    return { type: 'harvestable', material: def.material, amount, weakPoint: weakHit };
  }

  _grantMaterial(materials, id, amount) {
    if (!materials) return;
    const before = materials[id] || 0;
    materials[id] = Math.min(MAX_MATERIAL, before + amount);
    const gained = materials[id] - before;
    if (gained > 0) this.onMaterialGain?.(id, gained, materials[id]);
  }

  /**
   * Place the weak point somewhere on the object's surface, biased away from
   * the last hit so the player must re-aim each swing.
   */
  _placeWeakPoint(item, lastHit) {
    const r = item.radius * 0.72;
    let x, y, z, tries = 0;
    do {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5 + Math.PI * 0.2;
      x = item.x + Math.sin(phi) * Math.cos(theta) * r;
      y = item.y + Math.cos(phi) * r * 0.9;
      z = item.z + Math.sin(phi) * Math.sin(theta) * r;
      tries++;
    } while (tries < 6 && lastHit && Math.hypot(x - lastHit.x, y - lastHit.y, z - lastHit.z) < r * 0.7);

    item.weakPoint = { x, y, z };
    this._wpTime = 0;
  }

  _destroyHarvestable(item) {
    item.destroyed = true;
    if (item.onDestroy) item.onDestroy(item);

    // Hide the instanced mesh entry by collapsing its matrix to zero scale.
    if (item.mesh && item.instanceId !== undefined) {
      const m = new THREE.Matrix4().makeScale(0, 0, 0);
      item.mesh.setMatrixAt(item.instanceId, m);
      item.mesh.instanceMatrix.needsUpdate = true;
    } else if (item.object3D) {
      item.object3D.visible = false;
    }

    if (this.activeTarget === item) {
      this.activeTarget = null;
      this.weakPointSprite.visible = false;
    }
  }

  /* ---------------------------------------------------------------- */

  /**
   * Frame update.
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {THREE.Vector3} origin  player eye position
   * @param {object} materials      the player's material counts (mutated)
   */
  update(dt, camera, origin, materials) {
    let result = null;

    if (this.swinging) {
      this.swingTime += dt;
      if (!this._impactFired && this.swingTime >= SWING_IMPACT_TIME) {
        this._impactFired = true;
        result = this._impact(camera, origin, materials);
      }
      if (this.swingTime >= SWING_DURATION) {
        this.swinging = false;
        this.swingTime = 0;
      }
    }

    /* --- weak point marker --------------------------------------- */
    // Show the marker on whatever the player is currently aiming at, so the
    // circle appears before the second swing (as in Fortnite).
    const aim = this._resolveHit(camera, origin);
    const aimedItem = aim?.kind === 'harvestable' ? aim.item : null;

    if (aimedItem) {
      if (!aimedItem.weakPoint) this._placeWeakPoint(aimedItem, aim.point);
      this.activeTarget = aimedItem;
      const wp = aimedItem.weakPoint;
      this.weakPointSprite.position.set(wp.x, wp.y, wp.z);
      this.weakPointSprite.visible = true;
      this._wpTime += dt;
      // Gentle pulse so it reads as interactive.
      const pulse = 0.8 + 0.14 * Math.sin(this._wpTime * 5.0);
      this.weakPointSprite.scale.set(pulse, pulse, 1);
      this._wpMaterial.opacity = 0.75 + 0.22 * Math.sin(this._wpTime * 4.0);
    } else {
      this.weakPointSprite.visible = false;
      this.activeTarget = null;
    }

    return result;
  }

  /** Swing offset for the viewmodel animation (0..1 arc). */
  getSwingPose() {
    if (!this.swinging) return { angle: 0, progress: 0 };
    const p = this.swingTime / SWING_DURATION;
    // Wind up quickly, strike, then recover.
    let angle;
    if (p < 0.32) angle = -(p / 0.32) * 1.5;           // raise overhead
    else if (p < 0.5) angle = -1.5 + ((p - 0.32) / 0.18) * 2.6; // strike down
    else angle = 1.1 * (1 - (p - 0.5) / 0.5);          // recover
    return { angle, progress: p };
  }

  dispose() {
    this.scene.remove(this.weakPointSprite);
    this._wpMaterial.dispose();
    this._wpTexture.dispose();
  }
}

export default Harvester;
