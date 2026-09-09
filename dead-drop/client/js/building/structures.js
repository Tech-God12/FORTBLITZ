/**
 * structures.js — Geometry for the four build pieces and the Structure class.
 *
 * Each piece is modelled as a set of PANELS. A wall is a 3x3 grid of panels,
 * a floor is 2x2, a ramp is 2x2 (stepped), a pyramid is 4 triangular faces.
 * Panels are what edit mode removes — deleting the centre panel of a wall
 * makes a window, deleting the bottom row makes a doorway.
 *
 * Building geometry per-panel means edits are just visibility toggles on
 * sub-meshes, which is why an edit can complete in well under 200ms.
 */

import * as THREE from 'three';
import { CELL_SIZE, WALL_HEIGHT, wallCenter, wallRotation, gridToWorld } from './grid.js';
import { BUILD_MATERIALS, getStructureMaterial, damageStateFor, DAMAGE_STATES } from './materials.js';

const THICKNESS = 0.18;

/* ------------------------------------------------------------------ */
/* Panel layouts                                                       */
/* ------------------------------------------------------------------ */

/**
 * Wall: 3 columns x 3 rows of panels, indexed row-major from the TOP LEFT
 * as seen from outside. This matches Fortnite's edit grid orientation.
 *
 *   0 1 2      top
 *   3 4 5      middle
 *   6 7 8      bottom
 *
 * Common edits:
 *   doorway = remove 6,7,8 + 3,4,5 (or just centre column 4,7)
 *   window  = remove 4
 *   arch    = remove 3,4,5,6,7,8
 */
export const WALL_PANELS = 9;
export const WALL_COLS = 3;
export const WALL_ROWS = 3;

/** Floor: 2x2 panels. */
export const FLOOR_PANELS = 4;
export const FLOOR_COLS = 2;
export const FLOOR_ROWS = 2;

/** Ramp: 2 columns x 2 steps. */
export const RAMP_PANELS = 4;

/** Pyramid: 4 triangular faces. */
export const PYRAMID_PANELS = 4;

export function panelCount(type) {
  switch (type) {
    case 'wall': return WALL_PANELS;
    case 'floor': return FLOOR_PANELS;
    case 'ramp': return RAMP_PANELS;
    case 'pyramid': return PYRAMID_PANELS;
    default: return 1;
  }
}

/* ------------------------------------------------------------------ */
/* Geometry builders (cached — built once, shared by every structure)  */
/* ------------------------------------------------------------------ */

const _geoCache = new Map();

function cached(key, build) {
  let g = _geoCache.get(key);
  if (!g) {
    g = build();
    _geoCache.set(key, g);
  }
  return g;
}

/**
 * Wall panel geometry. Panels are slightly inset from each other so the
 * seams read visually (and so removing one leaves a clean hole).
 */
function wallPanelGeometry(col, row) {
  return cached(`wallpanel_${col}_${row}`, () => {
    const pw = CELL_SIZE / WALL_COLS;
    const ph = WALL_HEIGHT / WALL_ROWS;
    const geo = new THREE.BoxGeometry(pw, ph, THICKNESS);
    // Position within the wall: centre origin, +X right, +Y up.
    const x = (col - 1) * pw;
    const y = (1 - row) * ph;
    geo.translate(x, y, 0);
    // UVs so the wood grain runs continuously across the whole wall rather
    // than restarting on every panel.
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) + col) / WALL_COLS, (uv.getY(i) + (WALL_ROWS - 1 - row)) / WALL_ROWS);
    }
    return geo;
  });
}

function floorPanelGeometry(col, row) {
  return cached(`floorpanel_${col}_${row}`, () => {
    const pw = CELL_SIZE / FLOOR_COLS;
    const pd = CELL_SIZE / FLOOR_ROWS;
    const geo = new THREE.BoxGeometry(pw, THICKNESS, pd);
    geo.translate((col - 0.5) * pw, 0, (row - 0.5) * pd);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) + col) / FLOOR_COLS, (uv.getY(i) + row) / FLOOR_ROWS);
    }
    return geo;
  });
}

/**
 * Ramp panels: two steps, each a slanted slab. Together they form a
 * continuous 45-degree incline across the cell.
 */
function rampPanelGeometry(index) {
  return cached(`ramppanel_${index}`, () => {
    const steps = 2;
    const stepLen = CELL_SIZE / steps;
    const stepRise = WALL_HEIGHT / steps;
    const slabLen = Math.hypot(stepLen, stepRise);
    const angle = Math.atan2(stepRise, stepLen);

    const geo = new THREE.BoxGeometry(CELL_SIZE, THICKNESS, slabLen);
    geo.rotateX(-angle);
    // Place along the ramp run.
    const z = -CELL_SIZE / 2 + stepLen * (index + 0.5);
    const y = stepRise * (index + 0.5);
    geo.translate(0, y, z);
    return geo;
  });
}

/** Ramp side rails, so a ramp reads as a ramp and not a floating slab. */
function rampSideGeometry(side) {
  return cached(`rampside_${side}`, () => {
    const shape = new THREE.Shape();
    shape.moveTo(-CELL_SIZE / 2, 0);
    shape.lineTo(CELL_SIZE / 2, 0);
    shape.lineTo(CELL_SIZE / 2, WALL_HEIGHT);
    shape.lineTo(-CELL_SIZE / 2, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: THICKNESS * 0.7, bevelEnabled: false });
    geo.rotateY(Math.PI / 2);
    geo.translate(side * (CELL_SIZE / 2 - THICKNESS * 0.35), 0, 0);
    return geo;
  });
}

/** Pyramid face: a triangle from a base edge up to the apex. */
function pyramidPanelGeometry(face) {
  return cached(`pyramidpanel_${face}`, () => {
    const h = CELL_SIZE / 2;
    const apexY = WALL_HEIGHT * 0.75;
    // Base corners, counter-clockwise from -X-Z.
    const corners = [
      [-h, 0, -h], [h, 0, -h], [h, 0, h], [-h, 0, h],
    ];
    const a = corners[face];
    const b = corners[(face + 1) % 4];
    const apex = [0, apexY, 0];

    // Build a thin wedge (two triangles offset along the face normal) so the
    // pyramid has thickness and does not z-fight when viewed edge-on.
    const positions = [];
    const normals = [];
    const uvs = [];

    const push = (p) => positions.push(p[0], p[1], p[2]);
    // Outer face.
    push(a); push(b); push(apex);
    // Inner face (reversed winding, slightly inset).
    const inset = (p) => [p[0] * 0.92, p[1] * 0.92, p[2] * 0.92];
    push(inset(apex)); push(inset(b)); push(inset(a));

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    // Simple planar UVs.
    for (let i = 0; i < 6; i++) uvs.push(i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 0.5, i < 3 ? 0 : 1);
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    return geo;
  });
}

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

let _structureSerial = 0;

export class Structure {
  /**
   * @param {object} opts { type, materialId, gx, gy, gz, edge, ownerId, instant }
   */
  constructor(opts) {
    this.type = opts.type;
    this.materialId = opts.materialId;
    this.gx = opts.gx;
    this.gy = opts.gy;
    this.gz = opts.gz;
    this.edge = opts.edge ?? 0;
    this.ownerId = opts.ownerId ?? null;
    this.serial = ++_structureSerial;

    const def = BUILD_MATERIALS[this.materialId];
    this.def = def;

    // HP starts low and climbs to max over buildUpTime.
    this.maxHP = def.maxHP;
    this.hp = opts.instant ? def.maxHP : def.initialHP;
    /** Cumulative damage taken, so build-up can never heal the piece. */
    this.hpLost = 0;
    this.buildProgress = opts.instant ? 1 : 0;
    this.buildUpTime = def.buildUpTime;

    /** Which panels are still present (edit mode removes them). */
    this.panels = new Array(panelCount(this.type)).fill(true);

    this.destroyed = false;
    this.damageState = 0;
    this.placedAt = performance.now() / 1000;

    // World-space centre, used by explosions and proximity queries.
    const c = this.type === 'wall'
      ? wallCenter(this.gx, this.gy, this.gz, this.edge)
      : gridToWorld(this.gx, this.gy, this.gz);
    this.worldX = c.x;
    this.worldY = this.type === 'floor' ? c.y : c.y + (this.type === 'wall' ? 0 : WALL_HEIGHT / 2);
    this.worldZ = c.z;

    this.group = null;
    this.panelMeshes = [];
  }

  /* --- rendering ---------------------------------------------------- */

  /** Build the THREE.Group for this structure. */
  createMesh() {
    const group = new THREE.Group();
    group.name = `${this.materialId}_${this.type}_${this.serial}`;
    const mat = getStructureMaterial(this.materialId, 0);

    const addPanel = (geo, index) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.structure = this;
      mesh.userData.panelIndex = index;
      group.add(mesh);
      this.panelMeshes[index] = mesh;
    };

    if (this.type === 'wall') {
      for (let row = 0; row < WALL_ROWS; row++) {
        for (let col = 0; col < WALL_COLS; col++) {
          addPanel(wallPanelGeometry(col, row), row * WALL_COLS + col);
        }
      }
      const c = wallCenter(this.gx, this.gy, this.gz, this.edge);
      group.position.set(c.x, c.y, c.z);
      group.rotation.y = wallRotation(this.edge);
    } else if (this.type === 'floor') {
      for (let row = 0; row < FLOOR_ROWS; row++) {
        for (let col = 0; col < FLOOR_COLS; col++) {
          addPanel(floorPanelGeometry(col, row), row * FLOOR_COLS + col);
        }
      }
      const c = gridToWorld(this.gx, this.gy, this.gz);
      group.position.set(c.x, c.y, c.z);
    } else if (this.type === 'ramp') {
      for (let i = 0; i < 2; i++) addPanel(rampPanelGeometry(i), i);
      // Side rails are panels 2 and 3.
      addPanel(rampSideGeometry(-1), 2);
      addPanel(rampSideGeometry(1), 3);
      const c = gridToWorld(this.gx, this.gy, this.gz);
      group.position.set(c.x, c.y, c.z);
      group.rotation.y = wallRotation(this.edge);
    } else if (this.type === 'pyramid') {
      for (let f = 0; f < 4; f++) addPanel(pyramidPanelGeometry(f), f);
      const c = gridToWorld(this.gx, this.gy, this.gz);
      group.position.set(c.x, c.y, c.z);
    }

    // Placement pop: structures scale up over ~90ms. Snappy, not floaty.
    group.scale.set(1, 0.82, 1);
    group.userData.structure = this;

    this.group = group;
    this._applyPanelVisibility();
    return group;
  }

  _applyPanelVisibility() {
    for (let i = 0; i < this.panelMeshes.length; i++) {
      const m = this.panelMeshes[i];
      if (m) m.visible = this.panels[i];
    }
  }

  /* --- simulation --------------------------------------------------- */

  /** Advance HP build-up and the placement pop animation. */
  update(dt) {
    if (this.destroyed) return;

    if (this.buildProgress < 1) {
      this.buildProgress = Math.min(1, this.buildProgress + dt / this.buildUpTime);
      const def = this.def;
      // Only raise the CEILING; damage taken during build-up is preserved.
      const target = def.initialHP + (def.maxHP - def.initialHP) * this.buildProgress;
      // A structure gains HP as it builds up, but damage already taken is
      // permanent: we track cumulative damage and subtract it from the
      // build-up ceiling. Shooting a wall mid-build must never be undone.
      this.hp = Math.max(0, target - this.hpLost);
      if (this.hp <= 0) {
        this.destroyed = true;
        this.onDestroyed?.(this);
      }
    }

    // Placement scale pop (90ms).
    if (this.group && this.group.scale.y < 1) {
      const age = performance.now() / 1000 - this.placedAt;
      const k = Math.min(1, age / 0.09);
      // Overshoot slightly then settle for a satisfying snap.
      const eased = k < 1 ? 1 - Math.pow(1 - k, 3) : 1;
      this.group.scale.y = 0.82 + 0.18 * eased;
      if (k >= 1) this.group.scale.set(1, 1, 1);
    }
  }

  /** Current HP ceiling given build-up progress. */
  get currentMaxHP() {
    const def = this.def;
    return def.initialHP + (def.maxHP - def.initialHP) * this.buildProgress;
  }

  get hpFraction() {
    return Math.max(0, Math.min(1, this.hp / this.maxHP));
  }

  /**
   * Apply damage. Returns true if this destroyed the structure.
   * Updates the visual damage state at 75/50/25% thresholds.
   */
  damage(amount) {
    if (this.destroyed) return false;
    this._damagedSincePlace = true;
    this.hpLost += amount;
    this.hp -= amount;

    const newState = damageStateFor(this.hp / this.currentMaxHP);
    if (newState !== this.damageState) {
      this.damageState = newState;
      this._refreshMaterial();
    }

    if (this.hp <= 0) {
      this.hp = 0;
      this.destroyed = true;
      return true;
    }
    return false;
  }

  _refreshMaterial() {
    // No meshes means this Structure is being used headlessly (server-side
    // simulation or tests). Skip texture work entirely — it needs a canvas.
    if (!this.panelMeshes || this.panelMeshes.length === 0) return;
    const mat = getStructureMaterial(this.materialId, Math.min(this.damageState, DAMAGE_STATES - 1));
    for (const m of this.panelMeshes) if (m) m.material = mat;
  }

  /* --- editing ------------------------------------------------------- */

  /** Toggle a panel. Returns the new state. */
  togglePanel(index) {
    if (index < 0 || index >= this.panels.length) return false;
    this.panels[index] = !this.panels[index];
    const m = this.panelMeshes[index];
    if (m) m.visible = this.panels[index];
    return this.panels[index];
  }

  /** Apply a full panel mask at once (used by edit confirm and bots). */
  setPanels(mask) {
    for (let i = 0; i < this.panels.length && i < mask.length; i++) {
      this.panels[i] = !!mask[i];
    }
    this._applyPanelVisibility();
  }

  /** Reset to a solid piece. */
  resetPanels() {
    this.panels.fill(true);
    this._applyPanelVisibility();
  }

  /** True when every panel has been removed — the piece is effectively gone. */
  get isFullyEdited() {
    return this.panels.every((p) => !p);
  }

  /** Whether a panel is open, used for collision and line-of-sight. */
  isPanelOpen(index) {
    return !this.panels[index];
  }

  /* --- collision ------------------------------------------------------ */

  /**
   * Axis-aligned bounds in world space. Used by the character controller for
   * broad-phase collision before per-panel checks.
   */
  getBounds() {
    const half = CELL_SIZE / 2;
    if (this.type === 'wall') {
      const horizontal = this.edge === 0 || this.edge === 2;
      return {
        minX: this.worldX - (horizontal ? half : THICKNESS),
        maxX: this.worldX + (horizontal ? half : THICKNESS),
        minY: this.worldY - WALL_HEIGHT / 2,
        maxY: this.worldY + WALL_HEIGHT / 2,
        minZ: this.worldZ - (horizontal ? THICKNESS : half),
        maxZ: this.worldZ + (horizontal ? THICKNESS : half),
      };
    }
    if (this.type === 'floor') {
      return {
        minX: this.worldX - half, maxX: this.worldX + half,
        minY: this.worldY - THICKNESS, maxY: this.worldY + THICKNESS,
        minZ: this.worldZ - half, maxZ: this.worldZ + half,
      };
    }
    return {
      minX: this.worldX - half, maxX: this.worldX + half,
      minY: this.worldY - WALL_HEIGHT / 2, maxY: this.worldY + WALL_HEIGHT / 2,
      minZ: this.worldZ - half, maxZ: this.worldZ + half,
    };
  }

  dispose() {
    // Geometry is shared/cached; only clear references.
    this.panelMeshes.length = 0;
    this.group = null;
  }

  /** Serialisable snapshot (used by tests and the server). */
  toJSON() {
    return {
      type: this.type, materialId: this.materialId,
      gx: this.gx, gy: this.gy, gz: this.gz, edge: this.edge,
      hp: this.hp, panels: this.panels.slice(), ownerId: this.ownerId,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Preset edit masks                                                   */
/* ------------------------------------------------------------------ */

/** Common wall edits, matching what Fortnite players actually build. */
export const WALL_EDITS = {
  solid:   [1, 1, 1, 1, 1, 1, 1, 1, 1],
  door:    [1, 1, 1, 1, 0, 1, 1, 0, 1],
  window:  [1, 1, 1, 1, 0, 1, 1, 1, 1],
  arch:    [1, 1, 1, 0, 0, 0, 0, 0, 0],
  halfLeft:[1, 0, 0, 1, 0, 0, 1, 0, 0],
  corner:  [1, 1, 0, 1, 1, 0, 0, 0, 0],
};

export const FLOOR_EDITS = {
  solid: [1, 1, 1, 1],
  half:  [1, 1, 0, 0],
  quarter: [1, 0, 0, 0],
  stairwell: [1, 0, 0, 1],
};

export const RAMP_EDITS = {
  solid: [1, 1, 1, 1],
  noRails: [1, 1, 0, 0],
  half: [1, 0, 1, 1],
};

export function disposeGeometryCache() {
  for (const g of _geoCache.values()) g.dispose();
  _geoCache.clear();
}

export default Structure;
