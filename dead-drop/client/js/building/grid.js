/**
 * grid.js — The world build grid.
 *
 * Fortnite's building is grid-locked: every piece occupies a deterministic
 * cell so two players building in the same spot produce interlocking
 * structures. A cell is 2.5m x 2.5m in plan and 3.5m tall (wall height).
 *
 * Each cell can hold one of each piece type simultaneously:
 *   - 4 walls (one per edge: north/east/south/west)
 *   - 1 floor  (at the cell's base plane)
 *   - 1 ramp   (occupying the cell volume)
 *   - 1 pyramid(occupying the cell volume)
 *
 * Keys are packed strings so lookups are O(1) in a Map. We deliberately do
 * not use a spatial tree: the flat Map is faster for the access pattern
 * (thousands of exact-cell lookups per second during a build fight).
 */

export const CELL_SIZE = 2.5;
export const WALL_HEIGHT = 3.5;

/** Wall edge indices. Direction is the outward normal of the edge. */
export const EDGE = { NORTH: 0, EAST: 1, SOUTH: 2, WEST: 3 };

/** Offsets from a cell to the neighbour across each edge. */
export const EDGE_NEIGHBOUR = [
  { gx: 0, gz: -1 }, // NORTH  (-Z)
  { gx: 1, gz: 0 },  // EAST   (+X)
  { gx: 0, gz: 1 },  // SOUTH  (+Z)
  { gx: -1, gz: 0 }, // WEST   (-X)
];

/** The same edge as seen from the neighbouring cell. */
export const OPPOSITE_EDGE = [EDGE.SOUTH, EDGE.WEST, EDGE.NORTH, EDGE.EAST];

/* ------------------------------------------------------------------ */
/* Coordinate conversion                                               */
/* ------------------------------------------------------------------ */

/** World X/Z -> grid column/row (floor division). */
export function worldToGridXZ(x, z) {
  return {
    gx: Math.floor(x / CELL_SIZE),
    gz: Math.floor(z / CELL_SIZE),
  };
}

/** World Y -> grid level. Level 0 spans y in [0, WALL_HEIGHT). */
export function worldToGridY(y) {
  return Math.floor(y / WALL_HEIGHT);
}

/** Centre of a cell in world space (at the cell's floor plane). */
export function gridToWorld(gx, gy, gz) {
  return {
    x: gx * CELL_SIZE + CELL_SIZE / 2,
    y: gy * WALL_HEIGHT,
    z: gz * CELL_SIZE + CELL_SIZE / 2,
  };
}

/** Corner (min) of a cell in world space. */
export function gridToWorldMin(gx, gy, gz) {
  return { x: gx * CELL_SIZE, y: gy * WALL_HEIGHT, z: gz * CELL_SIZE };
}

/**
 * World position of a wall's centre for a given cell + edge.
 * A wall sits ON the edge plane, half a cell out from the centre.
 */
export function wallCenter(gx, gy, gz, edge) {
  const c = gridToWorld(gx, gy, gz);
  const h = CELL_SIZE / 2;
  switch (edge) {
    case EDGE.NORTH: return { x: c.x, y: c.y + WALL_HEIGHT / 2, z: c.z - h };
    case EDGE.EAST:  return { x: c.x + h, y: c.y + WALL_HEIGHT / 2, z: c.z };
    case EDGE.SOUTH: return { x: c.x, y: c.y + WALL_HEIGHT / 2, z: c.z + h };
    case EDGE.WEST:  return { x: c.x - h, y: c.y + WALL_HEIGHT / 2, z: c.z };
    default: return { x: c.x, y: c.y + WALL_HEIGHT / 2, z: c.z };
  }
}

/** Y rotation for a wall on the given edge. */
export function wallRotation(edge) {
  switch (edge) {
    case EDGE.NORTH: return 0;
    case EDGE.EAST:  return Math.PI / 2;
    case EDGE.SOUTH: return Math.PI;
    case EDGE.WEST:  return -Math.PI / 2;
    default: return 0;
  }
}

/**
 * Which edge of a cell a yaw angle faces. Yaw is the standard Three.js
 * convention (0 = -Z / north, increasing counter-clockwise viewed from above).
 */
export function yawToEdge(yaw) {
  // Normalise to [0, 2PI).
  let a = yaw % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  // Sectors centred on each cardinal direction.
  if (a < Math.PI * 0.25 || a >= Math.PI * 1.75) return EDGE.NORTH;
  if (a < Math.PI * 0.75) return EDGE.WEST;
  if (a < Math.PI * 1.25) return EDGE.SOUTH;
  return EDGE.EAST;
}

/** Cardinal direction index (0-3) a yaw points toward, as a unit vector. */
export function edgeToVector(edge) {
  switch (edge) {
    case EDGE.NORTH: return { x: 0, z: -1 };
    case EDGE.EAST:  return { x: 1, z: 0 };
    case EDGE.SOUTH: return { x: 0, z: 1 };
    case EDGE.WEST:  return { x: -1, z: 0 };
    default: return { x: 0, z: -1 };
  }
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/** Cell key. */
export function cellKey(gx, gy, gz) {
  return `${gx},${gy},${gz}`;
}

/** Piece key: cell + type (+ edge for walls). */
export function pieceKey(gx, gy, gz, type, edge = 0) {
  return type === 'wall' ? `${gx},${gy},${gz}:w${edge}` : `${gx},${gy},${gz}:${type[0]}`;
}

export function parseCellKey(key) {
  const [gx, gy, gz] = key.split(',').map(Number);
  return { gx, gy, gz };
}

/* ------------------------------------------------------------------ */
/* Build grid                                                          */
/* ------------------------------------------------------------------ */

export class BuildGrid {
  constructor() {
    /** @type {Map<string, object>} pieceKey -> structure */
    this.pieces = new Map();
    /** @type {Map<string, Set<string>>} cellKey -> set of pieceKeys */
    this.cells = new Map();
    /** Monotonic id for structures. */
    this._nextId = 1;
  }

  /* --- queries ---------------------------------------------------- */

  get(gx, gy, gz, type, edge = 0) {
    return this.pieces.get(pieceKey(gx, gy, gz, type, edge)) || null;
  }

  has(gx, gy, gz, type, edge = 0) {
    return this.pieces.has(pieceKey(gx, gy, gz, type, edge));
  }

  getById(id) {
    for (const p of this.pieces.values()) if (p.id === id) return p;
    return null;
  }

  /** All pieces occupying a cell. */
  getCell(gx, gy, gz) {
    const keys = this.cells.get(cellKey(gx, gy, gz));
    if (!keys) return [];
    const out = [];
    for (const k of keys) {
      const p = this.pieces.get(k);
      if (p) out.push(p);
    }
    return out;
  }

  /**
   * A wall on an edge is shared between two cells: cell A's NORTH wall is
   * the same physical wall as cell B's SOUTH wall (B = A's north neighbour).
   * We canonicalise so only one entry ever exists.
   */
  canonicalWall(gx, gy, gz, edge) {
    // Canonical form: always store on the cell with the lower coordinate,
    // using NORTH (for Z edges) or WEST (for X edges).
    if (edge === EDGE.SOUTH) {
      return { gx, gy, gz: gz + 1, edge: EDGE.NORTH };
    }
    if (edge === EDGE.EAST) {
      return { gx: gx + 1, gy, gz, edge: EDGE.WEST };
    }
    return { gx, gy, gz, edge };
  }

  /* --- mutation --------------------------------------------------- */

  add(structure) {
    let { gx, gy, gz, type, edge = 0 } = structure;
    if (type === 'wall') {
      const c = this.canonicalWall(gx, gy, gz, edge);
      gx = c.gx; gy = c.gy; gz = c.gz; edge = c.edge;
      structure.gx = gx; structure.gy = gy; structure.gz = gz; structure.edge = edge;
    }
    const key = pieceKey(gx, gy, gz, type, edge);
    if (this.pieces.has(key)) return null;

    structure.id = this._nextId++;
    structure.key = key;
    this.pieces.set(key, structure);

    const ck = cellKey(gx, gy, gz);
    let set = this.cells.get(ck);
    if (!set) {
      set = new Set();
      this.cells.set(ck, set);
    }
    set.add(key);
    return structure;
  }

  remove(structure) {
    if (!structure?.key) return false;
    const ok = this.pieces.delete(structure.key);
    const ck = cellKey(structure.gx, structure.gy, structure.gz);
    const set = this.cells.get(ck);
    if (set) {
      set.delete(structure.key);
      if (set.size === 0) this.cells.delete(ck);
    }
    return ok;
  }

  clear() {
    this.pieces.clear();
    this.cells.clear();
  }

  get size() {
    return this.pieces.size;
  }

  /* --- support / structural integrity ------------------------------ */

  /**
   * Returns the list of pieces that structurally support the given piece.
   * A piece is supported if it touches the ground OR any of these exist.
   *
   * This is what drives cascade destruction: when a support is destroyed we
   * re-evaluate everything above and drop whatever is now floating.
   */
  getSupports(piece) {
    const { gx, gy, gz, type, edge } = piece;
    const out = [];
    const push = (p) => { if (p && p !== piece) out.push(p); };

    if (type === 'wall') {
      // Supported by: a wall directly below, a floor at this level in either
      // adjacent cell, a ramp below, or the ground.
      push(this.get(gx, gy - 1, gz, 'wall', edge));
      push(this.get(gx, gy, gz, 'floor'));
      const nb = EDGE_NEIGHBOUR[edge];
      push(this.get(gx + nb.gx, gy, gz + nb.gz, 'floor'));
      push(this.get(gx, gy - 1, gz, 'ramp'));
      push(this.get(gx + nb.gx, gy - 1, gz + nb.gz, 'ramp'));
      // Adjacent walls on perpendicular edges at the same level.
      for (let e = 0; e < 4; e++) {
        if (e === edge) continue;
        const c = this.canonicalWall(gx, gy, gz, e);
        push(this.get(c.gx, c.gy, c.gz, 'wall', c.edge));
      }
    } else if (type === 'floor') {
      // Supported by: any wall bounding this cell at the level below, a ramp
      // below, a pyramid below, or an adjacent floor at the same level.
      for (let e = 0; e < 4; e++) {
        const c = this.canonicalWall(gx, gy - 1, gz, e);
        push(this.get(c.gx, c.gy, c.gz, 'wall', c.edge));
      }
      push(this.get(gx, gy - 1, gz, 'ramp'));
      push(this.get(gx, gy - 1, gz, 'pyramid'));
      for (const nb of EDGE_NEIGHBOUR) {
        push(this.get(gx + nb.gx, gy, gz + nb.gz, 'floor'));
      }
    } else {
      // ramp / pyramid: supported by a floor at this level, walls at this
      // level, or anything in the cell below.
      push(this.get(gx, gy, gz, 'floor'));
      for (let e = 0; e < 4; e++) {
        const c = this.canonicalWall(gx, gy, gz, e);
        push(this.get(c.gx, c.gy, c.gz, 'wall', c.edge));
      }
      push(this.get(gx, gy - 1, gz, 'ramp'));
      push(this.get(gx, gy - 1, gz, 'pyramid'));
      for (const nb of EDGE_NEIGHBOUR) {
        push(this.get(gx + nb.gx, gy, gz + nb.gz, 'floor'));
      }
    }
    return out;
  }

  /**
   * Pieces that depend on the given piece for support (the inverse relation).
   * Used to walk upward when a structure is destroyed.
   */
  getDependents(piece) {
    const { gx, gy, gz, type, edge } = piece;
    const out = [];
    const push = (p) => { if (p && p !== piece) out.push(p); };

    if (type === 'wall') {
      push(this.get(gx, gy + 1, gz, 'wall', edge));
      // Floors resting on top of this wall.
      push(this.get(gx, gy + 1, gz, 'floor'));
      const nb = EDGE_NEIGHBOUR[edge];
      push(this.get(gx + nb.gx, gy + 1, gz + nb.gz, 'floor'));
      push(this.get(gx, gy, gz, 'ramp'));
      push(this.get(gx, gy, gz, 'pyramid'));
    } else if (type === 'floor') {
      push(this.get(gx, gy, gz, 'ramp'));
      push(this.get(gx, gy, gz, 'pyramid'));
      for (let e = 0; e < 4; e++) {
        const c = this.canonicalWall(gx, gy, gz, e);
        push(this.get(c.gx, c.gy, c.gz, 'wall', c.edge));
      }
      for (const nb of EDGE_NEIGHBOUR) {
        push(this.get(gx + nb.gx, gy, gz + nb.gz, 'floor'));
      }
    } else {
      // ramp / pyramid support the level above.
      push(this.get(gx, gy + 1, gz, 'floor'));
      for (let e = 0; e < 4; e++) {
        const c = this.canonicalWall(gx, gy + 1, gz, e);
        push(this.get(c.gx, c.gy, c.gz, 'wall', c.edge));
      }
    }
    return out;
  }

  /**
   * Iterate every piece. Provided as a generator so callers can bail early.
   */
  *all() {
    yield* this.pieces.values();
  }

  /** Pieces within a world-space radius (for explosions and proximity checks). */
  queryRadius(x, y, z, radius) {
    const out = [];
    const r2 = radius * radius;
    const cellR = Math.ceil(radius / CELL_SIZE) + 1;
    const levelR = Math.ceil(radius / WALL_HEIGHT) + 1;
    const { gx: cx, gz: cz } = worldToGridXZ(x, z);
    const cy = worldToGridY(y);

    for (let gy = cy - levelR; gy <= cy + levelR; gy++) {
      for (let gz = cz - cellR; gz <= cz + cellR; gz++) {
        for (let gx = cx - cellR; gx <= cx + cellR; gx++) {
          const keys = this.cells.get(cellKey(gx, gy, gz));
          if (!keys) continue;
          for (const k of keys) {
            const p = this.pieces.get(k);
            if (!p) continue;
            const dx = p.worldX - x;
            const dy = p.worldY - y;
            const dz = p.worldZ - z;
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(p);
          }
        }
      }
    }
    return out;
  }
}

export default BuildGrid;
