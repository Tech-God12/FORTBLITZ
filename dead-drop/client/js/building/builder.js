/**
 * builder.js — Placement, validation, ghost preview and cascade destruction.
 *
 * THE LATENCY RULE
 * ----------------
 * Placement runs in the same frame the input is read. There is no queue, no
 * "next tick" deferral, no animation gate. place() does:
 *    validate -> deduct materials -> create Structure -> add mesh to scene
 * synchronously. The mesh exists before the frame's render call.
 *
 * Fire rate is limited by a cooldown (0.15s, matching Fortnite's build speed)
 * but the FIRST piece of any build sequence is always immediate.
 */

import * as THREE from 'three';
import BuildGrid, {
  CELL_SIZE, WALL_HEIGHT, EDGE, EDGE_NEIGHBOUR,
  worldToGridXZ, worldToGridY, gridToWorld, wallCenter, wallRotation, yawToEdge,
} from './grid.js';
import Structure, {
  WALL_ROWS, WALL_COLS, FLOOR_COLS, FLOOR_ROWS,
} from './structures.js';
import { BUILD_MATERIALS, MATERIAL_ORDER, MAX_MATERIAL, getGhostMaterial } from './materials.js';
import { getWalkHeight } from '../world/heightfield.js';
import audio from '../engine/audio.js';

/** Minimum time between placements. Fortnite is ~0.15s per piece. */
export const PLACE_COOLDOWN = 0.15;

/** How far ahead of the player pieces are placed. */
export const BUILD_REACH = 8.0;

/* ------------------------------------------------------------------ */

export class Builder {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts { grid, onPlace, onDestroy }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.grid = opts.grid || new BuildGrid();

    this.group = new THREE.Group();
    this.group.name = 'Structures';
    scene.add(this.group);

    /** Active structures with meshes in the scene. */
    this.structures = new Set();

    // --- build state ---
    this.buildMode = false;
    this.selectedType = 'wall';
    this.selectedMaterial = 'wood';
    this.cooldown = 0;

    // --- ghost preview ---
    this.ghost = null;
    this.ghostValid = false;
    this.ghostTarget = null;
    this._ghostMeshes = new Map();

    this.onPlace = opts.onPlace || null;
    this.onDestroy = opts.onDestroy || null;
    this.onMaterialChange = opts.onMaterialChange || null;

    this._debris = [];
    this._buildGhost();
  }

  /* ---------------------------------------------------------------- */
  /* Ghost preview                                                     */
  /* ---------------------------------------------------------------- */

  _buildGhost() {
    this.ghostGroup = new THREE.Group();
    this.ghostGroup.name = 'BuildGhost';
    this.ghostGroup.visible = false;
    this.ghostGroup.renderOrder = 500;
    this.scene.add(this.ghostGroup);
  }

  /** Rebuild the ghost mesh when the piece type or material changes. */
  _refreshGhostMesh() {
    const key = `${this.selectedType}:${this.selectedMaterial}`;
    if (this._ghostKey === key) return;
    this._ghostKey = key;

    // Clear previous.
    while (this.ghostGroup.children.length) {
      this.ghostGroup.remove(this.ghostGroup.children[0]);
    }

    // Build a throwaway structure purely to get correct geometry.
    const proto = new Structure({
      type: this.selectedType,
      materialId: this.selectedMaterial,
      gx: 0, gy: 0, gz: 0, edge: 0, instant: true,
    });
    const mesh = proto.createMesh();
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);

    // Swap to ghost materials and disable shadows.
    mesh.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        o.material = getGhostMaterial(this.selectedMaterial, true);
      }
    });
    this._ghostInner = mesh;
    this.ghostGroup.add(mesh);
  }

  _setGhostValidity(valid) {
    if (this._ghostValidCached === valid) return;
    this._ghostValidCached = valid;
    const mat = getGhostMaterial(this.selectedMaterial, valid);
    this._ghostInner?.traverse((o) => {
      if (o.isMesh) o.material = mat;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Target resolution                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Work out which grid cell/edge the player is aiming at.
   * Fortnite places relative to the player's FEET and facing direction, not
   * a raycast — that is what makes turbo-building feel predictable.
   */
  resolveTarget(playerPos, yaw, pitch = 0) {
    const type = this.selectedType;

    if (type === 'wall') {
      // Wall goes on the edge of the cell the player faces, one cell ahead.
      const dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const ahead = {
        x: playerPos.x + dir.x * (CELL_SIZE * 0.65),
        z: playerPos.z + dir.z * (CELL_SIZE * 0.65),
      };
      const { gx, gz } = worldToGridXZ(ahead.x, ahead.z);
      const gy = worldToGridY(playerPos.y + 0.15);
      const edge = yawToEdge(yaw);
      return { gx, gy, gz, edge, type };
    }

    if (type === 'floor') {
      // Floor goes in the cell ahead at the player's foot level.
      const dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const ahead = {
        x: playerPos.x + dir.x * CELL_SIZE,
        z: playerPos.z + dir.z * CELL_SIZE,
      };
      const { gx, gz } = worldToGridXZ(ahead.x, ahead.z);
      const gy = worldToGridY(playerPos.y + 0.15);
      return { gx, gy, gz, edge: 0, type };
    }

    if (type === 'ramp') {
      // Ramp goes in the cell ahead, rising away from the player.
      const dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const ahead = {
        x: playerPos.x + dir.x * (CELL_SIZE * 0.85),
        z: playerPos.z + dir.z * (CELL_SIZE * 0.85),
      };
      const { gx, gz } = worldToGridXZ(ahead.x, ahead.z);
      const gy = worldToGridY(playerPos.y + 0.15);
      const edge = yawToEdge(yaw);
      return { gx, gy, gz, edge, type };
    }

    // Pyramid: in the player's own cell, one level up when looking up.
    const { gx, gz } = worldToGridXZ(playerPos.x, playerPos.z);
    const gy = worldToGridY(playerPos.y + 0.15) + (pitch > 0.35 ? 1 : 0);
    return { gx, gy, gz, edge: 0, type };
  }

  /* ---------------------------------------------------------------- */
  /* Validation                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Can a piece be placed here? Checks occupancy, support and terrain.
   * Returns { valid, reason }.
   */
  validate(target, playerMats = null) {
    const { gx, gy, gz, type, edge } = target;

    // Material cost.
    if (playerMats) {
      const cost = BUILD_MATERIALS[this.selectedMaterial].cost;
      if ((playerMats[this.selectedMaterial] || 0) < cost) {
        return { valid: false, reason: 'materials' };
      }
    }

    // Occupancy.
    if (type === 'wall') {
      const c = this.grid.canonicalWall(gx, gy, gz, edge);
      if (this.grid.has(c.gx, c.gy, c.gz, 'wall', c.edge)) {
        return { valid: false, reason: 'occupied' };
      }
    } else if (this.grid.has(gx, gy, gz, type)) {
      return { valid: false, reason: 'occupied' };
    }

    // Below the world.
    if (gy < -2) return { valid: false, reason: 'underground' };

    // Support: either it touches the ground, or an existing piece holds it up.
    if (!this._hasSupport(target)) {
      return { valid: false, reason: 'unsupported' };
    }

    return { valid: true, reason: null };
  }

  /**
   * A piece is supported if it rests on terrain or connects to the structure
   * network. This is what prevents mid-air building (a core BR rule).
   */
  _hasSupport(target) {
    const { gx, gy, gz, type, edge } = target;

    // --- terrain support ---
    const c = gridToWorld(gx, gy, gz);
    const baseY = gy * WALL_HEIGHT;

    // Sample terrain across the cell footprint; if the ground reaches the
    // piece's base (within a tolerance) it is grounded.
    const half = CELL_SIZE / 2 - 0.05;
    const samples = [
      [c.x, c.z], [c.x - half, c.z - half], [c.x + half, c.z - half],
      [c.x - half, c.z + half], [c.x + half, c.z + half],
    ];
    for (const [sx, sz] of samples) {
      const g = getWalkHeight(sx, sz);
      // Piece base is within reach of the ground (allow a step up/down).
      if (g >= baseY - 1.6 && g <= baseY + WALL_HEIGHT * 0.85) return true;
    }

    // --- structural support ---
    const probe = new Structure({ type, materialId: this.selectedMaterial, gx, gy, gz, edge, instant: true });
    if (type === 'wall') {
      const cw = this.grid.canonicalWall(gx, gy, gz, edge);
      probe.gx = cw.gx; probe.gy = cw.gy; probe.gz = cw.gz; probe.edge = cw.edge;
    }
    const supports = this.grid.getSupports(probe);
    return supports.length > 0;
  }

  /* ---------------------------------------------------------------- */
  /* Placement                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Place the currently selected piece. Synchronous and immediate.
   * @returns {Structure|null}
   */
  place(target, playerMats, ownerId = 'player') {
    const check = this.validate(target, playerMats);
    if (!check.valid) {
      if (check.reason !== 'occupied') audio.play('build.invalid', { volume: 0.25, bus: 'ui' });
      return null;
    }

    const def = BUILD_MATERIALS[this.selectedMaterial];
    if (playerMats) playerMats[this.selectedMaterial] -= def.cost;

    const structure = new Structure({
      type: target.type,
      materialId: this.selectedMaterial,
      gx: target.gx, gy: target.gy, gz: target.gz,
      edge: target.edge,
      ownerId,
    });

    const added = this.grid.add(structure);
    if (!added) return null;

    // Mesh is created and parented THIS FRAME.
    const mesh = structure.createMesh();
    this.group.add(mesh);
    this.structures.add(structure);

    audio.play(def.placeSound, {
      position: { x: structure.worldX, y: structure.worldY, z: structure.worldZ },
      volume: 0.7,
      rate: 0.95 + Math.random() * 0.1,
      refDistance: 4,
      rolloff: 2.0,
      maxDistance: 160,
    });

    this.cooldown = PLACE_COOLDOWN;
    this.onPlace?.(structure);
    return structure;
  }

  /**
   * Attempt a placement from raw player state. This is the entry point the
   * player controller calls every frame while the build key is held.
   */
  tryPlace(playerPos, yaw, pitch, playerMats, ownerId = 'player', force = false) {
    if (!force && this.cooldown > 0) return null;
    const target = this.resolveTarget(playerPos, yaw, pitch);
    return this.place(target, playerMats, ownerId);
  }

  /* ---------------------------------------------------------------- */
  /* Destruction                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Damage a structure. Handles destruction + cascade.
   * @returns {boolean} true if destroyed
   */
  damageStructure(structure, amount, source = null) {
    if (!structure || structure.destroyed) return false;
    const destroyed = structure.damage(amount);
    if (destroyed) {
      this.destroyStructure(structure, source);
      return true;
    }
    return false;
  }

  /**
   * Remove a structure and cascade to anything it was holding up.
   * The cascade is breadth-first with a visited set so a large tower
   * collapses in one pass without recursion blowups.
   */
  destroyStructure(structure, source = null, cascade = true) {
    if (!structure || !this.structures.has(structure)) return;

    this._removeOne(structure);

    if (!cascade) return;

    // Walk upward from the destroyed piece looking for orphans.
    const queue = this.grid.getDependents(structure);
    const visited = new Set();
    let guard = 0;

    while (queue.length && guard++ < 4000) {
      const p = queue.shift();
      if (!p || visited.has(p) || p.destroyed) continue;
      visited.add(p);

      // Still supported? Then it and everything above it survive.
      const supports = this.grid.getSupports(p).filter((s) => !s.destroyed);
      if (supports.length > 0) continue;
      // Grounded pieces never fall.
      if (this._hasTerrainSupport(p)) continue;

      const deps = this.grid.getDependents(p);
      this._removeOne(p, true);
      for (const d of deps) if (!visited.has(d)) queue.push(d);
    }
  }

  _hasTerrainSupport(piece) {
    const baseY = piece.gy * WALL_HEIGHT;
    const c = gridToWorld(piece.gx, piece.gy, piece.gz);
    const half = CELL_SIZE / 2 - 0.05;
    const samples = [
      [c.x, c.z], [c.x - half, c.z - half], [c.x + half, c.z - half],
      [c.x - half, c.z + half], [c.x + half, c.z + half],
    ];
    for (const [sx, sz] of samples) {
      const g = getWalkHeight(sx, sz);
      if (g >= baseY - 1.6 && g <= baseY + WALL_HEIGHT * 0.85) return true;
    }
    return false;
  }

  _removeOne(structure, isCascade = false) {
    structure.destroyed = true;
    if (structure.group) this.group.remove(structure.group);
    this.grid.remove(structure);
    this.structures.delete(structure);

    const pos = { x: structure.worldX, y: structure.worldY, z: structure.worldZ };
    audio.play(structure.def.breakSound, {
      position: pos,
      volume: isCascade ? 0.42 : 0.72,
      rate: 0.9 + Math.random() * 0.2,
      refDistance: 5,
      rolloff: 1.9,
      maxDistance: 220,
    });

    this._spawnDebris(structure);
    structure.dispose();
    this.onDestroy?.(structure, isCascade);
  }

  /** Material particle burst when a structure breaks. */
  _spawnDebris(structure) {
    const count = 14;
    const geo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
    const mat = new THREE.MeshStandardMaterial({
      color: structure.def.particleColor,
      roughness: 0.9,
      metalness: structure.materialId === 'metal' ? 0.6 : 0.0,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.castShadow = false;

    const parts = [];
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const p = {
        x: structure.worldX + (Math.random() - 0.5) * CELL_SIZE,
        y: structure.worldY + (Math.random() - 0.5) * WALL_HEIGHT * 0.7,
        z: structure.worldZ + (Math.random() - 0.5) * CELL_SIZE,
        vx: (Math.random() - 0.5) * 5.5,
        vy: Math.random() * 4.5 + 1.5,
        vz: (Math.random() - 0.5) * 5.5,
        rx: Math.random() * 8, ry: Math.random() * 8, rz: Math.random() * 8,
        scale: 0.6 + Math.random() * 0.9,
      };
      parts.push(p);
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    this._debris.push({ mesh, parts, life: 1.4, dummy });
  }

  _updateDebris(dt) {
    for (let i = this._debris.length - 1; i >= 0; i--) {
      const d = this._debris[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        d.mesh.geometry.dispose();
        d.mesh.material.dispose();
        this._debris.splice(i, 1);
        continue;
      }
      for (let p = 0; p < d.parts.length; p++) {
        const part = d.parts[p];
        part.vy -= 22 * dt;
        part.x += part.vx * dt;
        part.y += part.vy * dt;
        part.z += part.vz * dt;
        const ground = getWalkHeight(part.x, part.z);
        if (part.y < ground + 0.1) {
          part.y = ground + 0.1;
          part.vy *= -0.28;
          part.vx *= 0.6;
          part.vz *= 0.6;
        }
        d.dummy.position.set(part.x, part.y, part.z);
        d.dummy.rotation.set(part.rx * d.life, part.ry * d.life, part.rz * d.life);
        d.dummy.scale.setScalar(part.scale * Math.min(1, d.life * 1.6));
        d.dummy.updateMatrix();
        d.mesh.setMatrixAt(p, d.dummy.matrix);
      }
      d.mesh.instanceMatrix.needsUpdate = true;
      d.mesh.material.opacity = Math.min(1, d.life);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Selection                                                         */
  /* ---------------------------------------------------------------- */

  setBuildMode(on) {
    this.buildMode = on;
    this.ghostGroup.visible = on;
    if (!on) this.ghostTarget = null;
  }

  toggleBuildMode() {
    this.setBuildMode(!this.buildMode);
    return this.buildMode;
  }

  selectType(type) {
    if (!['wall', 'floor', 'ramp', 'pyramid'].includes(type)) return;
    this.selectedType = type;
    if (!this.buildMode) this.setBuildMode(true);
    audio.play('build.rotate', { volume: 0.3, bus: 'ui' });
  }

  selectMaterial(id) {
    if (!BUILD_MATERIALS[id]) return;
    this.selectedMaterial = id;
    this._ghostKey = null; // force ghost rebuild
    this.onMaterialChange?.(id);
    audio.play('ui.slot', { volume: 0.3, bus: 'ui' });
  }

  cycleMaterial(dir = 1) {
    const i = MATERIAL_ORDER.indexOf(this.selectedMaterial);
    const n = (i + dir + MATERIAL_ORDER.length) % MATERIAL_ORDER.length;
    this.selectMaterial(MATERIAL_ORDER[n]);
  }

  /* ---------------------------------------------------------------- */
  /* Frame update                                                      */
  /* ---------------------------------------------------------------- */

  update(dt, playerPos, yaw, pitch, playerMats) {
    if (this.cooldown > 0) this.cooldown -= dt;

    // Structures build up HP and finish their placement pop.
    for (const s of this.structures) s.update(dt);
    this._updateDebris(dt);

    if (!this.buildMode) {
      this.ghostGroup.visible = false;
      return;
    }

    this._refreshGhostMesh();

    const target = this.resolveTarget(playerPos, yaw, pitch);
    this.ghostTarget = target;
    const check = this.validate(target, playerMats);
    this.ghostValid = check.valid;
    this._setGhostValidity(check.valid);

    // Position the ghost exactly where the piece would land.
    if (target.type === 'wall') {
      const c = wallCenter(target.gx, target.gy, target.gz, target.edge);
      this.ghostGroup.position.set(c.x, c.y, c.z);
      this.ghostGroup.rotation.y = wallRotation(target.edge);
    } else {
      const c = gridToWorld(target.gx, target.gy, target.gz);
      this.ghostGroup.position.set(c.x, c.y, c.z);
      this.ghostGroup.rotation.y = target.type === 'ramp' ? wallRotation(target.edge) : 0;
    }
    this.ghostGroup.visible = true;
  }

  /* ---------------------------------------------------------------- */

  /** All structure meshes, for raycasting. */
  getColliders() {
    return this.group.children;
  }

  /** Structures near a point, for player collision. */
  queryRadius(x, y, z, r) {
    return this.grid.queryRadius(x, y, z, r);
  }

  clear() {
    for (const s of [...this.structures]) {
      if (s.group) this.group.remove(s.group);
      s.dispose();
    }
    this.structures.clear();
    this.grid.clear();
    for (const d of this._debris) {
      this.scene.remove(d.mesh);
      d.mesh.geometry.dispose();
      d.mesh.material.dispose();
    }
    this._debris.length = 0;
  }

  get structureCount() {
    return this.structures.size;
  }
}

export default Builder;
