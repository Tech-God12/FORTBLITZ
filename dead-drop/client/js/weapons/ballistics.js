/**
 * ballistics.js — Projectile simulation, hitscan tracing and damage falloff.
 *
 * Fortnite bullets are NOT pure hitscan: they are fast projectiles with travel
 * time, which is why you must lead a moving target at range and why bots need
 * a lead factor. We simulate every bullet as a stepped ray so travel time,
 * penetration order and impact effects are all correct.
 *
 * Snipers have zero drop inside 300m (per spec) then a mild gravity term.
 */

import * as THREE from 'three';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _ray = new THREE.Ray();

/** Simulation step for projectile travel, in seconds. */
export const BULLET_STEP = 1 / 120;

/** How far a bullet flies before despawning. */
export const MAX_BULLET_RANGE = 900;

/* ------------------------------------------------------------------ */
/* Spread & recoil maths                                               */
/* ------------------------------------------------------------------ */

/**
 * Apply a cone of spread to a direction vector.
 * @param {THREE.Vector3} dir      normalised aim direction (mutated copy returned)
 * @param {number} degrees         cone half-angle in degrees
 * @param {function} rng           random source
 */
export function applySpread(dir, degrees, rng = Math.random) {
  if (degrees <= 0) return dir.clone();
  const rad = THREE.MathUtils.degToRad(degrees);

  // Build an orthonormal basis around the aim direction.
  const forward = dir.clone().normalize();
  const up = Math.abs(forward.y) > 0.95 ? _v1.set(1, 0, 0) : _v1.set(0, 1, 0);
  const right = _v2.crossVectors(forward, up).normalize();
  const realUp = new THREE.Vector3().crossVectors(right, forward).normalize();

  // Uniform disc sampling so the centre is not over-weighted.
  const angle = rng() * Math.PI * 2;
  const radius = Math.sqrt(rng()) * Math.tan(rad);

  return forward
    .clone()
    .addScaledVector(right, Math.cos(angle) * radius)
    .addScaledVector(realUp, Math.sin(angle) * radius)
    .normalize();
}

/**
 * Current spread cone for a weapon given the shooter's state.
 * Bloom accumulates per shot and decays when not firing.
 */
export function computeSpread(weapon, state) {
  const s = weapon.spread;
  if (!s) return 0;
  let spread = state.ads ? s.ads : s.hip;
  if (state.moving) spread += s.moving * (state.sprinting ? 1.5 : 1.0);
  if (state.crouching) spread += s.crouch; // negative value = tighter
  if (state.airborne) spread += (s.hip || 2) * 1.6;
  spread += state.bloom || 0;
  return Math.max(0, spread);
}

/** Advance the bloom value for one frame. */
export function updateBloom(weapon, bloom, dt, firedThisFrame) {
  const s = weapon.spread;
  if (!s) return 0;
  let b = bloom;
  if (firedThisFrame) b = Math.min(s.maxBloom, b + s.bloomPerShot);
  b = Math.max(0, b - s.decay * dt);
  return b;
}

/* ------------------------------------------------------------------ */
/* Damage falloff                                                      */
/* ------------------------------------------------------------------ */

/**
 * Distance damage multiplier. Shotguns fall off hard; rifles taper gently
 * past their effective range; snipers do not fall off at all.
 */
export function damageFalloff(weapon, distance) {
  // Shotguns declare an explicit falloff window.
  if (weapon.falloffStart !== undefined) {
    if (distance <= weapon.falloffStart) return 1;
    if (distance >= weapon.falloffEnd) return weapon.falloffMin;
    const t = (distance - weapon.falloffStart) / (weapon.falloffEnd - weapon.falloffStart);
    return 1 + (weapon.falloffMin - 1) * t;
  }

  // Snipers: flat damage at all ranges.
  if (weapon.class === 'sniper') return 1;

  // Everything else: full damage to `range`, then a gentle taper to 60%.
  const r = weapon.range || 70;
  if (distance <= r) return 1;
  const t = Math.min(1, (distance - r) / (r * 1.6));
  return 1 - 0.4 * t;
}

/** Final damage for a hit, including headshot and falloff. */
export function computeDamage(weapon, rarityDamage, distance, hitZone) {
  let dmg = rarityDamage * damageFalloff(weapon, distance);
  if (hitZone === 'head') dmg *= weapon.headshotMultiplier ?? 2.0;
  else if (hitZone === 'leg') dmg *= 0.85;
  return dmg;
}

/* ------------------------------------------------------------------ */
/* Hit resolution                                                      */
/* ------------------------------------------------------------------ */

/**
 * Capsule hitbox test used for characters. Returns the hit zone or null.
 * The capsule is split into head / body / legs bands so headshots work
 * without needing per-bone colliders.
 */
export function raycastCapsule(rayOrigin, rayDir, capsule, maxDist) {
  // capsule: { x, y, z, radius, height }  (y = feet position)
  const px = capsule.x - rayOrigin.x;
  const py = capsule.y - rayOrigin.y;
  const pz = capsule.z - rayOrigin.z;

  // Solve for the closest approach in the XZ plane extended along the ray.
  // We approximate the capsule as a vertical cylinder + spherical cap, which
  // is what Fortnite effectively uses for player hitboxes.
  const dx = rayDir.x;
  const dy = rayDir.y;
  const dz = rayDir.z;

  const a = dx * dx + dz * dz;
  if (a < 1e-8) return null;
  const b = -2 * (px * dx + pz * dz);
  const c = px * px + pz * pz - capsule.radius * capsule.radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0 || t > maxDist) return null;

  // Height at the intersection.
  const hitY = rayOrigin.y + dy * t;
  const relY = hitY - capsule.y;
  if (relY < 0 || relY > capsule.height) return null;

  // Zone bands: top 18% is the head, bottom 35% is legs.
  let zone = 'body';
  if (relY > capsule.height * 0.82) zone = 'head';
  else if (relY < capsule.height * 0.35) zone = 'leg';

  return { distance: t, zone, point: { x: rayOrigin.x + dx * t, y: hitY, z: rayOrigin.z + dz * t } };
}

/* ------------------------------------------------------------------ */
/* Projectile                                                          */
/* ------------------------------------------------------------------ */

let _bulletSerial = 0;

export class Bullet {
  constructor(opts) {
    this.id = ++_bulletSerial;
    this.origin = new THREE.Vector3().copy(opts.origin);
    this.position = new THREE.Vector3().copy(opts.origin);
    this.prevPosition = new THREE.Vector3().copy(opts.origin);
    this.direction = new THREE.Vector3().copy(opts.direction).normalize();
    this.velocity = this.direction.clone().multiplyScalar(opts.speed ?? 800);

    this.speed = opts.speed ?? 800;
    this.damage = opts.damage ?? 30;
    this.weapon = opts.weapon;
    this.shooterId = opts.shooterId;
    this.headshotMultiplier = opts.weapon?.headshotMultiplier ?? 2;
    this.structureMultiplier = opts.weapon?.structureMultiplier ?? 1;

    // Snipers have no drop within `dropAfter` metres.
    this.gravity = opts.gravity ?? (opts.weapon?.class === 'sniper' ? 0 : 3.2);
    this.dropAfter = opts.weapon?.dropAfter ?? 0;

    this.distanceTravelled = 0;
    this.maxRange = opts.maxRange ?? MAX_BULLET_RANGE;
    this.alive = true;
    this.age = 0;
  }

  /**
   * Advance the bullet. Returns the segment travelled this step so the caller
   * can perform collision queries against it.
   */
  step(dt) {
    this.prevPosition.copy(this.position);

    if (this.gravity > 0 && this.distanceTravelled > this.dropAfter) {
      this.velocity.y -= this.gravity * dt;
    }

    this.position.addScaledVector(this.velocity, dt);
    const stepDist = this.prevPosition.distanceTo(this.position);
    this.distanceTravelled += stepDist;
    this.age += dt;

    if (this.distanceTravelled >= this.maxRange) this.alive = false;

    return {
      from: this.prevPosition,
      to: this.position,
      length: stepDist,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Bullet manager                                                      */
/* ------------------------------------------------------------------ */

/**
 * Owns all in-flight bullets and resolves their collisions each frame
 * against: build structures, world colliders and character capsules.
 */
export class BallisticsSystem {
  constructor(opts = {}) {
    this.bullets = [];
    this.getTargets = opts.getTargets || (() => []);
    this.getStructures = opts.getStructures || (() => []);
    this.raycastWorld = opts.raycastWorld || null;
    this.onHitCharacter = opts.onHitCharacter || null;
    this.onHitStructure = opts.onHitStructure || null;
    this.onHitWorld = opts.onHitWorld || null;
    this.onBulletSpawn = opts.onBulletSpawn || null;
    this.maxBullets = 400;
  }

  fire(opts) {
    if (this.bullets.length >= this.maxBullets) this.bullets.shift();
    const b = new Bullet(opts);
    this.bullets.push(b);
    this.onBulletSpawn?.(b);
    return b;
  }

  update(dt) {
    // Sub-step so fast bullets cannot tunnel through thin walls.
    const steps = Math.max(1, Math.ceil(dt / BULLET_STEP));
    const sub = dt / steps;

    for (let s = 0; s < steps; s++) {
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        if (!b.alive) { this.bullets.splice(i, 1); continue; }

        const seg = b.step(sub);
        if (seg.length <= 0) continue;

        const hit = this._resolveSegment(b, seg);
        if (hit) {
          b.alive = false;
          this.bullets.splice(i, 1);
        } else if (!b.alive) {
          this.bullets.splice(i, 1);
        }
      }
    }
  }

  /**
   * Test one bullet segment against everything, nearest hit wins.
   */
  _resolveSegment(bullet, seg) {
    const dir = _v1.copy(seg.to).sub(seg.from);
    const len = dir.length();
    if (len <= 0) return false;
    dir.divideScalar(len);

    let nearest = null;
    let nearestT = len;

    /* --- characters ------------------------------------------------ */
    for (const target of this.getTargets()) {
      if (target.id === bullet.shooterId) continue;
      if (target.dead) continue;
      const r = raycastCapsule(seg.from, dir, target.capsule, nearestT);
      if (r && r.distance < nearestT) {
        nearestT = r.distance;
        nearest = { kind: 'character', target, ...r };
      }
    }

    /* --- structures ------------------------------------------------ */
    _ray.origin.copy(seg.from);
    _ray.direction.copy(dir);
    const structures = this.getStructures(seg.from, seg.to);
    for (const s of structures) {
      const t = this._rayBox(seg.from, dir, s.getBounds(), nearestT);
      if (t !== null && t < nearestT) {
        nearestT = t;
        nearest = {
          kind: 'structure', structure: s, distance: t,
          point: {
            x: seg.from.x + dir.x * t,
            y: seg.from.y + dir.y * t,
            z: seg.from.z + dir.z * t,
          },
        };
      }
    }

    /* --- world ------------------------------------------------------ */
    if (this.raycastWorld) {
      const w = this.raycastWorld(seg.from, dir, nearestT);
      if (w && w.distance < nearestT) {
        nearestT = w.distance;
        nearest = { kind: 'world', ...w };
      }
    }

    if (!nearest) return false;

    const totalDist = bullet.distanceTravelled - seg.length + nearest.distance;

    if (nearest.kind === 'character') {
      const dmg = computeDamage(bullet.weapon, bullet.damage, totalDist, nearest.zone);
      this.onHitCharacter?.({
        bullet, target: nearest.target, zone: nearest.zone,
        point: nearest.point, damage: dmg, distance: totalDist,
      });
    } else if (nearest.kind === 'structure') {
      this.onHitStructure?.({
        bullet, structure: nearest.structure, point: nearest.point,
        damage: bullet.damage * bullet.structureMultiplier, distance: totalDist,
      });
    } else {
      this.onHitWorld?.({ bullet, point: nearest.point, normal: nearest.normal, distance: totalDist });
    }
    return true;
  }

  /** Slab-method ray/AABB intersection. Returns distance or null. */
  _rayBox(origin, dir, box, maxT) {
    let tmin = 0;
    let tmax = maxT;

    for (const axis of ['x', 'y', 'z']) {
      const o = origin[axis];
      const d = dir[axis];
      const lo = box[`min${axis.toUpperCase()}`];
      const hi = box[`max${axis.toUpperCase()}`];
      if (Math.abs(d) < 1e-8) {
        if (o < lo || o > hi) return null;
      } else {
        let t1 = (lo - o) / d;
        let t2 = (hi - o) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
    }
    return tmin;
  }

  clear() {
    this.bullets.length = 0;
  }

  get count() {
    return this.bullets.length;
  }
}

export default BallisticsSystem;
