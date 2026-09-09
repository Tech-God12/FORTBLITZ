/**
 * skydive.js — Freefall and glider flight.
 *
 * Getting this feel right is most of the first 40 seconds of a match, so the
 * numbers are tuned to OG Chapter 1 behaviour:
 *
 *   FREEFALL  terminal ~118 m/s straight down; steering dives up to ~140 m/s.
 *             Pitching to horizontal trades fall speed for ground speed,
 *             which is how players "hold W" to reach far-away POIs.
 *   GLIDER    deploys automatically at 60m above ground (or manually at any
 *             time). Descends at ~28 m/s, moves ~50 m/s forward.
 *
 * Auto-deploy is a hard rule: the player can never hit the ground in freefall.
 */

import * as THREE from 'three';
import audio from '../engine/audio.js';

export const SkydiveState = {
  IN_BUS: 'in_bus',
  FREEFALL: 'freefall',
  GLIDING: 'gliding',
  LANDED: 'landed',
};

/* --- tuning ------------------------------------------------------- */

export const SKYDIVE = {
  // Freefall
  freefallTerminal: 118,
  freefallDiveMax: 140,
  freefallHorizontalMax: 62,
  freefallAccel: 62,
  freefallSteer: 46,
  freefallDrag: 1.35,

  // Glider
  gliderDescent: 28,
  gliderForward: 50,
  gliderSteer: 34,
  gliderDrag: 2.6,
  gliderDeployHeight: 60,   // auto-deploy above ground
  gliderRedeployHeight: 90, // can redeploy after leaving a ramp

  // Transitions
  deployTime: 0.35,
  landThreshold: 0.6,
};

/* ------------------------------------------------------------------ */
/* Glider model                                                        */
/* ------------------------------------------------------------------ */

function buildGlider() {
  const g = new THREE.Group();
  g.name = 'Glider';

  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x3b7ddd, roughness: 0.68, metalness: 0.02, side: THREE.DoubleSide,
  });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.7, side: THREE.DoubleSide });
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0x33353c, roughness: 0.9 });

  // Canopy: a curved lattice of cells, like the OG default glider.
  const cells = 7;
  const spanTotal = 6.0;
  const cellW = spanTotal / cells;

  for (let i = 0; i < cells; i++) {
    const t = (i + 0.5) / cells - 0.5;           // -0.5..0.5
    const arc = Math.cos(t * Math.PI * 0.82);     // curvature across the span
    const depth = 1.9 * (0.72 + 0.28 * arc);

    const cell = new THREE.Mesh(
      new THREE.BoxGeometry(cellW * 0.94, 0.34 * arc + 0.1, depth),
      i % 2 === 0 ? canopyMat : accentMat,
    );
    cell.position.set(t * spanTotal, 2.9 + arc * 0.55, 0);
    cell.rotation.z = -t * 0.55;
    cell.rotation.x = 0.06;
    cell.castShadow = true;
    g.add(cell);
  }

  // Leading-edge trim.
  const trim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.085, 0.085, spanTotal * 1.02, 8),
    accentMat,
  );
  trim.rotation.z = Math.PI / 2;
  trim.position.set(0, 3.2, -0.9);
  g.add(trim);

  // Suspension lines converging on the harness.
  for (let i = 0; i < cells; i += 1) {
    const t = (i + 0.5) / cells - 0.5;
    const top = new THREE.Vector3(t * spanTotal, 2.85, 0);
    const bottom = new THREE.Vector3(t * spanTotal * 0.18, 0.55, 0);
    const dir = new THREE.Vector3().subVectors(top, bottom);
    const len = dir.length();
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, len, 5), ropeMat);
    line.position.copy(bottom).addScaledVector(dir, 0.5);
    line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    g.add(line);
  }

  // Harness bar the player hangs from.
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.1, 8), ropeMat);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, 0.52, 0);
  g.add(bar);

  return g;
}

/* ------------------------------------------------------------------ */
/* Skydive controller                                                  */
/* ------------------------------------------------------------------ */

export class SkydiveController {
  /**
   * @param {object} opts { scene, getGroundHeight(x,z) }
   */
  constructor(opts) {
    this.scene = opts.scene;
    this.getGroundHeight = opts.getGroundHeight;

    this.state = SkydiveState.IN_BUS;
    this.velocity = new THREE.Vector3();
    this.position = new THREE.Vector3();

    this.gliderDeployed = false;
    this.deployTimer = 0;
    this.autoDeployed = false;
    this.landed = false;

    this.gliderMesh = buildGlider();
    this.gliderMesh.visible = false;
    this.scene?.add(this.gliderMesh);

    this._windLoop = null;
    this.onDeploy = null;
    this.onLand = null;

    // Distance and altitude readouts for the HUD.
    this.altitudeAboveGround = 0;
    this.horizontalSpeed = 0;
  }

  /* ---------------------------------------------------------------- */

  /** Jump out of the bus at the given world position. */
  jump(fromPosition, busDirection) {
    this.state = SkydiveState.FREEFALL;
    this.position.copy(fromPosition);
    // Inherit a little of the bus's momentum so the exit feels physical.
    this.velocity.set(
      busDirection.x * 22,
      -4,
      busDirection.z * 22,
    );
    this.gliderDeployed = false;
    this.autoDeployed = false;
    this.landed = false;

    audio.play('player.jump_bus', { volume: 0.6 });
    this._windLoop = audio.loop('player.wind_freefall', {
      key: 'skydive.wind', volume: 0.0, bus: 'ambient',
    });
  }

  /** Manually deploy the glider. */
  deployGlider(auto = false) {
    if (this.gliderDeployed) return false;
    if (this.state !== SkydiveState.FREEFALL) return false;

    this.gliderDeployed = true;
    this.autoDeployed = auto;
    this.state = SkydiveState.GLIDING;
    this.deployTimer = SKYDIVE.deployTime;
    this.gliderMesh.visible = true;

    // The canopy catches air: hard vertical brake.
    this.velocity.y *= 0.24;

    audio.play('player.glider_deploy', { volume: 0.7 });
    this.onDeploy?.(auto);
    return true;
  }

  /* ---------------------------------------------------------------- */

  /**
   * @param {number} dt
   * @param {object} input { forward, right, yaw, pitch, deploy }
   *   forward/right are -1..1; yaw/pitch are the camera angles in radians.
   */
  update(dt, input) {
    if (this.state === SkydiveState.IN_BUS || this.state === SkydiveState.LANDED) return;

    const ground = this.getGroundHeight(this.position.x, this.position.z);
    this.altitudeAboveGround = this.position.y - ground;

    // --- auto-deploy ------------------------------------------------
    if (!this.gliderDeployed && this.altitudeAboveGround <= SKYDIVE.gliderDeployHeight) {
      this.deployGlider(true);
    }

    if (this.state === SkydiveState.FREEFALL) {
      this._updateFreefall(dt, input);
    } else if (this.state === SkydiveState.GLIDING) {
      this._updateGlider(dt, input);
    }

    // --- integrate ---------------------------------------------------
    this.position.addScaledVector(this.velocity, dt);

    // --- landing -----------------------------------------------------
    const newGround = this.getGroundHeight(this.position.x, this.position.z);
    if (this.position.y <= newGround + SKYDIVE.landThreshold) {
      this.position.y = newGround;
      this._land();
    }

    // --- readouts + audio --------------------------------------------
    this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this._updateAudio();
    this._updateGliderMesh(input);
  }

  _updateFreefall(dt, input) {
    const yaw = input.yaw ?? 0;
    const pitch = input.pitch ?? 0;

    // Forward vector on the horizontal plane from the camera yaw.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);

    // Looking down converts horizontal drive into a dive.
    // pitch: -PI/2 straight down, 0 horizon.
    const diveFactor = THREE.MathUtils.clamp(-pitch / (Math.PI / 2), 0, 1);

    const wantX = (fx * (input.forward ?? 0) + rx * (input.right ?? 0));
    const wantZ = (fz * (input.forward ?? 0) + rz * (input.right ?? 0));

    // Horizontal steering weakens as you dive (you're pointed at the ground).
    const steer = SKYDIVE.freefallSteer * (1 - diveFactor * 0.65);
    this.velocity.x += wantX * steer * dt;
    this.velocity.z += wantZ * steer * dt;

    // Horizontal drag toward the max.
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const hMax = SKYDIVE.freefallHorizontalMax * (1 - diveFactor * 0.55);
    if (hSpeed > hMax && hSpeed > 0) {
      const k = hMax / hSpeed;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }
    // Passive drag so releasing the stick bleeds speed.
    this.velocity.x -= this.velocity.x * SKYDIVE.freefallDrag * dt * 0.35;
    this.velocity.z -= this.velocity.z * SKYDIVE.freefallDrag * dt * 0.35;

    // Vertical: accelerate toward the terminal velocity for the current dive.
    const targetFall = -THREE.MathUtils.lerp(
      SKYDIVE.freefallTerminal, SKYDIVE.freefallDiveMax, diveFactor,
    );
    this.velocity.y += (targetFall - this.velocity.y) * Math.min(1, SKYDIVE.freefallAccel * dt / 60);
    // Direct approach so terminal velocity is reached in a sane time.
    this.velocity.y = THREE.MathUtils.damp(this.velocity.y, targetFall, 1.1, dt);
  }

  _updateGlider(dt, input) {
    const yaw = input.yaw ?? 0;
    const pitch = input.pitch ?? 0;

    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);

    // Nose-down glides faster and sinks quicker; flaring slows both.
    const nose = THREE.MathUtils.clamp(-pitch / (Math.PI / 2), -0.5, 1);

    const wantX = fx * (input.forward ?? 0) + rx * (input.right ?? 0);
    const wantZ = fz * (input.forward ?? 0) + rz * (input.right ?? 0);

    this.velocity.x += wantX * SKYDIVE.gliderSteer * dt;
    this.velocity.z += wantZ * SKYDIVE.gliderSteer * dt;

    const hMax = SKYDIVE.gliderForward * (1 + nose * 0.35);
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (hSpeed > hMax && hSpeed > 0) {
      const k = hMax / hSpeed;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }
    this.velocity.x -= this.velocity.x * SKYDIVE.gliderDrag * dt * 0.4;
    this.velocity.z -= this.velocity.z * SKYDIVE.gliderDrag * dt * 0.4;

    const targetSink = -SKYDIVE.gliderDescent * (1 + nose * 0.5);
    this.velocity.y = THREE.MathUtils.damp(this.velocity.y, targetSink, 3.0, dt);

    if (this.deployTimer > 0) this.deployTimer -= dt;
  }

  _land() {
    if (this.landed) return;
    this.landed = true;
    this.state = SkydiveState.LANDED;
    this.velocity.set(0, 0, 0);
    this.gliderMesh.visible = false;
    this._windLoop?.stop(0.35);
    this._windLoop = null;
    audio.play('player.land_soft', { volume: 0.55 });
    this.onLand?.(this.position.clone());
  }

  _updateAudio() {
    if (!this._windLoop) return;
    // Wind volume scales with total speed — the dive roar is a big part of
    // the drop's feel.
    const speed = this.velocity.length();
    const vol = THREE.MathUtils.clamp(speed / 140, 0, 1) * 0.55;
    this._windLoop.setVolume(vol);
    this._windLoop.setRate?.(0.8 + THREE.MathUtils.clamp(speed / 140, 0, 1) * 0.5);
  }

  _updateGliderMesh(input) {
    if (!this.gliderMesh.visible) return;
    this.gliderMesh.position.copy(this.position);
    this.gliderMesh.rotation.y = input.yaw ?? 0;
    // Bank into turns based on lateral input.
    const bankTarget = -(input.right ?? 0) * 0.32;
    this.gliderMesh.rotation.z += (bankTarget - this.gliderMesh.rotation.z) * 0.12;
    // Pitch with descent rate.
    this.gliderMesh.rotation.x = THREE.MathUtils.clamp(this.velocity.y / 90, -0.4, 0.15);

    // Deploy pop: the canopy inflates over deployTime.
    if (this.deployTimer > 0) {
      const k = 1 - this.deployTimer / SKYDIVE.deployTime;
      const s = 0.35 + 0.65 * (1 - Math.pow(1 - k, 3));
      this.gliderMesh.scale.setScalar(s);
    } else {
      this.gliderMesh.scale.setScalar(1);
    }
  }

  /* ---------------------------------------------------------------- */

  /** Estimate where the player will land if they keep the current velocity. */
  predictLanding(maxTime = 40) {
    const p = this.position.clone();
    const v = this.velocity.clone();
    const step = 0.25;
    for (let t = 0; t < maxTime; t += step) {
      p.addScaledVector(v, step);
      const g = this.getGroundHeight(p.x, p.z);
      if (p.y <= g) return { x: p.x, y: g, z: p.z, time: t };
    }
    return null;
  }

  get isAirborne() {
    return this.state === SkydiveState.FREEFALL || this.state === SkydiveState.GLIDING;
  }

  reset() {
    this.state = SkydiveState.IN_BUS;
    this.velocity.set(0, 0, 0);
    this.gliderDeployed = false;
    this.landed = false;
    this.gliderMesh.visible = false;
    this._windLoop?.stop(0.1);
    this._windLoop = null;
  }

  dispose() {
    this.scene?.remove(this.gliderMesh);
    this._windLoop?.stop(0.1);
  }
}

export default SkydiveController;
