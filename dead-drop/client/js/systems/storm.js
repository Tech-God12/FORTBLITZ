/**
 * storm.js — The storm: phase timing, damage, and a real 3D fog wall.
 *
 * The storm is a PHYSICAL OBJECT in the world (TRAP-04/05). It is rendered as
 * a 400m-tall cylinder of animated fog shell with:
 *   - inward-drifting particle bands on the wall surface
 *   - a bright glowing inner edge that catches bloom
 *   - view-dependent alpha so the wall is dense edge-on and translucent
 *     face-on, which is what makes it read as volume rather than a decal
 *
 * The cylinder is rendered from the INSIDE (BackSide) so a player standing in
 * the safe zone sees the wall surrounding them.
 */

import * as THREE from 'three';
import stormConfig from '../config/storm-phases.json' with { type: 'json' };
import audio from '../engine/audio.js';

/* ------------------------------------------------------------------ */
/* Storm wall shader                                                   */
/* ------------------------------------------------------------------ */

const StormWallShader = {
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(stormConfig.visual.wallColor) },
    uEdgeColor: { value: new THREE.Color(stormConfig.visual.innerEdgeColor) },
    uOpacity: { value: stormConfig.visual.wallOpacity },
    uInwardSpeed: { value: stormConfig.visual.particleInwardSpeed },
    uRadius: { value: 1000 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec3 vViewDir;

    void main() {
      vUv = uv;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vNormal = normalize(mat3(modelMatrix) * normal);
      vViewDir = normalize(cameraPosition - wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform vec3 uColor;
    uniform vec3 uEdgeColor;
    uniform float uOpacity;
    uniform float uInwardSpeed;
    uniform float uRadius;

    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec3 vViewDir;

    // Hash-based value noise.
    float hash(vec2 p) {
      p = fract(p * vec2(233.34, 851.73));
      p += dot(p, p + 23.45);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p *= 2.03;
        a *= 0.5;
      }
      return v;
    }

    void main() {
      // Vertical band coordinates. u wraps around the cylinder.
      float u = vUv.x;
      float h = vUv.y;

      // Three scrolling noise layers moving inward/upward at different rates.
      float t = uTime;
      float n1 = fbm(vec2(u * 26.0, h * 5.0 - t * 0.16));
      float n2 = fbm(vec2(u * 52.0 + 11.0, h * 9.0 - t * 0.31));
      float n3 = fbm(vec2(u * 13.0 - 5.0, h * 3.0 - t * 0.09));
      float density = n1 * 0.45 + n2 * 0.3 + n3 * 0.35;

      // Horizontal "sheets" of energy sweeping around the wall.
      float sheet = sin(u * 120.0 + t * 1.2 + n3 * 6.0) * 0.5 + 0.5;
      density += sheet * 0.14;

      // Fresnel: dense when looking along the surface, thinner face-on.
      // This is what gives the wall apparent volume.
      float fres = 1.0 - abs(dot(normalize(vNormal), normalize(vViewDir)));
      fres = pow(clamp(fres, 0.0, 1.0), 0.7);

      // Bright inner edge near the bottom + a glowing vertical rim.
      float edgeGlow = pow(1.0 - h, 2.2) * 0.85;
      edgeGlow += pow(density, 3.0) * 0.6;

      vec3 col = mix(uColor, uEdgeColor, clamp(edgeGlow, 0.0, 1.0));
      // Hot filaments push above 1.0 so the bloom pass picks them up.
      col += uEdgeColor * pow(density, 6.0) * 1.6;

      float alpha = uOpacity * (0.42 + density * 0.7) * (0.55 + fres * 0.75);
      // Fade the very top so the wall does not end in a hard line.
      alpha *= smoothstep(1.0, 0.72, h);
      alpha = clamp(alpha, 0.0, 0.97);

      gl_FragColor = vec4(col, alpha);

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

/* ------------------------------------------------------------------ */
/* Phase state machine                                                 */
/* ------------------------------------------------------------------ */

export const StormPhaseState = {
  WAITING: 'waiting',   // circle announced, not yet shrinking
  SHRINKING: 'shrinking',
  DONE: 'done',
};

/* ------------------------------------------------------------------ */

export class Storm {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts { rng, mapSize }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.config = stormConfig;
    this.rng = opts.rng || Math.random;

    this.mapSize = opts.mapSize ?? stormConfig.mapSize;
    this.maxRadius = stormConfig.initialRadius;

    // --- circle state ---
    this.center = new THREE.Vector2(0, 0);
    this.radius = this.maxRadius;
    this.nextCenter = new THREE.Vector2(0, 0);
    this.nextRadius = this.maxRadius;

    // --- phase state ---
    this.phaseIndex = 0;
    this.phaseState = StormPhaseState.WAITING;
    this.phaseTimer = stormConfig.phases[0].waitTime;
    this.elapsed = 0;
    this.active = true;
    this.finished = false;

    this._damageAccum = 0;
    this._lastWarned = -1;

    this.onPhaseChange = null;
    this.onShrinkStart = null;

    this._buildMesh();
    this._pickNextCircle();
  }

  /* ---------------------------------------------------------------- */
  /* Mesh                                                              */
  /* ---------------------------------------------------------------- */

  _buildMesh() {
    const v = this.config.visual;

    const geo = new THREE.CylinderGeometry(1, 1, v.wallHeight, v.segments, 12, true);
    const uniforms = THREE.UniformsUtils.clone(StormWallShader.uniforms);

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: StormWallShader.vertexShader,
      fragmentShader: StormWallShader.fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide, // visible from inside AND outside
      blending: THREE.NormalBlending,
      fog: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'StormWall';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 900;
    this.mesh.position.y = v.wallHeight * 0.5 - 60;
    this.scene.add(this.mesh);

    // A second, larger shell adds depth so the wall is not a single surface.
    this.meshOuter = new THREE.Mesh(geo, this.material.clone());
    this.meshOuter.material.uniforms.uOpacity.value = v.wallOpacity * 0.55;
    this.meshOuter.name = 'StormWallOuter';
    this.meshOuter.frustumCulled = false;
    this.meshOuter.renderOrder = 899;
    this.meshOuter.position.y = this.mesh.position.y;
    this.scene.add(this.meshOuter);
  }

  /* ---------------------------------------------------------------- */
  /* Circle placement                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Choose the next safe zone. The new circle must sit entirely inside the
   * current one, and is biased toward the island centre so the endgame does
   * not routinely land in the ocean.
   */
  _pickNextCircle() {
    const phases = this.config.phases;
    const next = phases[Math.min(this.phaseIndex + 1, phases.length - 1)];
    const targetRadius = this.maxRadius * next.radiusFactor;

    // How far the new centre may drift from the current one.
    const maxDrift = Math.max(0, this.radius - targetRadius);
    const angle = this.rng() * Math.PI * 2;
    // sqrt for uniform area distribution, then bias inward.
    const dist = Math.sqrt(this.rng()) * maxDrift;

    let nx = this.center.x + Math.cos(angle) * dist;
    let nz = this.center.y + Math.sin(angle) * dist;

    // Bias toward the island centre.
    const bias = this.config.centerBias;
    nx *= 1 - bias * 0.35;
    nz *= 1 - bias * 0.35;

    // Clamp so the circle stays within the current one.
    const dx = nx - this.center.x;
    const dz = nz - this.center.y;
    const d = Math.hypot(dx, dz);
    if (d > maxDrift && d > 0) {
      nx = this.center.x + (dx / d) * maxDrift;
      nz = this.center.y + (dz / d) * maxDrift;
    }

    this.nextCenter.set(nx, nz);
    this.nextRadius = targetRadius;
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  update(dt, listenerPos = null) {
    if (!this.active || this.finished) return;

    this.elapsed += dt;
    this.phaseTimer -= dt;

    const phases = this.config.phases;
    const phase = phases[this.phaseIndex];

    if (this.phaseState === StormPhaseState.WAITING) {
      if (this.phaseTimer <= 0) {
        // Begin shrinking toward the next circle.
        this.phaseState = StormPhaseState.SHRINKING;
        const nextPhase = phases[Math.min(this.phaseIndex + 1, phases.length - 1)];
        this.phaseTimer = nextPhase.shrinkTime;
        this._shrinkDuration = nextPhase.shrinkTime;
        this._shrinkFrom = { x: this.center.x, z: this.center.y, r: this.radius };
        this._shrinkTo = { x: this.nextCenter.x, z: this.nextCenter.y, r: this.nextRadius };
        this.onShrinkStart?.(this.phaseIndex + 1);
        audio.play('storm.warning', { volume: 0.5, bus: 'ui' });
      }
    } else if (this.phaseState === StormPhaseState.SHRINKING) {
      const total = this._shrinkDuration || 1;
      const t = 1 - Math.max(0, this.phaseTimer) / total;
      const k = THREE.MathUtils.clamp(t, 0, 1);

      this.center.x = THREE.MathUtils.lerp(this._shrinkFrom.x, this._shrinkTo.x, k);
      this.center.y = THREE.MathUtils.lerp(this._shrinkFrom.z, this._shrinkTo.z, k);
      this.radius = THREE.MathUtils.lerp(this._shrinkFrom.r, this._shrinkTo.r, k);

      if (this.phaseTimer <= 0) {
        this.phaseIndex++;
        if (this.phaseIndex >= phases.length - 1) {
          this.radius = Math.max(0, this.nextRadius);
          if (this.radius <= 1) {
            this.finished = true;
            this.phaseState = StormPhaseState.DONE;
          }
        }
        this.phaseState = StormPhaseState.WAITING;
        this.phaseTimer = phases[Math.min(this.phaseIndex, phases.length - 1)].waitTime;
        this._pickNextCircle();
        this.onPhaseChange?.(this.phaseIndex, this.currentPhase);
      }
    }

    this._updateMesh(dt);
    this._updateAudio(listenerPos);
  }

  _updateMesh(dt) {
    const r = Math.max(1, this.radius);
    this.mesh.position.x = this.center.x;
    this.mesh.position.z = this.center.y;
    this.mesh.scale.set(r, 1, r);
    this.material.uniforms.uTime.value += dt;
    this.material.uniforms.uRadius.value = r;

    this.meshOuter.position.x = this.center.x;
    this.meshOuter.position.z = this.center.y;
    const outerR = r + Math.min(45, r * 0.06);
    this.meshOuter.scale.set(outerR, 1, outerR);
    this.meshOuter.material.uniforms.uTime.value += dt * 0.72;
    this.meshOuter.material.uniforms.uRadius.value = outerR;
  }

  /* ---------------------------------------------------------------- */
  /* Audio                                                             */
  /* ---------------------------------------------------------------- */

  _updateAudio(listenerPos) {
    if (!listenerPos || !audio.ready) return;

    const dist = this.distanceToEdge(listenerPos.x, listenerPos.z);
    const inside = dist < 0;
    const absDist = Math.abs(dist);

    // Approaching rumble activates within 200m of the wall.
    const rumble = audio.getLoop('storm.rumble');
    if (absDist < this.config.warnDistance || inside) {
      const vol = inside ? 0.5 : 0.42 * (1 - absDist / this.config.warnDistance);
      if (!rumble) audio.loop('storm.rumble', { key: 'storm.rumble', volume: vol, bus: 'ambient' });
      else rumble.setVolume(vol);
    } else if (rumble) {
      rumble.stop(0.6);
    }

    // Wall howl + crackle when very close to or inside the edge.
    const wall = audio.getLoop('storm.wall');
    if (absDist < 70 || inside) {
      const vol = inside ? 0.3 : 0.45 * (1 - absDist / 70);
      if (!wall) audio.loop('storm.wall', { key: 'storm.wall', volume: vol, bus: 'ambient' });
      else wall.setVolume(vol);
    } else if (wall) {
      wall.stop(0.5);
    }

    // Full interior noise bed.
    const insideLoop = audio.getLoop('storm.inside');
    if (inside) {
      if (!insideLoop) audio.loop('storm.inside', { key: 'storm.inside', volume: 0.55, bus: 'ambient' });
    } else if (insideLoop) {
      insideLoop.stop(0.4);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  get currentPhase() {
    return this.config.phases[Math.min(this.phaseIndex, this.config.phases.length - 1)];
  }

  /** Damage per second at the current phase. */
  get damagePerSecond() {
    return this.currentPhase.damage;
  }

  /** Distance from the safe-zone edge. Negative = inside the storm. */
  distanceToEdge(x, z) {
    const d = Math.hypot(x - this.center.x, z - this.center.y);
    return this.radius - d;
  }

  isInStorm(x, z) {
    return this.distanceToEdge(x, z) < 0;
  }

  /** How deep into the storm, 0..1 over 300m, for the post-process grade. */
  stormIntensity(x, z) {
    const d = this.distanceToEdge(x, z);
    if (d >= 0) return 0;
    return THREE.MathUtils.clamp(-d / 120, 0.25, 1);
  }

  /** Seconds until the next event (shrink start or shrink end). */
  get timeToNextEvent() {
    return Math.max(0, this.phaseTimer);
  }

  get isShrinking() {
    return this.phaseState === StormPhaseState.SHRINKING;
  }

  /**
   * Nearest safe point for an entity — used by bots and the HUD arrow.
   * Returns a point comfortably inside the circle, not right on the edge.
   */
  getSafePoint(x, z, margin = 60) {
    const dx = x - this.center.x;
    const dz = z - this.center.y;
    const d = Math.hypot(dx, dz);
    const safeR = Math.max(0, this.radius - margin);
    if (d <= safeR) return { x, z };
    if (d < 1e-4) return { x: this.center.x, z: this.center.y };
    return {
      x: this.center.x + (dx / d) * safeR,
      z: this.center.y + (dz / d) * safeR,
    };
  }

  /**
   * Apply storm damage to an entity. Call once per frame with the entity's
   * position; the storm accumulates ticks internally at damageTickRate.
   * @returns {number} damage to apply this frame (0 if none)
   */
  computeDamage(x, z, dt) {
    if (!this.isInStorm(x, z)) return 0;
    return this.damagePerSecond * dt;
  }

  /* ---------------------------------------------------------------- */

  /** Rendering data for the minimap / map screen. */
  getCircles() {
    return {
      current: { x: this.center.x, z: this.center.y, r: this.radius },
      next: { x: this.nextCenter.x, z: this.nextCenter.y, r: this.nextRadius },
      shrinking: this.isShrinking,
      phase: this.phaseIndex,
      timer: this.timeToNextEvent,
    };
  }

  reset() {
    this.center.set(0, 0);
    this.radius = this.maxRadius;
    this.phaseIndex = 0;
    this.phaseState = StormPhaseState.WAITING;
    this.phaseTimer = this.config.phases[0].waitTime;
    this.elapsed = 0;
    this.finished = false;
    this._pickNextCircle();
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.scene.remove(this.meshOuter);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.meshOuter.material.dispose();
  }
}

export default Storm;
