/**
 * editor.js — Structure edit mode.
 *
 * Hold E while looking at your own structure: a grid of panel quads appears
 * on its face. Drag/click panels to mark them for removal. Release E to
 * confirm. The whole interaction must resolve in under 200ms from release,
 * which it does trivially because confirming is just a visibility mask write.
 *
 * The selection overlay is a set of thin quads positioned exactly on the
 * structure's panel centres, offset a few millimetres along the face normal.
 */

import * as THREE from 'three';
import { CELL_SIZE, WALL_HEIGHT, wallRotation } from './grid.js';
import { WALL_COLS, WALL_ROWS, FLOOR_COLS, FLOOR_ROWS } from './structures.js';
import audio from '../engine/audio.js';

const OVERLAY_OFFSET = 0.12;

/** Max distance at which a structure can be edited. */
export const EDIT_RANGE = 6.0;

export class StructureEditor {
  constructor(scene, builder) {
    this.scene = scene;
    this.builder = builder;

    this.active = false;
    this.target = null;        // Structure being edited
    this.selection = [];       // boolean per panel: true = mark for removal
    this.hoveredPanel = -1;

    this.group = new THREE.Group();
    this.group.name = 'EditOverlay';
    this.group.visible = false;
    this.group.renderOrder = 600;
    scene.add(this.group);

    this._quads = [];
    this._raycaster = new THREE.Raycaster();
    this._raycaster.far = EDIT_RANGE + 2;

    this._matIdle = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.18,
      depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this._matHover = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.42,
      depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this._matSelected = new THREE.MeshBasicMaterial({
      color: 0x4488ff, transparent: true, opacity: 0.62,
      depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this._matRemoved = new THREE.MeshBasicMaterial({
      color: 0x222222, transparent: true, opacity: 0.22,
      depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    });

    this.onEditComplete = null;
  }

  /* ---------------------------------------------------------------- */

  /**
   * Find an editable structure the player is looking at.
   * Only the structure's owner may edit it (Fortnite rule).
   */
  findTarget(camera, ownerId = 'player') {
    this._raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = this._raycaster.intersectObjects(this.builder.group.children, true);
    for (const hit of hits) {
      const s = hit.object.userData.structure || hit.object.parent?.userData?.structure;
      if (!s || s.destroyed) continue;
      if (s.ownerId !== ownerId) continue;
      if (hit.distance > EDIT_RANGE) continue;
      return { structure: s, distance: hit.distance };
    }
    return null;
  }

  /** Begin editing a structure. */
  begin(structure) {
    if (!structure || structure.destroyed) return false;
    this.active = true;
    this.target = structure;
    // Start from the structure's CURRENT panel state — editing an already
    // edited piece should not silently restore removed panels.
    this.selection = structure.panels.map((p) => !p);
    this.hoveredPanel = -1;
    this._buildOverlay();
    this.group.visible = true;
    audio.play('build.edit', { volume: 0.4, bus: 'ui' });
    return true;
  }

  /** Confirm the edit — apply the mask and exit. */
  confirm() {
    if (!this.active || !this.target) return null;
    const s = this.target;

    // selection[i] === true means "remove this panel".
    const mask = this.selection.map((sel) => !sel);
    const changed = mask.some((v, i) => v !== s.panels[i]);
    s.setPanels(mask);

    if (changed) {
      audio.play('build.edit', {
        position: { x: s.worldX, y: s.worldY, z: s.worldZ },
        volume: 0.55, rate: 1.15, refDistance: 4, maxDistance: 90,
      });
    }

    // A structure with every panel removed is destroyed outright.
    if (s.isFullyEdited) {
      this.builder.destroyStructure(s);
    }

    this.onEditComplete?.(s, mask);
    this.cancel();
    return s;
  }

  /** Abort without applying. */
  cancel() {
    this.active = false;
    this.target = null;
    this.hoveredPanel = -1;
    this.group.visible = false;
    this._clearOverlay();
  }

  /* ---------------------------------------------------------------- */
  /* Overlay construction                                              */
  /* ---------------------------------------------------------------- */

  _clearOverlay() {
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    this._quads.length = 0;
  }

  _buildOverlay() {
    this._clearOverlay();
    const s = this.target;

    if (s.type === 'wall') {
      const pw = CELL_SIZE / WALL_COLS;
      const ph = WALL_HEIGHT / WALL_ROWS;
      const geo = new THREE.PlaneGeometry(pw * 0.9, ph * 0.9);
      for (let row = 0; row < WALL_ROWS; row++) {
        for (let col = 0; col < WALL_COLS; col++) {
          const idx = row * WALL_COLS + col;
          const q = new THREE.Mesh(geo, this._matIdle);
          q.position.set((col - 1) * pw, (1 - row) * ph, OVERLAY_OFFSET);
          q.userData.panelIndex = idx;
          this.group.add(q);
          this._quads.push(q);
        }
      }
      this.group.position.set(s.worldX, s.worldY, s.worldZ);
      this.group.rotation.set(0, wallRotation(s.edge), 0);
    } else if (s.type === 'floor') {
      const pw = CELL_SIZE / FLOOR_COLS;
      const pd = CELL_SIZE / FLOOR_ROWS;
      const geo = new THREE.PlaneGeometry(pw * 0.9, pd * 0.9);
      geo.rotateX(-Math.PI / 2);
      for (let row = 0; row < FLOOR_ROWS; row++) {
        for (let col = 0; col < FLOOR_COLS; col++) {
          const idx = row * FLOOR_COLS + col;
          const q = new THREE.Mesh(geo, this._matIdle);
          q.position.set((col - 0.5) * pw, OVERLAY_OFFSET, (row - 0.5) * pd);
          q.userData.panelIndex = idx;
          this.group.add(q);
          this._quads.push(q);
        }
      }
      this.group.position.set(s.worldX, s.worldY, s.worldZ);
      this.group.rotation.set(0, 0, 0);
    } else if (s.type === 'ramp') {
      // Two step quads plus two rail quads.
      const geo = new THREE.PlaneGeometry(CELL_SIZE * 0.9, CELL_SIZE * 0.6);
      for (let i = 0; i < 2; i++) {
        const q = new THREE.Mesh(geo, this._matIdle);
        q.rotation.x = -Math.PI / 4;
        q.position.set(0, WALL_HEIGHT * (i + 0.5) / 2, -CELL_SIZE / 2 + (CELL_SIZE / 2) * (i + 0.5));
        q.userData.panelIndex = i;
        this.group.add(q);
        this._quads.push(q);
      }
      const railGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.8, WALL_HEIGHT * 0.5);
      for (let i = 0; i < 2; i++) {
        const q = new THREE.Mesh(railGeo, this._matIdle);
        q.rotation.y = Math.PI / 2;
        q.position.set((i === 0 ? -1 : 1) * (CELL_SIZE / 2), WALL_HEIGHT * 0.35, 0);
        q.userData.panelIndex = 2 + i;
        this.group.add(q);
        this._quads.push(q);
      }
      this.group.position.set(s.worldX, s.worldY - WALL_HEIGHT / 2, s.worldZ);
      this.group.rotation.set(0, wallRotation(s.edge), 0);
    } else if (s.type === 'pyramid') {
      const geo = new THREE.PlaneGeometry(CELL_SIZE * 0.7, WALL_HEIGHT * 0.5);
      for (let f = 0; f < 4; f++) {
        const q = new THREE.Mesh(geo, this._matIdle);
        const ang = (f * Math.PI) / 2;
        q.position.set(Math.sin(ang) * CELL_SIZE * 0.3, WALL_HEIGHT * 0.3, Math.cos(ang) * CELL_SIZE * 0.3);
        q.rotation.set(-0.6, ang, 0);
        q.userData.panelIndex = f;
        this.group.add(q);
        this._quads.push(q);
      }
      this.group.position.set(s.worldX, s.worldY - WALL_HEIGHT / 2, s.worldZ);
      this.group.rotation.set(0, 0, 0);
    }

    this._refreshQuadMaterials();
  }

  _refreshQuadMaterials() {
    for (const q of this._quads) {
      const i = q.userData.panelIndex;
      if (!this.target.panels[i] && !this.selection[i]) {
        // Panel already removed by a previous edit.
        q.material = this._matRemoved;
      } else if (this.selection[i]) {
        q.material = this._matSelected;
      } else if (i === this.hoveredPanel) {
        q.material = this._matHover;
      } else {
        q.material = this._matIdle;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Interaction                                                       */
  /* ---------------------------------------------------------------- */

  /** Raycast from screen centre onto the overlay to find the hovered panel. */
  updateHover(camera) {
    if (!this.active) return;
    this._raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = this._raycaster.intersectObjects(this._quads, false);
    const idx = hits.length ? hits[0].object.userData.panelIndex : -1;
    if (idx !== this.hoveredPanel) {
      this.hoveredPanel = idx;
      this._refreshQuadMaterials();
    }
  }

  /** Toggle the hovered panel's selection. */
  toggleHovered() {
    if (!this.active || this.hoveredPanel < 0) return false;
    const i = this.hoveredPanel;
    // Cannot re-add a panel that a previous edit already removed... actually
    // Fortnite DOES allow restoring, so we permit toggling both ways.
    this.selection[i] = !this.selection[i];
    this._refreshQuadMaterials();
    audio.play('build.rotate', { volume: 0.25, bus: 'ui', rate: this.selection[i] ? 1.2 : 0.85 });
    return true;
  }

  /** Apply a named preset (used by bots and quick-edit keybinds). */
  applyPreset(mask) {
    if (!this.active) return;
    this.selection = mask.map((v) => !v);
    this._refreshQuadMaterials();
  }

  /** Keep the overlay glued to the structure (structures never move, but
   *  the target can be destroyed mid-edit). */
  update(dt, camera) {
    if (!this.active) return;
    if (!this.target || this.target.destroyed) {
      this.cancel();
      return;
    }
    this.updateHover(camera);
  }

  dispose() {
    this._clearOverlay();
    this.scene.remove(this.group);
    this._matIdle.dispose();
    this._matHover.dispose();
    this._matSelected.dispose();
    this._matRemoved.dispose();
  }
}

export default StructureEditor;
