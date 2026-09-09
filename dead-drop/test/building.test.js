/**
 * building.test.js — Grid math, support rules, cascade destruction, HP curves.
 *
 * These tests exercise the pure logic layer (grid.js, materials.js) plus a
 * headless subset of Structure that does not need WebGL.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import BuildGrid, {
  CELL_SIZE, WALL_HEIGHT, EDGE,
  worldToGridXZ, worldToGridY, gridToWorld, wallCenter, wallRotation,
  yawToEdge, cellKey, pieceKey,
} from '../client/js/building/grid.js';
import { BUILD_MATERIALS, damageStateFor, MAX_MATERIAL } from '../client/js/building/materials.js';
import { WALL_EDITS, panelCount } from '../client/js/building/structures.js';

/* ------------------------------------------------------------------ */
/* Lightweight stand-in for Structure (no THREE / no canvas)           */
/* ------------------------------------------------------------------ */

function makePiece(type, gx, gy, gz, edge = 0, materialId = 'wood') {
  const def = BUILD_MATERIALS[materialId];
  return {
    type, gx, gy, gz, edge, materialId, def,
    hp: def.initialHP, maxHP: def.maxHP,
    buildProgress: 0, destroyed: false,
    worldX: 0, worldY: 0, worldZ: 0,
  };
}

/* ------------------------------------------------------------------ */

describe('grid coordinate math', () => {
  it('uses a 2.5m cell and 3.5m wall height', () => {
    expect(CELL_SIZE).toBe(2.5);
    expect(WALL_HEIGHT).toBe(3.5);
  });

  it('maps world positions to cells with floor division', () => {
    expect(worldToGridXZ(0, 0)).toEqual({ gx: 0, gz: 0 });
    expect(worldToGridXZ(2.49, 2.49)).toEqual({ gx: 0, gz: 0 });
    expect(worldToGridXZ(2.5, 2.5)).toEqual({ gx: 1, gz: 1 });
    expect(worldToGridXZ(-0.01, -0.01)).toEqual({ gx: -1, gz: -1 });
    expect(worldToGridXZ(-2.5, -2.5)).toEqual({ gx: -1, gz: -1 });
    expect(worldToGridXZ(-2.51, -2.51)).toEqual({ gx: -2, gz: -2 });
  });

  it('maps height to levels', () => {
    expect(worldToGridY(0)).toBe(0);
    expect(worldToGridY(3.49)).toBe(0);
    expect(worldToGridY(3.5)).toBe(1);
    expect(worldToGridY(-0.1)).toBe(-1);
  });

  it('round-trips cell centre back to the same cell', () => {
    for (let gx = -5; gx <= 5; gx++) {
      for (let gz = -5; gz <= 5; gz++) {
        const w = gridToWorld(gx, 0, gz);
        expect(worldToGridXZ(w.x, w.z)).toEqual({ gx, gz });
      }
    }
  });

  it('places wall centres on the cell edge, half a cell from centre', () => {
    const c = gridToWorld(0, 0, 0);
    const n = wallCenter(0, 0, 0, EDGE.NORTH);
    expect(n.x).toBeCloseTo(c.x);
    expect(n.z).toBeCloseTo(c.z - CELL_SIZE / 2);
    expect(n.y).toBeCloseTo(WALL_HEIGHT / 2);

    const e = wallCenter(0, 0, 0, EDGE.EAST);
    expect(e.x).toBeCloseTo(c.x + CELL_SIZE / 2);
    expect(e.z).toBeCloseTo(c.z);
  });

  it('rotates walls to face their edge', () => {
    expect(wallRotation(EDGE.NORTH)).toBeCloseTo(0);
    expect(wallRotation(EDGE.EAST)).toBeCloseTo(Math.PI / 2);
    expect(wallRotation(EDGE.SOUTH)).toBeCloseTo(Math.PI);
    expect(wallRotation(EDGE.WEST)).toBeCloseTo(-Math.PI / 2);
  });

  it('converts yaw to the correct facing edge', () => {
    expect(yawToEdge(0)).toBe(EDGE.NORTH);
    expect(yawToEdge(Math.PI / 2)).toBe(EDGE.WEST);
    expect(yawToEdge(Math.PI)).toBe(EDGE.SOUTH);
    expect(yawToEdge(-Math.PI / 2)).toBe(EDGE.EAST);
    // Wrapping.
    expect(yawToEdge(Math.PI * 2)).toBe(EDGE.NORTH);
    expect(yawToEdge(-Math.PI * 2)).toBe(EDGE.NORTH);
    expect(yawToEdge(Math.PI * 4 + 0.1)).toBe(EDGE.NORTH);
  });

  it('generates distinct keys per piece type and edge', () => {
    expect(pieceKey(1, 2, 3, 'wall', 0)).not.toBe(pieceKey(1, 2, 3, 'wall', 1));
    expect(pieceKey(1, 2, 3, 'floor')).not.toBe(pieceKey(1, 2, 3, 'ramp'));
    expect(cellKey(1, 2, 3)).toBe('1,2,3');
  });
});

/* ------------------------------------------------------------------ */

describe('wall sharing between cells', () => {
  let grid;
  beforeEach(() => { grid = new BuildGrid(); });

  it('canonicalises a shared wall to one entry', () => {
    // Cell (0,0,0) NORTH is the same wall as cell (0,0,-1) SOUTH.
    const a = grid.canonicalWall(0, 0, 0, EDGE.NORTH);
    const b = grid.canonicalWall(0, 0, -1, EDGE.SOUTH);
    expect(a).toEqual(b);
  });

  it('canonicalises east/west sharing', () => {
    const a = grid.canonicalWall(0, 0, 0, EDGE.EAST);
    const b = grid.canonicalWall(1, 0, 0, EDGE.WEST);
    expect(a).toEqual(b);
  });

  it('refuses to place two walls in the same physical slot', () => {
    const w1 = grid.add(makePiece('wall', 0, 0, 0, EDGE.NORTH));
    expect(w1).not.toBeNull();
    // Same wall approached from the neighbouring cell.
    const w2 = grid.add(makePiece('wall', 0, 0, -1, EDGE.SOUTH));
    expect(w2).toBeNull();
    expect(grid.size).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe('grid storage', () => {
  let grid;
  beforeEach(() => { grid = new BuildGrid(); });

  it('stores and retrieves pieces', () => {
    const f = grid.add(makePiece('floor', 3, 1, 4));
    expect(grid.has(3, 1, 4, 'floor')).toBe(true);
    expect(grid.get(3, 1, 4, 'floor')).toBe(f);
    expect(grid.has(3, 1, 5, 'floor')).toBe(false);
  });

  it('allows one of each type in a cell', () => {
    expect(grid.add(makePiece('floor', 0, 0, 0))).not.toBeNull();
    expect(grid.add(makePiece('ramp', 0, 0, 0))).not.toBeNull();
    expect(grid.add(makePiece('pyramid', 0, 0, 0))).not.toBeNull();
    expect(grid.add(makePiece('wall', 0, 0, 0, EDGE.NORTH))).not.toBeNull();
    expect(grid.add(makePiece('wall', 0, 0, 0, EDGE.WEST))).not.toBeNull();
    expect(grid.getCell(0, 0, 0).length).toBe(5);
  });

  it('rejects duplicates of the same type', () => {
    grid.add(makePiece('floor', 0, 0, 0));
    expect(grid.add(makePiece('floor', 0, 0, 0))).toBeNull();
  });

  it('removes pieces and cleans up empty cells', () => {
    const f = grid.add(makePiece('floor', 2, 0, 2));
    expect(grid.cells.has(cellKey(2, 0, 2))).toBe(true);
    grid.remove(f);
    expect(grid.has(2, 0, 2, 'floor')).toBe(false);
    expect(grid.cells.has(cellKey(2, 0, 2))).toBe(false);
  });

  it('assigns unique incrementing ids', () => {
    const a = grid.add(makePiece('floor', 0, 0, 0));
    const b = grid.add(makePiece('floor', 1, 0, 0));
    expect(b.id).toBeGreaterThan(a.id);
  });
});

/* ------------------------------------------------------------------ */

describe('structural support relations', () => {
  let grid;
  beforeEach(() => { grid = new BuildGrid(); });

  it('a floor is supported by walls beneath it', () => {
    const wall = grid.add(makePiece('wall', 0, 0, 0, EDGE.NORTH));
    const floor = grid.add(makePiece('floor', 0, 1, 0));
    const supports = grid.getSupports(floor);
    expect(supports).toContain(wall);
  });

  it('a wall is supported by the wall below it', () => {
    const lower = grid.add(makePiece('wall', 0, 0, 0, EDGE.NORTH));
    const upper = grid.add(makePiece('wall', 0, 1, 0, EDGE.NORTH));
    expect(grid.getSupports(upper)).toContain(lower);
  });

  it('a ramp is supported by a floor in the same cell', () => {
    const floor = grid.add(makePiece('floor', 0, 0, 0));
    const ramp = grid.add(makePiece('ramp', 0, 0, 0));
    expect(grid.getSupports(ramp)).toContain(floor);
  });

  it('adjacent floors support each other', () => {
    const a = grid.add(makePiece('floor', 0, 2, 0));
    const b = grid.add(makePiece('floor', 1, 2, 0));
    expect(grid.getSupports(b)).toContain(a);
  });

  it('dependents are the inverse of supports', () => {
    const wall = grid.add(makePiece('wall', 0, 0, 0, EDGE.NORTH));
    const floor = grid.add(makePiece('floor', 0, 1, 0));
    expect(grid.getSupports(floor)).toContain(wall);
    expect(grid.getDependents(wall)).toContain(floor);
  });

  it('an isolated piece has no supports', () => {
    const lone = grid.add(makePiece('floor', 50, 9, 50));
    expect(grid.getSupports(lone).length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('material HP model', () => {
  it('matches OG Chapter 1 values', () => {
    expect(BUILD_MATERIALS.wood.initialHP).toBe(90);
    expect(BUILD_MATERIALS.wood.maxHP).toBe(200);
    expect(BUILD_MATERIALS.wood.buildUpTime).toBe(3.0);

    expect(BUILD_MATERIALS.brick.initialHP).toBe(100);
    expect(BUILD_MATERIALS.brick.maxHP).toBe(300);
    expect(BUILD_MATERIALS.brick.buildUpTime).toBe(5.0);

    expect(BUILD_MATERIALS.metal.initialHP).toBe(75);
    expect(BUILD_MATERIALS.metal.maxHP).toBe(400);
    expect(BUILD_MATERIALS.metal.buildUpTime).toBe(8.0);
  });

  it('costs 10 per piece for every material', () => {
    for (const m of Object.values(BUILD_MATERIALS)) expect(m.cost).toBe(10);
  });

  it('caps materials at 999', () => {
    expect(MAX_MATERIAL).toBe(999);
  });

  it('metal starts weakest but ends strongest', () => {
    expect(BUILD_MATERIALS.metal.initialHP).toBeLessThan(BUILD_MATERIALS.wood.initialHP);
    expect(BUILD_MATERIALS.metal.maxHP).toBeGreaterThan(BUILD_MATERIALS.brick.maxHP);
  });

  it('derives damage states at 75/50/25% thresholds', () => {
    expect(damageStateFor(1.0)).toBe(0);
    expect(damageStateFor(0.8)).toBe(0);
    expect(damageStateFor(0.7)).toBe(1);
    expect(damageStateFor(0.51)).toBe(1);
    expect(damageStateFor(0.4)).toBe(2);
    expect(damageStateFor(0.26)).toBe(2);
    expect(damageStateFor(0.2)).toBe(3);
    expect(damageStateFor(0)).toBe(3);
  });

  it('computes the HP build-up curve correctly', () => {
    const def = BUILD_MATERIALS.metal;
    const at = (t) => def.initialHP + (def.maxHP - def.initialHP) * Math.min(1, t / def.buildUpTime);
    expect(at(0)).toBe(75);
    expect(at(4)).toBeCloseTo(237.5);
    expect(at(8)).toBe(400);
    expect(at(20)).toBe(400);
  });
});

/* ------------------------------------------------------------------ */

describe('panel model and edit presets', () => {
  it('has the right panel counts per piece', () => {
    expect(panelCount('wall')).toBe(9);
    expect(panelCount('floor')).toBe(4);
    expect(panelCount('ramp')).toBe(4);
    expect(panelCount('pyramid')).toBe(4);
  });

  it('door preset removes the centre column bottom panels', () => {
    const door = WALL_EDITS.door;
    expect(door.length).toBe(9);
    expect(door[4]).toBe(0); // middle centre
    expect(door[7]).toBe(0); // bottom centre
    expect(door[0]).toBe(1); // top left intact
  });

  it('window preset removes only the centre panel', () => {
    const w = WALL_EDITS.window;
    expect(w[4]).toBe(0);
    expect(w.filter((p) => p === 0).length).toBe(1);
  });

  it('arch preset removes everything below the top row', () => {
    const a = WALL_EDITS.arch;
    expect(a.slice(0, 3)).toEqual([1, 1, 1]);
    expect(a.slice(3)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

/* ------------------------------------------------------------------ */

describe('radius queries', () => {
  it('finds pieces within a world radius', () => {
    const grid = new BuildGrid();
    for (let i = 0; i < 10; i++) {
      const p = makePiece('floor', i, 0, 0);
      const w = gridToWorld(i, 0, 0);
      p.worldX = w.x; p.worldY = w.y; p.worldZ = w.z;
      grid.add(p);
    }
    // Radius 6m from origin should catch the first few cells only.
    const near = grid.queryRadius(0, 0, 0, 6);
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThan(10);
    for (const p of near) {
      expect(Math.hypot(p.worldX, p.worldY, p.worldZ)).toBeLessThanOrEqual(6);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('build-up HP never heals damage', () => {
  it('preserves damage taken while a piece is still building up', async () => {
    const { Structure } = await import('../client/js/building/structures.js');
    const s = new Structure({
      type: 'wall', materialId: 'wood', gx: 0, gy: 0, gz: 0, edge: 0,
    });

    // Wood: 90 initial -> 200 max over 3s.
    expect(s.hp).toBe(BUILD_MATERIALS.wood.initialHP);

    // Half a second of build-up, then take 60 damage.
    s.update(0.5);
    const beforeDamage = s.hp;
    expect(beforeDamage).toBeGreaterThan(BUILD_MATERIALS.wood.initialHP);
    s.damage(60);
    const afterDamage = s.hp;
    expect(afterDamage).toBeCloseTo(beforeDamage - 60, 4);

    // Continue building. HP may rise (the piece is still curing) but must
    // never return to the undamaged curve.
    s.update(0.5);
    expect(s.hp).toBeLessThanOrEqual(s.currentMaxHP - 60 + 1e-6);
    expect(s.hp).toBeLessThan(BUILD_MATERIALS.wood.maxHP - 59);
  });

  it('destroys a piece damaged past zero during build-up', async () => {
    const { Structure } = await import('../client/js/building/structures.js');
    const s = new Structure({ type: 'wall', materialId: 'wood', gx: 0, gy: 0, gz: 0, edge: 0 });
    s.damage(BUILD_MATERIALS.wood.maxHP + 50);
    expect(s.destroyed).toBe(true);
  });

  it('a fully built piece is at max HP', async () => {
    const { Structure } = await import('../client/js/building/structures.js');
    const s = new Structure({ type: 'wall', materialId: 'brick', gx: 0, gy: 0, gz: 0, edge: 0 });
    for (let i = 0; i < 200; i++) s.update(0.05);
    expect(s.buildProgress).toBe(1);
    expect(s.hp).toBeCloseTo(BUILD_MATERIALS.brick.maxHP, 4);
  });
});
